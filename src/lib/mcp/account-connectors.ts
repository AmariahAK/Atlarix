/**
 * Connectors the user set up on atlarix.dev, reachable from the desktop.
 *
 * The account page calls these "Connectors"; they are MCP servers, stored in
 * `account_mcp_servers`, and its own blurb already tells users one added there
 * is "available in the app, the browser extension and the CLI". Only two of
 * those were true. This is the third.
 *
 * ══ THROUGH THE PROXY, NEVER POSTGREST ══
 *
 * The reason is the credential. A connector's credential lives in
 * `private.mcp_credentials` and is held by the proxy — which must have EXACTLY
 * ONE HOLDER. A second holder is a second place a token can leak from and a
 * second implementation of refresh. The desktop therefore never sees a
 * connector's credential and never could: it asks the proxy to make the call.
 *
 * ══ TWO CALLS, NOT THREE ══
 *
 * The extension shipped `list` and `call` and deliberately not the desktop's
 * `manage_mcp_server`, on the grounds that adding a WRITE tool to a surface
 * that reads attacker-controlled web pages is the opposite of what the design
 * is for. The same restraint applies here for a different reason: these
 * connectors are configured on the website, that is where their UI is, and a
 * second way to edit them is a second set of validation rules to keep in step.
 * `manage_mcp_server` stays pointed at the local SQLite servers only.
 *
 * ══ THE TWO MODELS DO NOT MERGE, AND MUST NOT ══
 *
 * The desktop's own `mcp_servers` table supports `stdio` with a command, args
 * and an environment; `account_mcp_servers` is HTTPS-only by CHECK constraint
 * with its credentials elsewhere. Forcing one shape onto the other makes every
 * column nullable and every rule conditional. They travel side by side and are
 * told apart by `scope`.
 */

import log from "electron-log";

import { getSession, getSupabaseClient } from "@/lib/auth/supabase-client";
import { surfaceHeaders, getCoreProxyBaseUrl } from "@/ipc/shared/core_proxy";

const logger = log.scope("account-connectors");

export interface AccountConnectorTool {
  name: string;
  description?: string;
}

export interface AccountConnector {
  name: string;
  description?: string;
  tools: AccountConnectorTool[];
  /** The server said why it could not be listed. Shown, never swallowed. */
  error?: string;
  /** Set up but never authorised — the user finishes that on the website. */
  needsOAuth?: boolean;
  /** Configured and switched off. */
  inactive?: boolean;
}

/** Same shape the extension gets back, because it is the same endpoint. */
interface ListResponse {
  ok?: boolean;
  error?: string;
  servers?: AccountConnector[];
}

interface CallResponse {
  ok?: boolean;
  error?: string;
  result?: unknown;
}

/**
 * POST to the proxy as the signed-in user.
 *
 * `X-Atlarix-Surface` is not decoration: one subscription funds four surfaces,
 * and a row that does not say which one spent collapses the account page into a
 * single undifferentiated line. A ledger row cannot be re-attributed later, so
 * the header has to be right the first time.
 *
 * Returns null rather than throwing on every failure the user can do nothing
 * about — signed out, no proxy configured, network down. The caller turns that
 * into "no connectors", which is the honest answer and is also what a user with
 * none would see.
 */
async function proxyPost<T>(path: string, payload: unknown): Promise<T | null> {
  const base = getCoreProxyBaseUrl();
  if (!base) return null;

  const session = await getSession();
  const token = session?.access_token;
  if (!token || token === "atlarix-headless") return null;

  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...surfaceHeaders(),
      },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) {
      logger.warn(`[account-connectors] ${path} → ${res.status}: ${body?.error ?? ""}`);
      return null;
    }
    return body;
  } catch (err) {
    logger.warn(`[account-connectors] ${path} threw:`, err);
    return null;
  }
}

/**
 * KEPT UNTIL SOMETHING SAYS IT CHANGED, never on a timer.
 *
 * A new user's app read `account_mcp_servers` 48 times in 70 minutes, every
 * answer the same empty list (owner, 2026-10-20): the composer's MCP menu asked
 * once per default server per render, and every other caller asked again. The
 * list changes when the user adds, removes or toggles a server — here, through
 * the writes below, which clear this — or on the website, which they reach by
 * leaving the app. So it is read again on sign-in, on window focus (main.ts),
 * when a CLI/ACP session starts (AgentSession), and after this client's own
 * writes. An empty list is an answer and is kept like any other.
 *
 * Keyed by the account, so a different sign-in never sees the last one's rows.
 * A failed read (null) is NOT kept: signed out or offline is not "none".
 */
let rowsCache: { user: string; rows: ConnectorView[] } | null = null;
let rowsInFlight: { user: string; p: Promise<ConnectorView[] | null> } | null = null;
let cache: { user: string; servers: AccountConnector[] } | null = null;
/** Bumped by every clear, so a read that started before one is not kept after it. */
let generation = 0;

export function clearAccountConnectorsCache(): void {
  generation++;
  rowsCache = null;
  rowsInFlight = null;
  cache = null;
}

/** Who is signed in, for the cache key; null when there is no real session. */
async function accountKey(): Promise<string | null> {
  const session = await getSession();
  const token = session?.access_token;
  if (!token || token === "atlarix-headless") return null;
  return session?.user?.id ?? "";
}

/**
 * The user's account connectors and the tools each exposes.
 *
 * A server that failed to list is RETURNED WITH ITS ERROR rather than dropped.
 * Dropping it tells the model the connector does not exist, so it plans around
 * an absence instead of reporting a failure the user could go and fix.
 *
 * No rows on the account means nothing to ask the proxy about: the proxy would
 * read the same table to say so.
 */
export async function listAccountConnectors(): Promise<AccountConnector[]> {
  const user = await accountKey();
  if (user === null) return [];
  if (cache?.user === user) return cache.servers;
  const gen = generation;

  const rows = await listConnectorRows();
  if (rows && rows.length === 0) {
    if (gen === generation) cache = { user, servers: [] };
    return [];
  }

  const body = await proxyPost<ListResponse>("/mcp/list", {});
  if (!body) return [];
  const servers = body.ok && Array.isArray(body.servers) ? body.servers : [];
  if (gen === generation) cache = { user, servers };
  return servers;
}

/**
 * Invoke a tool on an account connector, resolved BY NAME.
 *
 * The name is what the model was given and `account_mcp_servers` has a
 * `UNIQUE (user_id, slug)` index behind it, so this is not ambiguous on the
 * server. It can collide with a LOCAL server of the same name, which is
 * resolved by the caller — see `mcp.ts`.
 *
 * The proxy already wraps the result. This must not re-wrap it and must not
 * strip it: doing either would either double the envelope the model reads or
 * remove the marking that says the content is untrusted.
 */
export async function callAccountConnector(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const body = await proxyPost<CallResponse>("/mcp/call", {
    server,
    tool,
    arguments: args,
  });
  if (!body) {
    return {
      ok: false,
      error:
        "Could not reach Atlarix Core to run that connector. It is configured on " +
        "your account rather than on this machine, so it needs the network and a " +
        "signed-in session.",
    };
  }
  if (!body.ok) {
    return { ok: false, error: body.error ?? "The connector reported a failure." };
  }
  return { ok: true, result: body.result };
}

/* ══ Writes ══════════════════════════════════════════════════════════════════
 *
 * Web MCP servers (a public https URL) live on the account from EVERY surface
 * now, not only from the website, so the app, the CLI, VS Code, ACP and the
 * Chrome extension all see the same ones. Rows are written through the same
 * RPCs the website uses (RLS: select-own only; every write is an RPC); the
 * credential still goes to the proxy and nowhere else, and the desktop still
 * never reads one back.
 */

export type ConnectorAuthType = "none" | "oauth" | "api_key" | "header";

/** A connector as the settings screens show it. Never carries a credential. */
export interface ConnectorView {
  id: string;
  name: string;
  slug: string;
  description: string;
  url: string;
  authType: ConnectorAuthType;
  authHeader: string | null;
  registryName: string | null;
  enabled: boolean;
  /** A credential is stored (OAuth tokens or a key). */
  connected: boolean;
  lastError: string | null;
  tools: string[];
}

export type WriteResult<T> = { ok: true; value: T } | { ok: false; error: string };

const WRITE_MESSAGES: Record<string, string> = {
  not_authenticated: "Sign in to Atlarix to add servers to your account.",
  not_found: "That server is no longer on your account.",
  duplicate_slug: "You already have a server with that name.",
  missing_slug: "Give it a name first.",
  rejected: "That address or name can't be used for an account server.",
};

function writeMessage(code: unknown): string {
  return (typeof code === "string" && WRITE_MESSAGES[code]) || "Something went wrong. Try again in a moment.";
}

async function signedIn(): Promise<boolean> {
  return (await accountKey()) !== null;
}

async function rpc(fn: string, input: Record<string, unknown>): Promise<WriteResult<Record<string, unknown>>> {
  if (!(await signedIn())) return { ok: false, error: WRITE_MESSAGES.not_authenticated! };
  try {
    const { data, error } = await getSupabaseClient().rpc(fn, { p_input: input } as never);
    if (error) {
      logger.warn(`[account-connectors] ${fn}: ${error.message}`);
      return { ok: false, error: writeMessage(null) };
    }
    const row = data as { ok?: boolean; error?: string } | null;
    if (!row || row.ok === false) return { ok: false, error: writeMessage(row?.error) };
    return { ok: true, value: row as Record<string, unknown> };
  } finally {
    clearAccountConnectorsCache();
  }
}

/** The proxy's connector routes answer 200 with `{ok:false,error}` for expected failures. */
async function proxyWrite(path: string, payload: unknown): Promise<WriteResult<Record<string, unknown>>> {
  const base = getCoreProxyBaseUrl();
  const session = await getSession();
  const token = session?.access_token;
  if (!base || !token || token === "atlarix-headless") {
    return { ok: false, error: WRITE_MESSAGES.not_authenticated! };
  }
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...surfaceHeaders(),
      },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || body.ok === false) {
      const e = body.error;
      return { ok: false, error: typeof e === "string" && !/^[a-z_]+$/.test(e) ? e : writeMessage(e) };
    }
    return { ok: true, value: body };
  } catch (err) {
    logger.warn(`[account-connectors] ${path} threw:`, err);
    return { ok: false, error: "Could not reach Atlarix. Check your connection and try again." };
  } finally {
    clearAccountConnectorsCache();
  }
}

const BASE_COLUMNS =
  "id, name, slug, description, url, auth_type, enabled, credential_set_at, last_error, tools_cache";
/** Added by migration 20261014120000; a database without it still lists. */
const ROW_COLUMNS = `${BASE_COLUMNS}, auth_header, registry_name`;

interface ConnectorDbRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  url: string;
  auth_type: ConnectorAuthType;
  auth_header: string | null;
  registry_name: string | null;
  enabled: boolean;
  credential_set_at: string | null;
  last_error: string | null;
  tools_cache: Array<{ name?: string }> | null;
}

/**
 * The account's connectors as rows, or null when signed out or unreachable.
 * One read shared by every caller until the cache is cleared (see above).
 */
export async function listConnectorRows(): Promise<ConnectorView[] | null> {
  const user = await accountKey();
  if (user === null) return null;
  if (rowsCache?.user === user) return rowsCache.rows;
  if (rowsInFlight?.user === user) return rowsInFlight.p;
  const gen = generation;
  const p = readConnectorRows()
    .then((rows) => {
      if (rows && gen === generation) rowsCache = { user, rows };
      return rows;
    })
    .finally(() => {
      if (rowsInFlight?.p === p) rowsInFlight = null;
    });
  rowsInFlight = { user, p };
  return p;
}

async function readConnectorRows(): Promise<ConnectorView[] | null> {
  try {
    const read = (columns: string) =>
      getSupabaseClient().from("account_mcp_servers").select(columns).order("created_at", { ascending: true });
    let { data, error } = await read(ROW_COLUMNS);
    // An older database (the migration not applied yet): the same rows, without
    // the two newer columns, rather than looking signed out.
    if (error && /column|auth_header|registry_name/i.test(error.message ?? "")) {
      ({ data, error } = await read(BASE_COLUMNS));
    }
    if (error || !Array.isArray(data)) return null;
    return (data as unknown as ConnectorDbRow[]).map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      description: r.description ?? "",
      url: r.url,
      authType: r.auth_type,
      authHeader: r.auth_header ?? null,
      registryName: r.registry_name ?? null,
      enabled: r.enabled,
      connected: r.auth_type === "none" || !!r.credential_set_at,
      lastError: r.last_error,
      tools: (r.tools_cache ?? []).map((t) => t?.name).filter((n): n is string => !!n),
    }));
  } catch (e) {
    logger.warn("[account-connectors] list rows failed", e);
    return null;
  }
}

/** How many of the account's connectors are on. 0 when signed out or unreachable. */
export async function enabledConnectorCount(): Promise<number> {
  const rows = await listConnectorRows();
  return rows ? rows.filter((r) => r.enabled).length : 0;
}

export interface NewConnector {
  name: string;
  slug: string;
  url: string;
  description?: string;
  authType: ConnectorAuthType;
  authHeader?: string | null;
  registryName?: string | null;
}

export async function createConnector(input: NewConnector): Promise<WriteResult<{ id: string }>> {
  const out = await rpc("upsert_account_mcp_server", {
    id: null,
    name: input.name,
    slug: input.slug,
    description: input.description ?? "",
    url: input.url,
    auth_type: input.authType,
    auth_header: input.authHeader ?? null,
    registry_name: input.registryName ?? null,
  });
  if (!out.ok) return out;
  const id = out.value.id;
  return typeof id === "string" ? { ok: true, value: { id } } : { ok: false, error: writeMessage(null) };
}

/** Rename or re-point a connector. A new URL clears its credential and turns it off. */
export async function updateConnector(
  id: string,
  patch: { name?: string; url?: string },
): Promise<WriteResult<true>> {
  const out = await rpc("upsert_account_mcp_server", {
    id,
    ...(patch.name ? { name: patch.name } : {}),
    ...(patch.url ? { url: patch.url } : {}),
  });
  return out.ok ? { ok: true, value: true } : out;
}

export async function setConnectorEnabled(id: string, enabled: boolean): Promise<WriteResult<true>> {
  const out = await rpc("set_account_mcp_server_enabled", { id, enabled });
  return out.ok ? { ok: true, value: true } : out;
}

export async function deleteConnector(id: string): Promise<WriteResult<true>> {
  const out = await rpc("delete_account_mcp_server", { id });
  return out.ok ? { ok: true, value: true } : out;
}

/** Store a key or header value. The proxy keeps it; nothing here can read it back. */
export async function setConnectorSecret(id: string, secret: string): Promise<WriteResult<true>> {
  const out = await proxyWrite(`/connectors/${encodeURIComponent(id)}/credential`, { api_key: secret });
  return out.ok ? { ok: true, value: true } : out;
}

/** Begin a sign-in. The page it ends on says to go back to Atlarix. */
export async function beginConnectorSignIn(id: string): Promise<WriteResult<{ url: string }>> {
  const out = await proxyWrite(`/connectors/${encodeURIComponent(id)}/authorize`, { return: "app" });
  if (!out.ok) return out;
  const url = out.value.authorization_url;
  return typeof url === "string" && /^https:\/\//i.test(url)
    ? { ok: true, value: { url } }
    : { ok: false, error: "That server did not say how to sign in to it." };
}

/**
 * Wait for a sign-in begun in the browser to land: the proxy stores the
 * credential and the row's `credential_set_at` changes. Polls, because the
 * callback goes to the proxy, not to this process.
 */
export async function waitForConnectorCredential(
  id: string,
  opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<boolean> {
  const timeout = opts.timeoutMs ?? 5 * 60 * 1000;
  const interval = opts.intervalMs ?? 2000;
  const started = Date.now();
  const initial = await credentialStamp(id);
  while (Date.now() - started < timeout) {
    if (opts.signal?.aborted) return false;
    await new Promise((r) => setTimeout(r, interval));
    const stamp = await credentialStamp(id);
    if (stamp && stamp !== initial) {
      clearAccountConnectorsCache();
      return true;
    }
  }
  return false;
}

async function credentialStamp(id: string): Promise<string | null> {
  try {
    const { data } = await getSupabaseClient()
      .from("account_mcp_servers")
      .select("credential_set_at")
      .eq("id", id)
      .maybeSingle();
    return (data as { credential_set_at?: string | null } | null)?.credential_set_at ?? null;
  } catch {
    return null;
  }
}
