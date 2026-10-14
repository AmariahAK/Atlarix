/**
 * The MCP marketplace catalog: the official MCP Registry
 * (registry.modelcontextprotocol.io), normalised for Atlarix.
 *
 * The registry is a METAregistry: it says "this server is npm package X" or
 * "this server is at URL Y", and npm, PyPI, Docker or the vendor host the
 * code. This module is pure (no Node, no Electron), so the main process, the
 * renderer and the CLI all share it. The sync and the disk cache are in
 * `src/lib/mcp/registry-catalog.ts`.
 *
 * Two kinds of server, and where each one lives:
 *   - WEB: a public `https://` URL. Stored on the user's account
 *     (`account_mcp_servers`, with the credential held by the proxy), so it
 *     reaches every surface: app, CLI, VS Code, ACP and the Chrome extension.
 *   - LOCAL: a command, or a URL on this machine or network. Stored in the
 *     desktop's SQLite `mcp_servers`, shared by app, CLI, VS Code and ACP.
 *     Never Chrome: a browser cannot start a program.
 */

export const MCP_REGISTRY_BASE_URL = "https://registry.modelcontextprotocol.io";

// ─── Registry wire shapes (the subset we read) ──────────────────────────────

export interface RegistryInput {
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
  placeholder?: string;
  choices?: string[];
  value?: string;
  format?: string;
}

export interface RegistryKeyValueInput extends RegistryInput {
  name: string;
  variables?: Record<string, RegistryInput>;
}

export interface RegistryArgument extends RegistryInput {
  type: "positional" | "named";
  name?: string;
  valueHint?: string;
  isRepeated?: boolean;
  variables?: Record<string, RegistryInput>;
}

export interface RegistryTransport {
  type: string;
  url?: string;
  headers?: RegistryKeyValueInput[];
  variables?: Record<string, RegistryInput>;
}

export interface RegistryPackage {
  registryType: string;
  identifier: string;
  version?: string;
  runtimeHint?: string;
  transport?: RegistryTransport;
  runtimeArguments?: RegistryArgument[];
  packageArguments?: RegistryArgument[];
  environmentVariables?: RegistryKeyValueInput[];
}

export interface RegistryIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: string;
}

export interface RegistryServer {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  websiteUrl?: string;
  repository?: { url?: string; source?: string };
  icons?: RegistryIcon[];
  packages?: RegistryPackage[];
  remotes?: RegistryTransport[];
}

/** One server as the cache keeps it: the latest version plus its registry status. */
export interface RegistryRecord {
  server: RegistryServer;
  status: string;
  updatedAt?: string;
}

// ─── Verified ───────────────────────────────────────────────────────────────

/**
 * The base set. Each one is the vendor's OWN server, published under the
 * vendor's namespace, and accepts Atlarix's sign-in (open client
 * registration). `fallback` lets the five show before the first sync and keeps
 * them working if the registry ever drops an entry.
 */
export const VERIFIED_MCP_SERVERS: ReadonlyArray<{
  name: string;
  fallback: RegistryServer;
}> = [
  {
    name: "io.github.getsentry/sentry-mcp",
    fallback: {
      name: "io.github.getsentry/sentry-mcp",
      title: "Sentry",
      description: "Errors, issues and performance data from Sentry.",
      websiteUrl: "https://sentry.io",
      remotes: [{ type: "streamable-http", url: "https://mcp.sentry.dev/mcp" }],
    },
  },
  {
    name: "com.notion/mcp",
    fallback: {
      name: "com.notion/mcp",
      title: "Notion",
      description: "Search, read and edit your Notion pages and databases.",
      websiteUrl: "https://www.notion.com",
      remotes: [{ type: "streamable-http", url: "https://mcp.notion.com/mcp" }],
    },
  },
  {
    name: "com.supabase/mcp",
    fallback: {
      name: "com.supabase/mcp",
      title: "Supabase",
      description: "Manage your Supabase projects, databases and functions.",
      websiteUrl: "https://supabase.com",
      remotes: [{ type: "streamable-http", url: "https://mcp.supabase.com/mcp" }],
    },
  },
  {
    name: "com.canva.mcp/mcp",
    fallback: {
      name: "com.canva.mcp/mcp",
      title: "Canva",
      description: "Create, find and edit Canva designs.",
      websiteUrl: "https://www.canva.com",
      remotes: [{ type: "streamable-http", url: "https://mcp.canva.com/mcp" }],
    },
  },
  {
    name: "app.linear/linear",
    fallback: {
      name: "app.linear/linear",
      title: "Linear",
      description: "Find, create and update Linear issues and projects.",
      websiteUrl: "https://linear.app",
      remotes: [{ type: "streamable-http", url: "https://mcp.linear.app/mcp" }],
    },
  },
];

const VERIFIED_ORDER = new Map(
  VERIFIED_MCP_SERVERS.map((v, i) => [v.name, i] as const),
);

export function isVerifiedMcp(name: string): boolean {
  return VERIFIED_ORDER.has(name);
}

// ─── Normalised entries ─────────────────────────────────────────────────────

/** A value the user fills in before installing. */
export interface CatalogInput {
  /** `env:NAME`, `header:NAME`, `arg:<i>` or `var:<name>`. Stable within an option. */
  key: string;
  label: string;
  description?: string;
  secret: boolean;
  required: boolean;
  default?: string;
  placeholder?: string;
  choices?: string[];
}

export type CatalogOption =
  | {
      id: string;
      kind: "web";
      /** The URL as the registry gives it; `{var}` parts are filled from inputs. */
      url: string;
      inputs: CatalogInput[];
    }
  | {
      id: string;
      kind: "local";
      registryType: string;
      identifier: string;
      version?: string;
      /** False for a package type Atlarix cannot start yet (mcpb, nuget, …). */
      supported: boolean;
      inputs: CatalogInput[];
    };

export interface CatalogEntry {
  /** Registry name: a reverse-DNS namespace plus a server name. */
  name: string;
  title: string;
  description: string;
  /** Who published it: the namespace part of `name`, e.g. `io.github.someone`. */
  publisher: string;
  version?: string;
  websiteUrl?: string;
  repositoryUrl?: string;
  icons: RegistryIcon[];
  verified: boolean;
  /** `web` when it can be reached by URL, otherwise `local`. */
  kind: "web" | "local";
  /** Web options first, then local packages. Empty when none is usable. */
  options: CatalogOption[];
  /** At least one option can be installed. */
  installable: boolean;
}

/** Package types Atlarix knows how to start, and the runner each one uses. */
const LOCAL_RUNNERS: Record<string, string> = {
  npm: "npx",
  pypi: "uvx",
  oci: "docker",
};

/** Server names that say nothing on their own (`com.notion/mcp`). */
const GENERIC_SERVER_NAMES = new Set(["mcp", "server", "mcp-server", "mcpserver", "remote", "api"]);

/** The owner part of a namespace: `com.notion` → `notion`, `io.github.acme` → `acme`. */
function namespaceOwner(name: string): string {
  const ns = (name.split("/")[0] ?? name).split(".");
  if (ns[0] === "io" && ns[1] === "github") return ns[2] ?? "";
  // `com.canva.mcp` is Canva's: a generic last part is not the owner (QA).
  const named = ns.slice(1).filter((p) => !GENERIC_SERVER_NAMES.has(p.toLowerCase()));
  return named[named.length - 1] ?? ns[ns.length - 1] ?? "";
}

function titleFromName(name: string): string {
  const last = name.split("/").pop() ?? name;
  const base = GENERIC_SERVER_NAMES.has(last.toLowerCase()) ? namespaceOwner(name) || last : last;
  const words = base.replace(/[-_.]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

/**
 * An input is labelled by its own name (`BRAVE_API_KEY`), which is what the
 * server's docs call it; the registry's description ("Your API key for the
 * service") goes beside it as the explanation (QA).
 */
function inputLabel(name: string, _description?: string): string {
  return name;
}

/** `{var}` placeholders in a string. */
function templateVars(s: string | undefined): string[] {
  if (!s) return [];
  return [...s.matchAll(/\{([A-Za-z0-9_.-]+)\}/g)].map((m) => m[1]!);
}

function varInputs(
  vars: Record<string, RegistryInput> | undefined,
  used: string[],
): CatalogInput[] {
  const out: CatalogInput[] = [];
  for (const v of used) {
    const def = vars?.[v];
    out.push({
      key: `var:${v}`,
      label: inputLabel(v, def?.description),
      description: def?.description,
      secret: !!def?.isSecret,
      required: def?.isRequired !== false && def?.default === undefined,
      default: def?.default,
      placeholder: def?.placeholder,
      choices: def?.choices,
    });
  }
  return out;
}

function keyValueInputs(
  prefix: "env" | "header",
  items: RegistryKeyValueInput[] | undefined,
): CatalogInput[] {
  const out: CatalogInput[] = [];
  const seenVars = new Set<string>();
  for (const it of items ?? []) {
    if (!it?.name) continue;
    if (it.value !== undefined) {
      // A fixed value, possibly with `{var}` parts the user fills in.
      for (const inp of varInputs(it.variables, templateVars(it.value))) {
        if (seenVars.has(inp.key)) continue;
        seenVars.add(inp.key);
        out.push(inp);
      }
      continue;
    }
    out.push({
      key: `${prefix}:${it.name}`,
      label: inputLabel(it.name, it.description),
      description: it.description,
      secret: !!it.isSecret,
      required: !!it.isRequired && it.default === undefined,
      default: it.default,
      placeholder: it.placeholder,
      choices: it.choices,
    });
  }
  return out;
}

function argInputs(args: RegistryArgument[] | undefined, offset: number): CatalogInput[] {
  const out: CatalogInput[] = [];
  (args ?? []).forEach((a, i) => {
    if (a.value !== undefined) {
      out.push(...varInputs(a.variables, templateVars(a.value)));
      return;
    }
    // An optional argument with nothing to fill in is simply left out.
    if (!a.isRequired && a.default === undefined) return;
    const name = a.name ?? a.valueHint ?? `argument ${i + 1}`;
    out.push({
      key: `arg:${offset + i}`,
      label: inputLabel(name, a.description),
      description: a.description,
      secret: !!a.isSecret,
      required: !!a.isRequired && a.default === undefined,
      default: a.default,
      placeholder: a.placeholder ?? a.valueHint,
      choices: a.choices,
    });
  });
  return out;
}

function dedupeInputs(inputs: CatalogInput[]): CatalogInput[] {
  const seen = new Set<string>();
  return inputs.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)));
}

/** Turn one registry server into a marketplace entry. */
export function normalizeRegistryServer(server: RegistryServer): CatalogEntry {
  const options: CatalogOption[] = [];

  (server.remotes ?? []).forEach((r, i) => {
    // Streamable HTTP only: neither the desktop client nor the proxy speaks SSE.
    if (r.type !== "streamable-http" || !r.url) return;
    options.push({
      id: `remote:${i}`,
      kind: "web",
      url: r.url,
      inputs: dedupeInputs([
        ...varInputs(r.variables, templateVars(r.url)),
        ...keyValueInputs("header", r.headers),
      ]),
    });
  });

  (server.packages ?? []).forEach((p, i) => {
    if (!p?.identifier || !p.registryType) return;
    const stdio = !p.transport?.type || p.transport.type === "stdio";
    const runtimeCount = p.runtimeArguments?.length ?? 0;
    options.push({
      id: `package:${i}`,
      kind: "local",
      registryType: p.registryType,
      identifier: p.identifier,
      version: p.version,
      // A package that serves HTTP itself would need starting AND connecting to;
      // only stdio packages are started for now.
      supported: stdio && p.registryType in LOCAL_RUNNERS,
      inputs: dedupeInputs([
        ...argInputs(p.runtimeArguments, 0),
        ...argInputs(p.packageArguments, runtimeCount),
        ...keyValueInputs("env", p.environmentVariables),
      ]),
    });
  });

  const installable = options.some((o) => o.kind === "web" || o.supported);
  return {
    name: server.name,
    title: displayTitle(server),
    description: (server.description ?? "").trim(),
    publisher: server.name.split("/")[0] ?? server.name,
    version: server.version,
    websiteUrl: server.websiteUrl,
    repositoryUrl: server.repository?.url,
    icons: Array.isArray(server.icons) ? server.icons.filter((i) => i?.src) : [],
    verified: isVerifiedMcp(server.name),
    kind: options.some((o) => o.kind === "web") ? "web" : "local",
    options,
    installable,
  };
}

const SLIM_TEXT = 300;
const SLIM_INPUT_TEXT = 120;

function trimText(s: unknown, n: number): string | undefined {
  if (typeof s !== "string" || !s) return undefined;
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function slimInput<T extends RegistryInput & { name?: string; type?: string; valueHint?: string; variables?: Record<string, RegistryInput> }>(i: T): T {
  const out: Record<string, unknown> = {};
  for (const k of ["name", "type", "value", "valueHint", "isRequired", "isSecret", "default", "choices", "placeholder", "format"] as const) {
    if ((i as Record<string, unknown>)[k] !== undefined) out[k] = (i as Record<string, unknown>)[k];
  }
  const d = trimText(i.description, SLIM_INPUT_TEXT);
  if (d) out.description = d;
  if (i.variables) {
    out.variables = Object.fromEntries(
      Object.entries(i.variables).map(([k, v]) => [k, slimInput(v as RegistryInput & { variables?: undefined })]),
    );
  }
  return out as T;
}

/**
 * What the catalog keeps of a registry server: only what the marketplace
 * shows and installs, with long text trimmed. Null when Atlarix has no way to
 * install it (no streamable-http address and no npm/PyPI/Docker stdio
 * package), because a card that cannot be added is only noise in a search.
 *
 * KEEP IN STEP with `slim()` in scripts/fetch-mcp-registry-snapshot.mjs, which
 * builds the shipped snapshot the same way.
 */
export function slimRegistryServer(s: RegistryServer): RegistryServer | null {
  const remotes = (s.remotes ?? [])
    .filter((r) => r?.type === "streamable-http" && r.url)
    .slice(0, 2)
    .map((r) => ({
      type: r.type,
      url: r.url,
      ...(r.headers?.length ? { headers: r.headers.map(slimInput) } : {}),
      ...(r.variables ? { variables: Object.fromEntries(Object.entries(r.variables).map(([k, v]) => [k, slimInput(v)])) } : {}),
    }));
  const packages = (s.packages ?? [])
    .filter(
      (p) =>
        p?.identifier &&
        p.registryType in LOCAL_RUNNERS &&
        (!p.transport?.type || p.transport.type === "stdio"),
    )
    .slice(0, 2)
    .map((p) => ({
      registryType: p.registryType,
      identifier: p.identifier,
      ...(p.version ? { version: p.version } : {}),
      ...(p.runtimeHint ? { runtimeHint: p.runtimeHint } : {}),
      ...(p.runtimeArguments?.length ? { runtimeArguments: p.runtimeArguments.map(slimInput) } : {}),
      ...(p.packageArguments?.length ? { packageArguments: p.packageArguments.map(slimInput) } : {}),
      ...(p.environmentVariables?.length ? { environmentVariables: p.environmentVariables.map(slimInput) } : {}),
    }));
  if (remotes.length === 0 && packages.length === 0) return null;
  const icon = s.icons?.find((i) => i?.src);
  return {
    name: s.name,
    ...(s.title ? { title: s.title } : {}),
    ...(s.version ? { version: s.version } : {}),
    ...(trimText(s.description, SLIM_TEXT) ? { description: trimText(s.description, SLIM_TEXT) } : {}),
    ...(s.websiteUrl ? { websiteUrl: s.websiteUrl } : {}),
    ...(s.repository?.url ? { repository: { url: s.repository.url } } : {}),
    ...(icon ? { icons: [{ src: icon.src, ...(icon.mimeType ? { mimeType: icon.mimeType } : {}) }] } : {}),
    ...(remotes.length ? { remotes } : {}),
    ...(packages.length ? { packages } : {}),
  };
}

/** Keep a record only when it is live: deprecated and deleted entries are hidden. */
export function isListableRecord(r: RegistryRecord): boolean {
  return r.status === "active" && !!r.server?.name;
}

/**
 * Every Verified server, from the registry when it has it and from the
 * built-in fallback otherwise, in Verified order.
 */
export function verifiedEntries(records: Map<string, RegistryRecord>): CatalogEntry[] {
  return VERIFIED_MCP_SERVERS.map((v) => {
    const r = records.get(v.name);
    // The registry copy for its details, our title for the name: the vendors'
    // own titles read "Mcp", "Sentry mcp", "Canva MCP".
    const server =
      r && isListableRecord(r)
        ? { ...r.server, title: v.fallback.title, websiteUrl: r.server.websiteUrl ?? v.fallback.websiteUrl }
        : v.fallback;
    const entry = normalizeRegistryServer(server);
    // A registry entry with no usable remote still has a known-good URL.
    if (!entry.options.some((o) => o.kind === "web")) {
      return normalizeRegistryServer({ ...server, remotes: v.fallback.remotes });
    }
    return entry;
  });
}

// ─── Search ─────────────────────────────────────────────────────────────────

/** What search reads of an entry: enough to rank it, without building the whole card. */
export interface CatalogSearchItem {
  name: string;
  title: string;
  description: string;
}

function score(entry: CatalogSearchItem, terms: string[]): number {
  const title = entry.title.toLowerCase();
  // The server part and the owner, never the namespace's `io.github.` prefix,
  // which half the registry shares and would match every "github" search.
  const server = (entry.name.split("/").pop() ?? "").toLowerCase();
  const owner = namespaceOwner(entry.name).toLowerCase();
  const desc = entry.description.toLowerCase();
  let total = 0;
  for (const t of terms) {
    let s = 0;
    if (title === t) s = 100;
    else if (title.startsWith(t)) s = 60;
    else if (title.includes(t)) s = 40;
    else if (server === t || owner === t) s = 50;
    else if (server.includes(t) || owner.includes(t)) s = 25;
    else if (desc.includes(t)) s = 10;
    if (s === 0) return 0; // every term must match somewhere
    total += s;
  }
  // The publisher IS what was searched for (`github` → io.github.github,
  // `brave search` → io.github.brave): their own server before look-alikes
  // that only borrow the name in a title (QA: GitHub's own ranked 8th).
  if (owner && terms.includes(owner)) total += OWN_PUBLISHER_BONUS;
  return total;
}

const OWN_PUBLISHER_BONUS = 70;

/** A title that starts with a letter reads as a name; `:authority…` and `00Widget` do not. */
const readable = (title: string) => (/^[A-Za-z]/.test(title) ? 0 : 1);

/** Verified first when they match about as well as the rest. */
const VERIFIED_BONUS = 30;

export interface CatalogSearchResult<T = CatalogEntry> {
  entries: T[];
  total: number;
}

/**
 * Local search over the catalog. Empty query: the Verified servers, then the
 * rest by title. Verified entries always rank first among matches.
 */
export function searchCatalog<T extends CatalogSearchItem>(
  entries: T[],
  query: string,
  opts: { offset?: number; limit?: number } = {},
): CatalogSearchResult<T> {
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const verifiedRank = (e: T) => VERIFIED_ORDER.get(e.name) ?? Infinity;

  let ranked: T[];
  if (terms.length === 0) {
    ranked = [...entries].sort(
      (a, b) =>
        verifiedRank(a) - verifiedRank(b) ||
        readable(a.title) - readable(b.title) ||
        a.title.localeCompare(b.title),
    );
  } else {
    const bonus = (e: T) => (VERIFIED_ORDER.has(e.name) ? VERIFIED_BONUS : 0);
    ranked = entries
      .map((e) => ({ e, s: score(e, terms) }))
      .filter((x) => x.s > 0)
      .map((x) => ({ e: x.e, s: x.s + bonus(x.e) }))
      .sort(
        (a, b) =>
          b.s - a.s ||
          verifiedRank(a.e) - verifiedRank(b.e) ||
          readable(a.e.title) - readable(b.e.title) ||
          a.e.title.localeCompare(b.e.title),
      )
      .map((x) => x.e);
  }
  return { entries: ranked.slice(offset, offset + limit), total: ranked.length };
}

/** The title a server is shown under: its own, or one made from its name. */
export function displayTitle(server: Pick<RegistryServer, "name" | "title">): string {
  return server.title?.trim() || titleFromName(server.name);
}

// ─── Where a URL lives ──────────────────────────────────────────────────────

/**
 * True when a URL can be an ACCOUNT connector: `https://` and not this machine
 * or a private network. Mirrors the `account_mcp_servers` CHECK constraints
 * (the database is the real gate; this decides where to send the add).
 */
export function isPublicHttpsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const s = raw.trim();
  if (/^https:\/\/(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1)/i.test(s)) return false;
  if (/\.local(\/|:|$)/i.test(s)) return false;
  const host = u.hostname.toLowerCase();
  // 172.16.0.0/12 and 0.0.0.0 are private too (the proxy's SSRF check refuses them at call time).
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "0.0.0.0") return false;
  return true;
}

/** A connector name the account table accepts (it goes into the system prompt). */
export function connectorNameFor(title: string): string {
  const cleaned = title
    .replace(/[^A-Za-z0-9 ._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^A-Za-z0-9]+/, "");
  return (cleaned || "Server").slice(0, 60).trim();
}

/** A slug the account table accepts. */
export function connectorSlugFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "server";
}

// ─── Install ────────────────────────────────────────────────────────────────

export type ResolvedInstall =
  | {
      transport: "http";
      url: string;
      headers: Record<string, string>;
    }
  | {
      transport: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
    };

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_, v: string) => values[`var:${v}`] ?? "");
}

function valueFor(
  input: { default?: string } | undefined,
  key: string,
  values: Record<string, string>,
): string | undefined {
  const v = values[key];
  if (v !== undefined && v !== "") return v;
  return input?.default;
}

function buildArgs(
  args: RegistryArgument[] | undefined,
  offset: number,
  values: Record<string, string>,
): string[] {
  const out: string[] = [];
  (args ?? []).forEach((a, i) => {
    const v =
      a.value !== undefined ? fill(a.value, values) : valueFor(a, `arg:${offset + i}`, values);
    if (v === undefined || v === "") return;
    if (a.type === "named" && a.name) {
      if (a.name.includes("=")) out.push(a.name);
      else out.push(a.name, v);
    } else {
      out.push(v);
    }
  });
  return out;
}

/** The required inputs the user left empty, by label. */
export function missingInputs(option: CatalogOption, values: Record<string, string>): string[] {
  return option.inputs
    .filter((i) => i.required && !(values[i.key] ?? "").trim() && i.default === undefined)
    .map((i) => i.label);
}

/**
 * Turn an option plus the user's values into a server config. Throws with a
 * sentence a user can act on when the option cannot be installed.
 */
export function resolveInstall(
  server: RegistryServer,
  optionId: string,
  values: Record<string, string>,
): ResolvedInstall {
  const [kind, idx] = optionId.split(":");
  const i = Number(idx);
  if (kind === "remote") {
    const r = server.remotes?.[i];
    if (!r?.url || r.type !== "streamable-http") throw new Error("That address is not available.");
    const headers: Record<string, string> = {};
    for (const h of r.headers ?? []) {
      const v = h.value !== undefined ? fill(h.value, values) : valueFor(h, `header:${h.name}`, values);
      if (v) headers[h.name] = v;
    }
    return { transport: "http", url: fill(r.url, values), headers };
  }
  if (kind === "package") {
    const p = server.packages?.[i];
    if (!p) throw new Error("That package is not available.");
    const runner = LOCAL_RUNNERS[p.registryType];
    if (!runner || (p.transport?.type && p.transport.type !== "stdio")) {
      throw new Error(`Atlarix cannot start ${p.registryType} servers yet.`);
    }
    const env: Record<string, string> = {};
    for (const e of p.environmentVariables ?? []) {
      const v = e.value !== undefined ? fill(e.value, values) : valueFor(e, `env:${e.name}`, values);
      if (v) env[e.name] = v;
    }
    const runtimeCount = p.runtimeArguments?.length ?? 0;
    const runtimeArgs = buildArgs(p.runtimeArguments, 0, values);
    const packageArgs = buildArgs(p.packageArguments, runtimeCount, values);
    const command = p.runtimeHint && /^[A-Za-z0-9_.-]+$/.test(p.runtimeHint) ? p.runtimeHint : runner;
    const pinned = p.version && p.version !== "latest";
    if (p.registryType === "npm") {
      const spec = pinned ? `${p.identifier}@${p.version}` : p.identifier;
      return { transport: "stdio", command, args: [...runtimeArgs, ...(runtimeArgs.includes("-y") ? [] : ["-y"]), spec, ...packageArgs], env };
    }
    if (p.registryType === "pypi") {
      const spec = pinned ? `${p.identifier}==${p.version}` : p.identifier;
      return { transport: "stdio", command, args: [...runtimeArgs, spec, ...packageArgs], env };
    }
    // oci: the container gets each variable by NAME; docker reads the value from its own environment.
    const image = p.identifier.includes(":") || !pinned ? p.identifier : `${p.identifier}:${p.version}`;
    const envFlags = Object.keys(env).flatMap((k) => ["-e", k]);
    return {
      transport: "stdio",
      command,
      args: ["run", "-i", "--rm", ...envFlags, ...runtimeArgs, image, ...packageArgs],
      env,
    };
  }
  throw new Error("Unknown install option.");
}
