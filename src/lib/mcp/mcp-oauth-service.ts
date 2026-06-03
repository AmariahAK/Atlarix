import log from "electron-log";
import { eq } from "drizzle-orm";
import { BrowserWindow } from "electron";
import {
  auth,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { db } from "@/db";
import { mcpServers } from "@/db/schema";
import {
  AtlarixOAuthProvider,
  setMcpOAuthRedirectHandler,
} from "./atlarix-oauth-provider";
import { MCP_OAUTH_FLOW_TIMEOUT_MS } from "./oauth-constants";
import { createMcpOAuthLoopbackServer } from "./oauth-loopback-server";
import {
  clearPendingMcpOAuthSession,
  getPendingMcpOAuthSession,
  getPendingMcpOAuthSessionByState,
  setPendingMcpOAuthSession,
} from "./oauth-session-store";
import {
  deserializeOAuthJsonFromDb,
  isOAuthTokenValid,
  oauthConnectedFromRow,
  shouldClearStaleOAuthClient,
  type StoredOAuthClient,
} from "./oauth-token-utils";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const logger = log.scope("mcp-oauth");

export class McpOAuthError extends Error {
  constructor(
    message: string,
    readonly code?: "needs_oauth" | "in_progress" | "invalid_state" | "not_oauth",
  ) {
    super(message);
    this.name = "McpOAuthError";
  }
}

function broadcastMcpOAuthEvent(
  channel: string,
  payload: Record<string, unknown>,
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
  // Settle any agent tool blocked on this server's authentication.
  const serverId = typeof payload.serverId === "number" ? payload.serverId : null;
  if (serverId != null) {
    if (channel === "mcp:oauth-success" || channel === "mcp:auth-updated") {
      settleMcpAuthWaiters(serverId, true);
    } else if (channel === "mcp:oauth-error") {
      settleMcpAuthWaiters(serverId, false);
    }
  }
}

// ── Agent auth-and-retry: block a tool call until the user authenticates ──
// Mirrors the pending-map pattern in mcp_consent.ts / user_question_wait.ts.
type McpAuthWaiter = { resolve: (ok: boolean) => void; timer: NodeJS.Timeout };
const pendingMcpAuthWaiters = new Map<number, McpAuthWaiter[]>();

function settleMcpAuthWaiters(serverId: number, ok: boolean): void {
  const waiters = pendingMcpAuthWaiters.get(serverId);
  if (!waiters?.length) return;
  pendingMcpAuthWaiters.delete(serverId);
  for (const w of waiters) {
    clearTimeout(w.timer);
    w.resolve(ok);
  }
}

/**
 * Resolves `true` when the given MCP server becomes authenticated (OAuth success
 * or a saved key/env), `false` on auth error, cancel, or timeout. Used by the
 * agent's `mcp_call` to pause and retry after the user authenticates.
 */
export function waitForMcpAuth(
  serverId: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      const waiters = pendingMcpAuthWaiters.get(serverId);
      if (waiters) {
        const remaining = waiters.filter((w) => w.timer !== timer);
        if (remaining.length) pendingMcpAuthWaiters.set(serverId, remaining);
        else pendingMcpAuthWaiters.delete(serverId);
      }
      resolve(false);
    }, timeoutMs);
    const entry: McpAuthWaiter = { resolve, timer };
    const list = pendingMcpAuthWaiters.get(serverId);
    if (list) list.push(entry);
    else pendingMcpAuthWaiters.set(serverId, [entry]);
  });
}

/** Notify blocked agent tools that a server's key/env was saved (resolves waiters true). */
export function notifyMcpAuthUpdated(serverId: number): void {
  broadcastMcpOAuthEvent("mcp:auth-updated", { serverId });
}

export function initMcpOAuthBroadcast(): void {
  setMcpOAuthRedirectHandler(({ serverId, serverName, authorizationUrl }) => {
    broadcastMcpOAuthEvent("mcp:oauth-redirect", {
      serverId,
      serverName,
      authorizationUrl,
    });
  });
}

async function loadOAuthServer(serverId: number) {
  const row = await db.query.mcpServers.findFirst({
    where: eq(mcpServers.id, serverId),
  });
  if (!row) throw new McpOAuthError(`MCP server not found: ${serverId}`);
  if (row.transport !== "http" || row.authType !== "oauth") {
    throw new McpOAuthError(
      "OAuth is only supported for HTTP MCP servers with auth_type oauth",
      "not_oauth",
    );
  }
  if (!row.url?.trim()) {
    throw new McpOAuthError("HTTP OAuth MCP requires a url");
  }
  return row;
}

function scopeString(scopes?: string[]): string | undefined {
  if (!scopes?.length) return undefined;
  return scopes.join(" ");
}

async function invalidateStaleOAuthClient(
  serverId: number,
  redirectUrl: string,
): Promise<void> {
  const row = await db.query.mcpServers.findFirst({
    where: eq(mcpServers.id, serverId),
    columns: { oauthClientJson: true },
  });
  const client = deserializeOAuthJsonFromDb<StoredOAuthClient>(
    row?.oauthClientJson,
  );
  if (!shouldClearStaleOAuthClient(client, redirectUrl)) return;
  await db
    .update(mcpServers)
    .set({ oauthClientJson: null })
    .where(eq(mcpServers.id, serverId));
}

function handleLoopbackCallback(serverId: number, serverName: string): void {
  void (async () => {
    const pending = getPendingMcpOAuthSession(serverId);
    const loopback = pending?.loopback;
    if (!loopback) {
      logger.error("No loopback server for MCP OAuth session", { serverId });
      return;
    }

    try {
      const callback = await loopback.waitForCallback();
      if (callback.error) {
        clearPendingMcpOAuthSession(serverId);
        broadcastMcpOAuthEvent("mcp:oauth-error", {
          serverId,
          serverName,
          error: callback.errorDescription ?? callback.error,
        });
        return;
      }
      if (!callback.code || !callback.state) {
        clearPendingMcpOAuthSession(serverId);
        broadcastMcpOAuthEvent("mcp:oauth-error", {
          serverId,
          serverName,
          error: "OAuth callback missing code or state",
        });
        return;
      }

      const result = await finishMcpOAuthCallback(callback.code, callback.state);
      const { mcpManager } = await import("@/ipc/utils/mcp_manager");
      mcpManager.dispose(result.serverId);
    } catch (error) {
      if (getPendingMcpOAuthSession(serverId)) {
        clearPendingMcpOAuthSession(serverId);
        const message = error instanceof Error ? error.message : String(error);
        broadcastMcpOAuthEvent("mcp:oauth-error", {
          serverId,
          serverName,
          error: message,
        });
      }
      logger.error("MCP OAuth loopback callback failed", error);
    }
  })();
}

export async function startMcpOAuthFlow(
  serverId: number,
  opts?: { scopes?: string[] },
): Promise<{ status: "authorized" | "redirect" }> {
  if (getPendingMcpOAuthSession(serverId)) {
    throw new McpOAuthError(
      "OAuth sign-in already in progress for this MCP server",
      "in_progress",
    );
  }

  const row = await loadOAuthServer(serverId);
  const scope = scopeString(opts?.scopes);
  const loopback = await createMcpOAuthLoopbackServer();
  await invalidateStaleOAuthClient(serverId, loopback.redirectUrl);
  const provider = new AtlarixOAuthProvider(
    serverId,
    row.name,
    loopback.redirectUrl,
  );
  const transport = new StreamableHTTPClientTransport(new URL(row.url!), {
    authProvider: provider,
  });

  const timeoutId = setTimeout(() => {
    clearPendingMcpOAuthSession(serverId);
    broadcastMcpOAuthEvent("mcp:oauth-error", {
      serverId,
      serverName: row.name,
      error: "OAuth sign-in timed out. Try again.",
    });
  }, MCP_OAUTH_FLOW_TIMEOUT_MS);

  setPendingMcpOAuthSession({
    serverId,
    serverName: row.name,
    state: provider.state(),
    redirectUrl: loopback.redirectUrl,
    loopback,
    transport,
    scope,
    startedAt: Date.now(),
    timeoutId,
  });

  await transport.start();

  try {
    const result = await auth(provider, {
      serverUrl: row.url!,
      scope,
    });
    if (result === "AUTHORIZED") {
      clearPendingMcpOAuthSession(serverId);
      broadcastMcpOAuthEvent("mcp:oauth-success", {
        serverId,
        serverName: row.name,
      });
      return { status: "authorized" };
    }
    handleLoopbackCallback(serverId, row.name);
    return { status: "redirect" };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      handleLoopbackCallback(serverId, row.name);
      return { status: "redirect" };
    }
    clearPendingMcpOAuthSession(serverId);
    logger.error("startMcpOAuthFlow failed", error);
    throw error;
  }
}

export async function finishMcpOAuthCallback(
  code: string,
  state: string,
): Promise<{ serverId: number; serverName: string }> {
  const pending = getPendingMcpOAuthSessionByState(state);
  if (!pending) {
    throw new McpOAuthError("Unknown or expired OAuth state", "invalid_state");
  }
  if (pending.state !== state) {
    throw new McpOAuthError("OAuth state mismatch", "invalid_state");
  }

  try {
    await pending.transport.finishAuth(code);
    clearPendingMcpOAuthSession(pending.serverId);
    broadcastMcpOAuthEvent("mcp:oauth-success", {
      serverId: pending.serverId,
      serverName: pending.serverName,
    });
    return { serverId: pending.serverId, serverName: pending.serverName };
  } catch (error) {
    clearPendingMcpOAuthSession(pending.serverId);
    const message = error instanceof Error ? error.message : String(error);
    broadcastMcpOAuthEvent("mcp:oauth-error", {
      serverId: pending.serverId,
      serverName: pending.serverName,
      error: message,
    });
    throw error;
  }
}

export function cancelMcpOAuthFlow(serverId: number): void {
  clearPendingMcpOAuthSession(serverId);
  settleMcpAuthWaiters(serverId, false);
}

export async function getMcpOAuthStatus(serverId: number): Promise<{
  connected: boolean;
  serverId: number;
  inProgress: boolean;
}> {
  const row = await db.query.mcpServers.findFirst({
    where: eq(mcpServers.id, serverId),
    columns: { authType: true, oauthTokensJson: true },
  });
  return {
    serverId,
    connected: row ? oauthConnectedFromRow(row) : false,
    inProgress: getPendingMcpOAuthSession(serverId) != null,
  };
}

export async function revokeMcpOAuth(serverId: number): Promise<void> {
  cancelMcpOAuthFlow(serverId);
  await db
    .update(mcpServers)
    .set({
      oauthTokensJson: null,
      oauthClientJson: null,
      oauthDiscoveryJson: null,
    })
    .where(eq(mcpServers.id, serverId));
}

export function parseMcpOAuthCallbackUrl(url: string): {
  code?: string;
  state?: string;
  error?: string;
} {
  const parsed = new URL(url);
  if (parsed.protocol !== "atlarix:") return {};
  const isMcpOAuth =
    parsed.hostname === "mcp" &&
    parsed.pathname.startsWith("/oauth/callback");
  if (!isMcpOAuth) return {};
  return {
    code: parsed.searchParams.get("code") ?? undefined,
    state: parsed.searchParams.get("state") ?? undefined,
    error: parsed.searchParams.get("error") ?? undefined,
  };
}

export function isMcpOAuthDeepLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "atlarix:" &&
      parsed.hostname === "mcp" &&
      parsed.pathname.startsWith("/oauth/callback")
    );
  } catch {
    return false;
  }
}

export function isMcpOAuthUnauthorized(error: unknown): boolean {
  return (
    error instanceof UnauthorizedError ||
    error instanceof McpOAuthError ||
    (error instanceof Error &&
      /unauthorized|401|oauth|sign-?in required/i.test(error.message))
  );
}

export async function serverNeedsMcpOAuth(serverId: number): Promise<boolean> {
  const row = await db.query.mcpServers.findFirst({
    where: eq(mcpServers.id, serverId),
    columns: { authType: true, oauthTokensJson: true },
  });
  if (!row || row.authType !== "oauth") return false;
  const tokens = deserializeOAuthJsonFromDb<OAuthTokens>(row.oauthTokensJson);
  if (isOAuthTokenValid(tokens)) return false;
  broadcastMcpOAuthEvent("mcp:oauth-required", { serverId });
  return true;
}
