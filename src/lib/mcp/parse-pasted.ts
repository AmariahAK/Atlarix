/**
 * "Add your own": one box that takes whatever the user has.
 *
 *   - a URL                     → one server reached over HTTP
 *   - a command line            → one server Atlarix starts
 *   - JSON from another tool    → every server in it: Claude Desktop, Claude
 *     Code and Cursor (`mcpServers`), VS Code (`servers`, or `mcp.servers` in
 *     settings.json), Zed (`context_servers`), a bare `{name: {...}}` map, a
 *     single server object, or a `"name": {...}` fragment copied out of a README.
 *
 * Parsing only: nothing is added here. `mcp-add.ts` decides where each server
 * lives (a public https URL goes on the account; the rest stays on this
 * machine) and adds it.
 */
import { parseJsonc, toServer, type ExternalMcpServerFull } from "./discover-external";

export type PastedServer =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
    }
  | {
      name: string;
      transport: "http";
      url: string;
      headers: Record<string, string>;
      bearer?: string;
    };

export type PasteParse =
  | { kind: "empty" }
  | { kind: "url"; url: string }
  | { kind: "command"; command: string; args: string[] }
  | { kind: "servers"; servers: PastedServer[]; skipped: Array<{ name: string; reason: string }> }
  | { kind: "invalid"; error: string };

/** Split a command line the way a shell would for simple quoting. */
export function splitCommandLine(line: string): string[] {
  return (
    line
      .trim()
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      ?.map((a) => a.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1")) ?? []
  );
}

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const looksLikeServer = (v: unknown) =>
  isObj(v) && ("command" in v || "url" in v || "serverUrl" in v);

/** The `{name: server}` map inside a config, wherever the tool keeps it. */
function serverMap(doc: Raw): Raw | null {
  for (const key of ["mcpServers", "servers", "context_servers"]) {
    if (isObj(doc[key])) return doc[key] as Raw;
  }
  if (isObj(doc.mcp) && isObj((doc.mcp as Raw).servers)) return (doc.mcp as Raw).servers as Raw;
  // A bare map: every value is a server.
  const values = Object.values(doc);
  if (values.length > 0 && values.every(looksLikeServer)) return doc;
  return null;
}

function nameFromUrlOrCommand(v: Raw): string {
  const url = typeof v.url === "string" ? v.url : typeof v.serverUrl === "string" ? v.serverUrl : null;
  if (url) {
    try {
      const u = new URL(url);
      // A server on this machine is named by its port: "127" said nothing (QA).
      if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(u.hostname)) {
        return u.port ? `localhost-${u.port}` : "localhost";
      }
      return u.hostname.replace(/^(www|mcp|api)\./, "").split(".")[0] || "server";
    } catch {
      /* fall through */
    }
  }
  const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === "string") : [];
  const pkg = args.find((a) => !a.startsWith("-"));
  return (pkg ?? (typeof v.command === "string" ? v.command : "server"))
    .replace(/^@[^/]+\//, "")
    .replace(/@[\w.^~-]+$/, "")
    .split("/")
    .pop()!;
}

function fromExternal(s: ExternalMcpServerFull): PastedServer {
  if (s.transport === "stdio") {
    return { name: s.name, transport: "stdio", command: s.command!, args: s.args ?? [], env: s.env ?? {} };
  }
  return {
    name: s.name,
    transport: "http",
    url: s.url!,
    headers: s.headers ?? {},
    ...(s.bearer ? { bearer: s.bearer } : {}),
  };
}

function parseJsonText(text: string): unknown {
  try {
    return parseJsonc(text);
  } catch {
    // A fragment: `"github": { ... }` or several, copied out of a larger file.
    return parseJsonc(`{${text.replace(/,\s*$/, "")}}`);
  }
}

export function parsePasted(input: string): PasteParse {
  const text = input.trim();
  if (!text) return { kind: "empty" };

  if (/^https?:\/\/\S+$/i.test(text)) {
    try {
      new URL(text);
      return { kind: "url", url: text };
    } catch {
      return { kind: "invalid", error: "That address isn't a valid URL." };
    }
  }

  if (text.startsWith("{") || text.startsWith('"')) {
    let doc: unknown;
    try {
      doc = parseJsonText(text);
    } catch {
      return { kind: "invalid", error: "That looks like JSON but couldn't be read." };
    }
    if (!isObj(doc)) return { kind: "invalid", error: "Paste a JSON object." };
    const map: Raw | null = looksLikeServer(doc)
      ? { [nameFromUrlOrCommand(doc)]: doc }
      : serverMap(doc);
    if (!map) return { kind: "invalid", error: "No MCP servers found in that JSON." };

    const servers: PastedServer[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    for (const [name, raw] of Object.entries(map)) {
      if (!isObj(raw)) continue;
      if (JSON.stringify(raw).includes("${input:")) {
        skipped.push({ name, reason: "it asks VS Code for a value when it starts" });
        continue;
      }
      const s = toServer("pasted", name, raw, "everywhere");
      if (!s) {
        skipped.push({ name, reason: "it has no command or http address" });
        continue;
      }
      servers.push(fromExternal(s));
    }
    if (servers.length === 0 && skipped.length === 0) {
      return { kind: "invalid", error: "No MCP servers found in that JSON." };
    }
    return { kind: "servers", servers, skipped };
  }

  const parts = splitCommandLine(text);
  if (parts.length === 0) return { kind: "empty" };
  return { kind: "command", command: parts[0]!, args: parts.slice(1) };
}

/** A readable server name from a command line (`npx -y @acme/mcp-thing` → `mcp-thing`). */
export function nameForCommand(command: string, args: string[]): string {
  return nameFromUrlOrCommand({ command, args });
}

/** A readable server name from a URL (`https://mcp.linear.app/mcp` → `linear`). */
export function nameForUrl(url: string): string {
  return nameFromUrlOrCommand({ url });
}
