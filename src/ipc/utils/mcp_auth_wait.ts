import type { WebContents } from "electron";
import { waitForMcpAuth } from "@/lib/mcp/mcp-oauth-service";
import { type McpAuthType } from "@/lib/mcp/oauth-constants";

export type RequireMcpAuthInfo = {
  serverId: number;
  serverName: string;
  authType: McpAuthType;
  reason?: "missing" | "invalid";
};

/**
 * Prompt the user to authenticate an MCP server, then block until they do.
 *
 * - OAuth → reuses the existing `mcp:oauth-required` event (the `McpOAuthPrompt`
 *   "Connect" toast drives `startMcpOAuth`).
 * - api_key / env → sends `mcp:auth-required` so the renderer can show a
 *   "Configure <server>" prompt that opens Settings → MCP.
 *
 * Resolves `true` once the server is authenticated (OAuth success or a saved
 * key/env via `notifyMcpAuthUpdated`), `false` on cancel / error. The wait is
 * INDEFINITE (a human may take hours to authenticate) and is cancelled only by
 * the turn's `abortSignal` (Stop) — mirrors the permission approval gate.
 */
export function requireMcpAuth(
  sender: WebContents,
  info: RequireMcpAuthInfo,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  const { serverId, serverName, authType, reason } = info;
  if (!sender.isDestroyed()) {
    if (authType === "oauth") {
      sender.send("mcp:oauth-required", { serverId, serverName });
    } else {
      sender.send("mcp:auth-required", {
        serverId,
        serverName,
        authType,
        reason: reason ?? "missing",
      });
    }
  }
  return waitForMcpAuth(serverId, { abortSignal });
}
