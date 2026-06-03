import log from "electron-log";
import { createLoggedHandler } from "./safe_handle";
import { mcpManager } from "../utils/mcp_manager";
import {
  cancelMcpOAuthFlow,
  finishMcpOAuthCallback,
  getMcpOAuthStatus,
  initMcpOAuthBroadcast,
  revokeMcpOAuth,
  startMcpOAuthFlow,
} from "@/lib/mcp/mcp-oauth-service";

const logger = log.scope("mcp_oauth_handlers");
const handle = createLoggedHandler(logger);

let broadcastInitialized = false;

export function registerMcpOAuthHandlers(): void {
  if (!broadcastInitialized) {
    initMcpOAuthBroadcast();
    broadcastInitialized = true;
  }

  handle(
    "mcp:start-oauth",
    async (
      _event,
      params: { serverId: number; scopes?: string[] },
    ): Promise<{ status: "authorized" | "redirect" }> => {
      mcpManager.dispose(params.serverId);
      return startMcpOAuthFlow(params.serverId, { scopes: params.scopes });
    },
  );

  handle("mcp:cancel-oauth", async (_event, serverId: number) => {
    cancelMcpOAuthFlow(serverId);
    return { ok: true as const };
  });

  handle("mcp:oauth-status", async (_event, serverId: number) => {
    return getMcpOAuthStatus(serverId);
  });

  handle("mcp:revoke-oauth", async (_event, serverId: number) => {
    mcpManager.dispose(serverId);
    await revokeMcpOAuth(serverId);
    return { ok: true as const };
  });
}

export async function handleMcpOAuthDeepLink(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "atlarix:" ||
      parsed.hostname !== "mcp" ||
      !parsed.pathname.startsWith("/oauth/callback")
    ) {
      return false;
    }

    const error = parsed.searchParams.get("error");
    if (error) {
      const description =
        parsed.searchParams.get("error_description") ?? error;
      logger.error("MCP OAuth callback error:", description);
      return true;
    }

    const code = parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state");
    if (!code || !state) {
      logger.error("MCP OAuth callback missing code or state");
      return true;
    }

    const result = await finishMcpOAuthCallback(code, state);
    mcpManager.dispose(result.serverId);
    logger.log(`MCP OAuth completed for server ${result.serverId}`);
    return true;
  } catch (e) {
    logger.error("handleMcpOAuthDeepLink failed", e);
    return true;
  }
}
