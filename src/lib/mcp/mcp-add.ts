/**
 * Adding MCP servers, from anywhere: the marketplace, a pasted URL, command or
 * JSON, a config found in another tool, or the agent's `manage_mcp_server`.
 *
 * WHERE A SERVER LIVES is decided here and nowhere else:
 *   - a public `https://` URL      → the ACCOUNT (`account_mcp_servers`): every
 *     surface gets it, the Chrome extension included;
 *   - a command, or a URL on this machine or a private network → this
 *     machine's SQLite `mcp_servers`, for the folder: the app, the CLI,
 *     VS Code and ACP share it; Chrome cannot start a program.
 *
 * THE LIMIT is 10 servers ON at once for a folder, counting the folder's own
 * and the account's. A server over the limit is still added, switched off,
 * and says so: nothing the user brought is thrown away.
 */
import { and, eq } from "drizzle-orm";
import log from "electron-log";
import { db } from "@/db";
import { mcpServers } from "@/db/schema";
import { MCP_WORKSPACE_MAX } from "@/lib/workspace-caps";
import { encryptEnvForDb, serializeApiKeyForDb } from "@/lib/security/db-secrets";
import {
  connectorNameFor,
  connectorSlugFor,
  displayTitle,
  isPublicHttpsUrl,
  missingInputs,
  normalizeRegistryServer,
  resolveInstall,
} from "@/shared/mcp-catalog";
import {
  beginConnectorSignIn,
  createConnector,
  enabledConnectorCount,
  listConnectorRows,
  setConnectorEnabled,
  setConnectorSecret,
  waitForConnectorCredential,
  type ConnectorAuthType,
} from "./account-connectors";
import { getMcpRegistryServer } from "./registry-catalog";
import { nameForCommand, nameForUrl, parsePasted, type PastedServer } from "./parse-pasted";
import { openUrlForUser } from "./open-for-user";

const logger = log.scope("mcp-add");

export const MCP_ON_LIMIT = MCP_WORKSPACE_MAX;

// ─── The limit ──────────────────────────────────────────────────────────────

async function localOnCount(appId: number): Promise<number> {
  const rows = await db
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(
      and(
        eq(mcpServers.scope, "workspace"),
        eq(mcpServers.appId, appId),
        eq(mcpServers.enabled, true as never),
      ),
    );
  return rows.length;
}

/** Servers on for this folder: its own plus the account's. */
export async function mcpOnCount(appId: number | null): Promise<number> {
  const [local, account] = await Promise.all([
    appId == null ? Promise.resolve(0) : localOnCount(appId),
    enabledConnectorCount(),
  ]);
  return local + account;
}

export function limitMessage(): string {
  return `${MCP_ON_LIMIT} MCP servers are already on. Turn one off to turn this one on.`;
}

/** Throws the limit message when turning one more on would pass it. */
export async function assertRoomForOneMore(appId: number | null): Promise<void> {
  if ((await mcpOnCount(appId)) >= MCP_ON_LIMIT) throw new Error(limitMessage());
}

// ─── Results ────────────────────────────────────────────────────────────────

export interface AddedServer {
  /** Where it was saved. */
  where: "account" | "local";
  /** Account connector id (uuid) or local row id. */
  id: string | number;
  name: string;
  enabled: boolean;
  /** It needs a browser sign-in before it works (`signInAdded`). */
  needsSignIn: boolean;
  /** It needs a key or header value the paste or install did not include. */
  needsSecret?: { header: string | null };
  /** One line to show, when something about it is worth saying. */
  note?: string;
}

// ─── Probing a URL ──────────────────────────────────────────────────────────

export type UrlAuth = "oauth" | "key" | "none";

/**
 * How a server at this URL expects to be signed in to: an unauthenticated
 * `initialize`, then the protected-resource and authorization-server metadata
 * (RFC 9728 / 8414), the same discovery the proxy does.
 */
export async function probeMcpUrl(url: string, timeoutMs = 15_000): Promise<{ auth: UrlAuth } | { error: string }> {
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "User-Agent": "Atlarix/1.0",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "Atlarix", version: "1" },
        },
      }),
      signal,
    });
  } catch {
    return { error: "Couldn't reach that address." };
  }
  void res.body?.cancel().catch(() => {});
  if (res.status !== 401 && res.status !== 403) {
    return res.ok || res.status === 202 || res.status === 405 || res.status === 400
      ? { auth: "none" }
      : { error: `That address answered ${res.status}.` };
  }
  const u = new URL(url);
  const challenge = res.headers.get("www-authenticate") ?? "";
  const metaUrl = /resource_metadata="([^"]+)"/i.exec(challenge)?.[1];
  const candidates = [
    metaUrl,
    `${u.origin}/.well-known/oauth-protected-resource${u.pathname === "/" ? "" : u.pathname}`,
    `${u.origin}/.well-known/oauth-protected-resource`,
    `${u.origin}/.well-known/oauth-authorization-server`,
  ].filter((x): x is string => !!x);
  for (const c of candidates) {
    try {
      const r = await fetch(c, { headers: { Accept: "application/json" }, signal });
      if (!r.ok) continue;
      const doc = (await r.json().catch(() => null)) as Record<string, unknown> | null;
      if (doc && (Array.isArray(doc.authorization_servers) || typeof doc.authorization_endpoint === "string")) {
        return { auth: "oauth" };
      }
    } catch {
      // Next candidate.
    }
  }
  return { auth: "key" };
}

// ─── Local (this machine) ───────────────────────────────────────────────────

async function uniqueLocalName(appId: number, base: string): Promise<string> {
  const rows = await db
    .select({ name: mcpServers.name })
    .from(mcpServers)
    .where(and(eq(mcpServers.scope, "workspace"), eq(mcpServers.appId, appId)));
  const taken = new Set(rows.map((r) => r.name.toLowerCase()));
  const clean = base.trim() || "server";
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let i = 2; ; i++) {
    const candidate = `${clean}-${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export interface LocalServerSpec {
  name: string;
  transport: "stdio" | "http";
  command?: string | null;
  args?: string[] | null;
  env?: Record<string, string> | null;
  url?: string | null;
  headers?: Record<string, string> | null;
  apiKey?: string | null;
  authType?: "none" | "env" | "api_key" | "oauth";
  registryId?: string | null;
}

export async function addLocalServer(
  appId: number,
  spec: LocalServerSpec,
  opts: { enable: boolean },
): Promise<AddedServer> {
  if (spec.transport === "stdio" && !spec.command?.trim()) throw new Error("A command is required.");
  if (spec.transport === "http" && !spec.url?.trim()) throw new Error("A URL is required.");
  const name = await uniqueLocalName(appId, spec.name);
  const env = spec.env && Object.keys(spec.env).length > 0 ? spec.env : null;
  const headers = spec.headers && Object.keys(spec.headers).length > 0 ? spec.headers : null;
  const apiKey = spec.apiKey?.trim() || null;
  const authType = spec.authType ?? (apiKey ? "api_key" : env ? "env" : "none");
  let enabled = opts.enable;
  let note: string | undefined;
  if (enabled && (await mcpOnCount(appId)) >= MCP_ON_LIMIT) {
    enabled = false;
    note = `Added switched off: ${MCP_ON_LIMIT} servers are already on.`;
  }
  const [row] = await db
    .insert(mcpServers)
    .values({
      name,
      transport: spec.transport,
      command: spec.transport === "stdio" ? spec.command!.trim() : null,
      args: spec.transport === "stdio" ? (spec.args ?? []) : null,
      envJson: encryptEnvForDb(env),
      url: spec.transport === "http" ? spec.url!.trim() : null,
      headersJson: encryptEnvForDb(headers),
      apiKey: apiKey ? serializeApiKeyForDb(apiKey) : null,
      enabled,
      scope: "workspace",
      appId,
      authType,
      fromRegistry: !!spec.registryId,
      registryId: spec.registryId ?? null,
    })
    .returning();
  if (!row) throw new Error("The server could not be saved.");
  return {
    where: "local",
    id: row.id,
    name,
    enabled,
    needsSignIn: authType === "oauth",
    ...(note ? { note } : {}),
  };
}

// ─── Account (every surface) ────────────────────────────────────────────────

export interface WebServerSpec {
  name: string;
  url: string;
  description?: string;
  registryName?: string | null;
  auth: "oauth" | "none" | "bearer" | "header";
  /** For `header`: the header's name. */
  headerName?: string | null;
  /** The key or header value, when there is one already. */
  secret?: string | null;
}

export async function addWebServer(
  appId: number | null,
  spec: WebServerSpec,
  opts: { enable: boolean },
): Promise<AddedServer> {
  const authType: ConnectorAuthType =
    spec.auth === "oauth" ? "oauth" : spec.auth === "header" ? "header" : spec.auth === "bearer" ? "api_key" : "none";
  const name = connectorNameFor(spec.name);
  const baseSlug = connectorSlugFor(name);
  let created: { id: string } | null = null;
  let usedName = name;
  let lastError = "The server could not be saved.";
  for (let i = 1; i <= 5 && !created; i++) {
    const suffix = i === 1 ? "" : `-${i}`;
    const slug = `${baseSlug.slice(0, 40 - suffix.length)}${suffix}`;
    usedName = i === 1 ? name : `${name.slice(0, 58 - suffix.length)}${suffix}`;
    const out = await createConnector({
      name: usedName,
      slug,
      url: spec.url.trim(),
      description: (spec.description ?? "").slice(0, 500),
      authType,
      authHeader: authType === "header" ? (spec.headerName ?? null) : null,
      registryName: spec.registryName ?? null,
    });
    if (out.ok) created = out.value;
    else {
      lastError = out.error;
      if (!/already have/.test(out.error)) break;
    }
  }
  if (!created) throw new Error(lastError);

  const secret = spec.secret?.trim();
  if (secret && (authType === "api_key" || authType === "header")) {
    const stored = await setConnectorSecret(created.id, secret);
    if (!stored.ok) throw new Error(stored.error);
  }
  const ready = authType === "none" || !!secret;
  let enabled = false;
  let note: string | undefined;
  if (opts.enable && ready) {
    if ((await mcpOnCount(appId)) >= MCP_ON_LIMIT) {
      note = `Added switched off: ${MCP_ON_LIMIT} servers are already on.`;
    } else {
      const on = await setConnectorEnabled(created.id, true);
      enabled = on.ok;
      if (!on.ok) note = on.error;
    }
  }
  return {
    where: "account",
    id: created.id,
    name: usedName,
    enabled,
    needsSignIn: authType === "oauth",
    ...(!ready && authType !== "oauth" ? { needsSecret: { header: spec.headerName ?? null } } : {}),
    ...(note ? { note } : {}),
  };
}

/**
 * Sign in to an account server in the browser and wait for it to land, then
 * switch it on (room permitting). `onUrl` gets the page too, for surfaces that
 * print it.
 */
export async function signInAccountServer(
  id: string,
  appId: number | null,
  opts: { enable?: boolean; onUrl?: (url: string) => void; timeoutMs?: number } = {},
): Promise<{ ok: boolean; enabled: boolean; error?: string }> {
  const begun = await beginConnectorSignIn(id);
  if (!begun.ok) return { ok: false, enabled: false, error: begun.error };
  opts.onUrl?.(begun.value.url);
  await openUrlForUser(begun.value.url).catch((e) => logger.warn("open sign-in page", e));
  const landed = await waitForConnectorCredential(id, { timeoutMs: opts.timeoutMs });
  if (!landed) return { ok: false, enabled: false, error: "Sign-in didn't finish." };
  if (opts.enable === false) return { ok: true, enabled: false };
  const row = (await listConnectorRows())?.find((r) => r.id === id);
  if (row?.enabled) return { ok: true, enabled: true };
  if ((await mcpOnCount(appId)) >= MCP_ON_LIMIT) {
    return { ok: true, enabled: false, error: limitMessage() };
  }
  const on = await setConnectorEnabled(id, true);
  return on.ok ? { ok: true, enabled: true } : { ok: true, enabled: false, error: on.error };
}

// ─── From a URL, a command, a paste ─────────────────────────────────────────

export interface UrlServerInput {
  url: string;
  name?: string;
  description?: string;
  headers?: Record<string, string>;
  bearer?: string;
  registryName?: string | null;
}

/** Is there a signed-in account to put a web server on? */
async function accountAvailable(): Promise<boolean> {
  return (await listConnectorRows()) !== null;
}

export async function addServerFromUrl(
  appId: number,
  input: UrlServerInput,
  opts: { enable: boolean },
): Promise<AddedServer> {
  const url = input.url.trim();
  const name = input.name?.trim() || nameForUrl(url);
  const headers = { ...(input.headers ?? {}) };
  // `Authorization: Bearer x` in a header map is a bearer like any other.
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "authorization" && /^Bearer\s+/i.test(headers[k]!)) {
      input = { ...input, bearer: input.bearer ?? headers[k]!.replace(/^Bearer\s+/i, "") };
      delete headers[k];
    }
  }
  const headerNames = Object.keys(headers);
  // The account holds ONE secret per server: a bearer, or one named header.
  const fitsAccount = headerNames.length === 0 || (headerNames.length === 1 && !input.bearer);
  const signedIn = await accountAvailable();
  if (isPublicHttpsUrl(url) && fitsAccount && signedIn) {
    let auth: WebServerSpec["auth"];
    let headerName: string | null = null;
    let secret: string | null = null;
    if (input.bearer) {
      auth = "bearer";
      secret = input.bearer;
    } else if (headerNames.length === 1) {
      auth = "header";
      headerName = headerNames[0]!;
      secret = headers[headerName]!;
    } else {
      const probe = await probeMcpUrl(url);
      auth = "error" in probe ? "none" : probe.auth === "oauth" ? "oauth" : probe.auth === "key" ? "bearer" : "none";
    }
    return addWebServer(
      appId,
      {
        name,
        url,
        description: input.description,
        registryName: input.registryName ?? null,
        auth,
        headerName,
        secret,
      },
      opts,
    );
  }
  // This machine: a private address, more headers than the account can hold,
  // or nobody signed in.
  let authType: LocalServerSpec["authType"] = input.bearer ? "api_key" : "none";
  if (!input.bearer && headerNames.length === 0) {
    const probe = await probeMcpUrl(url);
    if (!("error" in probe) && probe.auth === "oauth") authType = "oauth";
  }
  const added = await addLocalServer(
    appId,
    {
      name,
      transport: "http",
      url,
      headers,
      apiKey: input.bearer ?? null,
      authType,
      registryId: input.registryName ?? null,
    },
    opts,
  );
  // A web server that would have gone on the account: say why it didn't.
  if (isPublicHttpsUrl(url) && !signedIn) {
    const why = "Saved on this computer only: sign in to Atlarix to share it with your other devices.";
    return { ...added, note: added.note ? `${added.note} ${why}` : why };
  }
  return added;
}

function fromPasted(s: PastedServer): { kind: "url"; input: UrlServerInput } | { kind: "local"; spec: LocalServerSpec } {
  if (s.transport === "http") {
    return { kind: "url", input: { url: s.url, name: s.name, headers: s.headers, ...(s.bearer ? { bearer: s.bearer } : {}) } };
  }
  return { kind: "local", spec: { name: s.name, transport: "stdio", command: s.command, args: s.args, env: s.env } };
}

export interface PasteOutcome {
  added: AddedServer[];
  failed: Array<{ name: string; error: string }>;
  skipped: Array<{ name: string; reason: string }>;
}

/** Add everything in a paste: a URL, a command line, or a config block. */
export async function addPasted(appId: number, text: string, opts: { name?: string } = {}): Promise<PasteOutcome> {
  const parsed = parsePasted(text);
  if (parsed.kind === "empty") throw new Error("Paste a URL, a command, or a config.");
  if (parsed.kind === "invalid") throw new Error(parsed.error);
  const out: PasteOutcome = { added: [], failed: [], skipped: [] };
  const jobs: Array<{ name: string; run: () => Promise<AddedServer> }> = [];
  if (parsed.kind === "url") {
    jobs.push({
      name: opts.name ?? nameForUrl(parsed.url),
      run: () => addServerFromUrl(appId, { url: parsed.url, ...(opts.name ? { name: opts.name } : {}) }, { enable: true }),
    });
  } else if (parsed.kind === "command") {
    const name = opts.name ?? nameForCommand(parsed.command, parsed.args);
    jobs.push({
      name,
      run: () =>
        addLocalServer(appId, { name, transport: "stdio", command: parsed.command, args: parsed.args }, { enable: true }),
    });
  } else {
    out.skipped.push(...parsed.skipped);
    for (const s of parsed.servers) {
      const r = fromPasted(s);
      jobs.push({
        name: s.name,
        run: () =>
          r.kind === "url" ? addServerFromUrl(appId, r.input, { enable: true }) : addLocalServer(appId, r.spec, { enable: true }),
      });
    }
  }
  // One at a time: each add counts what is already on.
  for (const j of jobs) {
    try {
      out.added.push(await j.run());
    } catch (e) {
      out.failed.push({ name: j.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

// ─── From the marketplace ───────────────────────────────────────────────────

export async function installFromCatalog(
  appId: number,
  params: { name: string; optionId: string; values: Record<string, string> },
): Promise<AddedServer> {
  const server = await getMcpRegistryServer(params.name);
  if (!server) throw new Error("That server is no longer in the marketplace.");
  const entry = normalizeRegistryServer(server);
  const option = entry.options.find((o) => o.id === params.optionId);
  if (!option) throw new Error("That way of adding it is no longer available.");
  if (option.kind === "local" && !option.supported) {
    throw new Error(`Atlarix cannot start ${option.registryType} servers yet.`);
  }
  const missing = missingInputs(option, params.values);
  if (missing.length > 0) throw new Error(`Fill in: ${missing.join(", ")}.`);
  const resolved = resolveInstall(server, params.optionId, params.values);
  const title = displayTitle(server);
  if (resolved.transport === "http") {
    return addServerFromUrl(
      appId,
      {
        url: resolved.url,
        name: title,
        description: entry.description,
        headers: resolved.headers,
        registryName: server.name,
      },
      { enable: true },
    );
  }
  return addLocalServer(
    appId,
    {
      name: title,
      transport: "stdio",
      command: resolved.command,
      args: resolved.args,
      env: resolved.env,
      registryId: server.name,
    },
    { enable: true },
  );
}
