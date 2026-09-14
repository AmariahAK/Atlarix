/**
 * The connector NAMES the prompt carries.
 *
 * READ STRAIGHT FROM POSTGREST, not through the proxy, and that is deliberate:
 * a connector row is the user's own row under RLS with no credential involved,
 * so routing this through the proxy would make the prompt's connector line
 * depend on the proxy being reachable. It is the same reasoning as the skills
 * and notes pulls.
 *
 * NAMES ONLY. The column has a CHECK that makes a name prompt-safe by
 * construction — no newlines, no angle brackets, no quotes, bounded length —
 * and nothing else about a connector has that property. A description comes
 * from whoever wrote the row and a tool name comes from the remote server;
 * both belong inside an envelope, which the system prompt is not.
 */

import { GOTRUE } from "../auth/config";
import { getAccessToken } from "../auth/sign-in";

export async function listConnectorNames(): Promise<string[]> {
  try {
    const token = await getAccessToken();
    if (!token) return [];
    const res = await fetch(
      `${GOTRUE.url.replace(/\/+$/, "")}/rest/v1/account_mcp_servers` +
        `?select=name&enabled=is.true&order=name.asc`,
      { headers: { apikey: GOTRUE.anonKey, Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return [];
    const rows: unknown = await res.json();
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => (r as { name?: unknown }).name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
  } catch {
    return [];
  }
}
