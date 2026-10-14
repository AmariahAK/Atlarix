/**
 * MCP servers you already set up in other tools on this computer (Claude Code,
 * Cursor, VS Code, Kiro, Windsurf, Zed, Claude Desktop), found so Atlarix can
 * offer each one with an Add button. Nothing is added without that click: a
 * server in another tool's config is a suggestion, not a setting.
 *
 * What a listing shows never includes a value from a server's environment or
 * headers (they hold API keys): only their NAMES. The values are read again,
 * from the same file, only when you add that server.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ExternalMcpServer {
  /** `<source>:<name>`: what Add sends back. */
  key: string;
  source: string;
  name: string;
  transport: "stdio" | "http";
  /** The command line or URL, for recognising it (never env or header values). */
  summary: string;
  /** Names of its environment variables (values never leave the file until added). */
  envNames: string[];
  /** Set up for this folder in that tool, or for every folder. */
  scope: "folder" | "everywhere";
}

/** The full server, values included: only for adding it. */
export interface ExternalMcpServerFull extends ExternalMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** A bearer token from an Authorization header, when there is one. */
  bearer?: string;
  /** Every other request header it sends (`X-Api-Key`, …), values included. */
  headers?: Record<string, string>;
}

/** JSON with // and /* comments and trailing commas (VS Code's and Zed's files). */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v = parseJsonc(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
const record = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Raw).filter(([, x]) => typeof x === "string")) as Record<string, string>
    : undefined;

/** One entry in the common shape (`command`/`args`/`env` or `url`/`headers`), or Zed's. */
export function toServer(source: string, name: string, raw: Raw, scope: "folder" | "everywhere"): ExternalMcpServerFull | null {
  // Zed: `command` is { path, args, env }, or command/args at the top with source "custom".
  const zedCmd = raw.command && typeof raw.command === "object" ? (raw.command as Raw) : null;
  const command = zedCmd ? str(zedCmd.path) : str(raw.command);
  const args = (zedCmd ? strs(zedCmd.args) : strs(raw.args)) ?? [];
  const env = (zedCmd ? record(zedCmd.env) : record(raw.env)) ?? {};
  const url = str(raw.url) ?? str(raw.serverUrl);
  const headers = record(raw.headers) ?? {};
  // VS Code's prompted values (${input:…}) only exist inside VS Code.
  if (JSON.stringify(raw).includes("${input:")) return null;
  const base = { key: `${source}:${name}`, source, name, scope, envNames: Object.keys(env) };
  if (command) {
    return { ...base, transport: "stdio", summary: [command, ...args].join(" "), command, args, env };
  }
  if (url && /^https?:\/\//i.test(url)) {
    const auth = headers.Authorization ?? headers.authorization;
    const bearer = auth?.replace(/^Bearer\s+/i, "");
    const isBearer = !!bearer && bearer !== auth;
    // The bearer travels as `bearer`; any other header (a non-Bearer
    // Authorization included) is kept as it was written.
    const rest = Object.fromEntries(
      Object.entries(headers).filter(([k]) => !(isBearer && k.toLowerCase() === "authorization")),
    );
    return {
      ...base,
      transport: "http",
      summary: url,
      url,
      ...(isBearer ? { bearer } : {}),
      ...(Object.keys(rest).length > 0 ? { headers: rest } : {}),
    };
  }
  return null;
}

function fromMap(source: string, map: unknown, scope: "folder" | "everywhere", out: ExternalMcpServerFull[]): void {
  if (!map || typeof map !== "object") return;
  for (const [name, raw] of Object.entries(map as Raw)) {
    if (!raw || typeof raw !== "object" || (raw as Raw).disabled === true || (raw as Raw).enabled === false) continue;
    const s = toServer(source, name, raw as Raw, scope);
    if (s) out.push(s);
  }
}

/** Where each tool keeps them, on this OS. */
function places(home: string, folder: string | null): Array<{ source: string; file: string; scope: "folder" | "everywhere"; key: string; claudeProject?: boolean }> {
  // The environment's folders describe the REAL home; a different one (a test's) uses the defaults.
  const real = path.resolve(home) === path.resolve(os.homedir());
  const appData =
    process.platform === "win32"
      ? (real && process.env.APPDATA) || path.join(home, "AppData", "Roaming")
      : process.platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : (real && process.env.XDG_CONFIG_HOME) || path.join(home, ".config");
  const list: ReturnType<typeof places> = [
    { source: "Claude Code", file: path.join(home, ".claude.json"), scope: "everywhere", key: "mcpServers" },
    { source: "Claude Code", file: path.join(home, ".claude.json"), scope: "folder", key: "mcpServers", claudeProject: true },
    { source: "Cursor", file: path.join(home, ".cursor", "mcp.json"), scope: "everywhere", key: "mcpServers" },
    { source: "VS Code", file: path.join(appData, "Code", "User", "mcp.json"), scope: "everywhere", key: "servers" },
    { source: "Kiro", file: path.join(home, ".kiro", "settings", "mcp.json"), scope: "everywhere", key: "mcpServers" },
    { source: "Windsurf", file: path.join(home, ".codeium", "windsurf", "mcp_config.json"), scope: "everywhere", key: "mcpServers" },
    { source: "Zed", file: path.join(process.platform === "win32" ? appData : path.join(home, ".config"), "zed", "settings.json"), scope: "everywhere", key: "context_servers" },
    { source: "Claude Desktop", file: path.join(appData, "Claude", "claude_desktop_config.json"), scope: "everywhere", key: "mcpServers" },
  ];
  if (folder) {
    list.push(
      { source: "Claude Code", file: path.join(folder, ".mcp.json"), scope: "folder", key: "mcpServers" },
      { source: "Cursor", file: path.join(folder, ".cursor", "mcp.json"), scope: "folder", key: "mcpServers" },
      { source: "VS Code", file: path.join(folder, ".vscode", "mcp.json"), scope: "folder", key: "servers" },
      { source: "Kiro", file: path.join(folder, ".kiro", "settings", "mcp.json"), scope: "folder", key: "mcpServers" },
    );
  }
  return list;
}

/** Every server found, values included (callers that show them use `discoverExternalMcpServers`). */
export function findExternalMcpServers(folder: string | null, home = os.homedir()): ExternalMcpServerFull[] {
  const out: ExternalMcpServerFull[] = [];
  const cache = new Map<string, Record<string, unknown> | null>();
  for (const p of places(home, folder)) {
    if (!cache.has(p.file)) cache.set(p.file, readJson(p.file));
    const json = cache.get(p.file);
    if (!json) continue;
    if (p.claudeProject) {
      // Claude Code keeps per-folder servers under projects[<absolute path>].
      const projects = json.projects as Record<string, Raw> | undefined;
      const mine = folder && projects ? (projects[folder] ?? projects[path.resolve(folder)]) : undefined;
      fromMap(p.source, mine?.mcpServers, "folder", out);
      continue;
    }
    // VS Code's user settings.json can hold them too (mcp.servers); its own mcp.json uses `servers`.
    fromMap(p.source, json[p.key], p.scope, out);
  }
  // The same server in two places: keep the first (folder-specific ones come later, so prefer them).
  const byKey = new Map<string, ExternalMcpServerFull>();
  for (const s of out) if (!byKey.has(s.key) || s.scope === "folder") byKey.set(s.key, s);
  return [...byKey.values()];
}

/**
 * A command line or URL with anything that looks like a secret masked: the
 * value after a key/token/secret/password flag, a URL's query values, and long
 * random-looking strings.
 */
export function maskSecrets(summary: string): string {
  return summary
    .replace(/((?:^|\s)--?[\w-]*(?:key|token|secret|password|auth)[\w-]*(?:=|\s+))\S+/gi, "$1…")
    .replace(/([?&][^=&\s]+=)[^&\s]+/g, "$1…")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, "…");
}

/** What a screen may show: no environment or header values, and the command line masked. */
export function discoverExternalMcpServers(folder: string | null, home = os.homedir()): ExternalMcpServer[] {
  return findExternalMcpServers(folder, home).map(({ key, source, name, transport, summary, envNames, scope }) => ({
    key,
    source,
    name,
    transport,
    summary: maskSecrets(summary),
    envNames,
    scope,
  }));
}
