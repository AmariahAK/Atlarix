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
 * The opposite of `lib/skills/account-skills.ts`, deliberately, and the reason
 * is the credential. A skill is the user's own row under RLS with nothing
 * secret in it, so it is read directly. A connector's credential lives in
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

import { getSession } from "@/lib/auth/supabase-client";
import { ATLARIX_SURFACE, getCoreProxyBaseUrl } from "@/ipc/shared/core_proxy";

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
        "X-Atlarix-Surface": ATLARIX_SURFACE,
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

/** Reused briefly — the list is rebuilt whenever the model asks what exists. */
const CACHE_MS = 30_000;
let cache: { at: number; servers: AccountConnector[] } | null = null;

export function clearAccountConnectorsCache(): void {
  cache = null;
}

/**
 * The user's account connectors and the tools each exposes.
 *
 * A server that failed to list is RETURNED WITH ITS ERROR rather than dropped.
 * Dropping it tells the model the connector does not exist, so it plans around
 * an absence instead of reporting a failure the user could go and fix.
 */
export async function listAccountConnectors(): Promise<AccountConnector[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.servers;

  const body = await proxyPost<ListResponse>("/mcp/list", {});
  const servers = body?.ok && Array.isArray(body.servers) ? body.servers : [];
  cache = { at: now, servers };
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
