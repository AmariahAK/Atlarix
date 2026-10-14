/**
 * `mcp_servers` — find a web MCP server for the task and offer it to the user.
 *
 * SEARCH AND SUGGEST ONLY, deliberately. This agent reads pages anyone wrote,
 * so it gets nothing that changes the account by itself: no start, stop or
 * disconnect here (the desktop agent has those). A suggestion only puts a card
 * in front of the user; they connect it or don't. Like `ask_user`, the turn
 * ends and their answer arrives as their next message — which is what lets a
 * card survive the panel closing (it is redrawn from the recorded call).
 *
 * Only WEB servers (a public https address): a connector lives on the account,
 * and a browser cannot start a program.
 */
import {
  isPublicHttpsUrl,
  normalizeRegistryServer,
  VERIFIED_MCP_SERVERS,
  type CatalogEntry,
  type RegistryServer,
} from "@/shared/mcp-catalog";
import { GOTRUE } from "../auth/config";
import { getAccessToken } from "../auth/sign-in";
import type { ToolOutcome } from "./dispatch";

export const MCP_REGISTRY = "https://registry.modelcontextprotocol.io";

/** The account's connector rows, as this panel needs them (null when signed out). */
export interface ConnectorRowLite {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  auth_type: string;
  registry_name?: string | null;
  credential_set_at: string | null;
}

export async function connectorRows(): Promise<ConnectorRowLite[] | null> {
  const token = await getAccessToken();
  if (!token) return null;
  const base = `${GOTRUE.url.replace(/\/+$/, "")}/rest/v1/account_mcp_servers`;
  const read = (cols: string) =>
    fetch(`${base}?select=${cols}&order=created_at.asc`, {
      headers: { apikey: GOTRUE.anonKey, Authorization: `Bearer ${token}` },
    });
  const cols = "id,name,url,enabled,auth_type,credential_set_at";
  let res = await read(`${cols},registry_name`).catch(() => null);
  // A database without the newer column still lists.
  if (res && !res.ok) res = await read(cols).catch(() => null);
  if (!res?.ok) return null;
  const rows: unknown = await res.json().catch(() => null);
  return Array.isArray(rows) ? (rows as ConnectorRowLite[]) : null;
}

/** A web entry: a public https remote this account can hold (one secret at most). */
export function webEntry(server: RegistryServer): CatalogEntry | null {
  const entry = normalizeRegistryServer(server);
  const web = entry.options.find((o) => o.kind === "web");
  if (!web || web.kind !== "web" || web.url.includes("{") || !isPublicHttpsUrl(web.url)) return null;
  if (web.inputs.length > 1) return null;
  return entry;
}

async function registryGet(path: string): Promise<unknown> {
  const res = await fetch(`${MCP_REGISTRY}${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`The MCP Registry answered ${res.status}.`);
  return res.json();
}

/** One server by registry name: the Verified copy, else the registry's latest. */
export async function findRegistryServer(name: string): Promise<RegistryServer | null> {
  const verified = VERIFIED_MCP_SERVERS.find((v) => v.name === name);
  if (verified) return verified.fallback;
  try {
    const doc = (await registryGet(`/v0.1/servers/${encodeURIComponent(name)}/versions/latest`)) as {
      server?: RegistryServer;
    };
    return doc?.server?.name ? doc.server : null;
  } catch {
    return null;
  }
}

async function search(query: string): Promise<ToolOutcome> {
  const q = query.trim().toLowerCase();
  const verified = VERIFIED_MCP_SERVERS.map((v) => webEntry(v.fallback)!).filter(
    (e) => !q || `${e.title} ${e.description} ${e.name}`.toLowerCase().includes(q),
  );
  let found: CatalogEntry[] = [];
  if (q) {
    try {
      const doc = (await registryGet(
        `/v0.1/servers?version=latest&limit=50&search=${encodeURIComponent(q)}`,
      )) as { servers?: Array<{ server?: RegistryServer }> };
      found = (doc.servers ?? [])
        .map((s) => (s.server ? webEntry(s.server) : null))
        .filter((e): e is CatalogEntry => !!e && !e.verified);
    } catch (e) {
      if (!verified.length) return { content: e instanceof Error ? e.message : String(e) };
    }
  }
  const rows = (await connectorRows()) ?? [];
  const servers = [...verified, ...found].slice(0, 12).map((e) => {
    const url = (e.options.find((o) => o.kind === "web") as { url: string }).url;
    const row = rows.find((r) => r.registry_name === e.name || r.url === url);
    return {
      server: e.name,
      title: e.title,
      publisher: e.verified ? "Verified" : e.publisher,
      description: e.description,
      ...(row ? { added: true, on: row.enabled, signedIn: row.auth_type === "none" || !!row.credential_set_at } : {}),
    };
  });
  return { content: JSON.stringify({ servers }) };
}

export async function mcpServersTool(args: Record<string, unknown>): Promise<ToolOutcome> {
  const op = args.operation;
  if (op === "search") return search(typeof args.query === "string" ? args.query : "");
  if (op !== "suggest") return { content: 'operation must be "search" or "suggest".' };
  const server = typeof args.server === "string" ? args.server.trim() : "";
  if (!server) return { content: "suggest needs `server`: a registry name from search." };
  const rows = await connectorRows();
  if (rows === null) return { content: "The user is not signed in, so no server can be connected here." };
  const row = rows.find((r) => r.registry_name === server || r.name.toLowerCase() === server.toLowerCase());
  if (row?.enabled && (row.auth_type === "none" || row.credential_set_at)) {
    return { content: `"${row.name}" is already connected and on. Use list_available_mcps and mcp_call.` };
  }
  if (!row) {
    const found = await findRegistryServer(server);
    if (!found || !webEntry(found)) {
      return { content: `No web server "${server}" in the MCP Registry. Use operation "search" to find one.` };
    }
  }
  return {
    content:
      "The user now sees a card to connect it, and this turn is over. Their answer arrives as their next message.",
    endsTurn: true,
  };
}

// ─── Connecting, from the card ──────────────────────────────────────────────

/** One of the account's write RPCs (the same ones atlarix.dev and the desktop use). */
export async function accountRpc(fn: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = await getAccessToken();
  if (!token) throw new Error("Sign in to Atlarix first.");
  const res = await fetch(`${GOTRUE.url.replace(/\/+$/, "")}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: GOTRUE.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_input: input }),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body || body.ok === false) {
    const code = typeof body?.error === "string" ? body.error : "";
    throw new Error(code === "duplicate_slug" ? "A connector with that name already exists." : "Couldn't save the connector. Try again.");
  }
  return body;
}

/**
 * How a server signs in: a 401 whose metadata names an authorization server
 * is a browser sign-in; a bare 401 wants a key; anything else, nothing. The
 * panel can make this request: the extension may reach any https host.
 */
export async function probeAuth(url: string): Promise<"oauth" | "api_key" | "none"> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Atlarix", version: "1" } },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return "oauth";
  }
  if (res.status !== 401 && res.status !== 403) return "none";
  const u = new URL(url);
  for (const meta of [
    `${u.origin}/.well-known/oauth-protected-resource${u.pathname === "/" ? "" : u.pathname}`,
    `${u.origin}/.well-known/oauth-protected-resource`,
    `${u.origin}/.well-known/oauth-authorization-server`,
  ]) {
    const r = await fetch(meta, { signal: AbortSignal.timeout(8_000) }).catch(() => null);
    if (r?.ok) return "oauth";
  }
  return "api_key";
}

/** A connector name and slug the account table accepts. */
export function connectorNaming(title: string): { name: string; slug: string } {
  const name =
    title.replace(/[^A-Za-z0-9 ._-]+/g, " ").replace(/\s+/g, " ").trim().replace(/^[^A-Za-z0-9]+/, "").slice(0, 60) || "Server";
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "server";
  return { name, slug };
}
