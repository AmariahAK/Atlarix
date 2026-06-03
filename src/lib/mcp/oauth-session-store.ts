import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpOAuthLoopbackServer } from "./oauth-loopback-server";

export type PendingMcpOAuthSession = {
  serverId: number;
  serverName: string;
  state: string;
  redirectUrl: string;
  codeVerifier?: string;
  transport: StreamableHTTPClientTransport;
  loopback?: McpOAuthLoopbackServer;
  scope?: string;
  startedAt: number;
  timeoutId?: ReturnType<typeof setTimeout>;
};

const pendingByServerId = new Map<number, PendingMcpOAuthSession>();
const pendingByState = new Map<string, number>();

export function getPendingMcpOAuthSession(
  serverId: number,
): PendingMcpOAuthSession | undefined {
  return pendingByServerId.get(serverId);
}

export function getPendingMcpOAuthSessionByState(
  state: string,
): PendingMcpOAuthSession | undefined {
  const serverId = pendingByState.get(state);
  if (serverId == null) return undefined;
  return pendingByServerId.get(serverId);
}

export function setPendingMcpOAuthSession(session: PendingMcpOAuthSession): void {
  const existing = pendingByServerId.get(session.serverId);
  if (existing?.timeoutId) clearTimeout(existing.timeoutId);
  pendingByServerId.set(session.serverId, session);
  pendingByState.set(session.state, session.serverId);
}

export function clearPendingMcpOAuthSession(serverId: number): void {
  const existing = pendingByServerId.get(serverId);
  if (!existing) return;
  if (existing.timeoutId) clearTimeout(existing.timeoutId);
  existing.loopback?.close();
  pendingByState.delete(existing.state);
  pendingByServerId.delete(serverId);
}

export function clearAllPendingMcpOAuthSessions(): void {
  for (const session of pendingByServerId.values()) {
    if (session.timeoutId) clearTimeout(session.timeoutId);
    session.loopback?.close();
  }
  pendingByServerId.clear();
  pendingByState.clear();
}
