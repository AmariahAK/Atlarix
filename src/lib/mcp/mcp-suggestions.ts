/**
 * MCP servers the agent suggests, and what happens when the user connects one.
 *
 * The agent searches the registry (`mcp_servers` search) and suggests a server
 * the task needs (`mcp_servers` suggest). The user sees a card where they work —
 * the app, the editor extension, the Chrome extension — or a prompt in the CLI
 * and plain ACP editors, and connects it there: no trip to the marketplace.
 *
 * WAIT OR CARRY ON — the model's call. With `wait` the tool returns when the
 * user connects or declines (or the turn is stopped). Without it the tool
 * returns at once, and the connection is delivered later like a finished
 * background command: queued for the chat, which is woken to act on it.
 *
 * Status of a server (on, off, needs sign-in, needs a key) is read from the
 * same rows the settings screens use; nothing here is a second source of truth.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { mcpServers } from "@/db/schema";
import { deserializeApiKeyFromDb } from "@/lib/security/db-secrets";
import { oauthConnectedFromRow } from "./oauth-token-utils";
import { listConnectorRows } from "./account-connectors";

// ─── Status ─────────────────────────────────────────────────────────────────

export type McpConnectionNeeds = "sign-in" | "key" | null;

export interface McpServerStatus {
  where: "local" | "account";
  id: number | string;
  name: string;
  enabled: boolean;
  /** What it still needs before it works. */
  needs: McpConnectionNeeds;
  authType: string;
  registryName: string | null;
}

/**
 * Where a server is, by its registry name or its own name: this folder's
 * first (as `mcp_call` resolves), then the account's.
 */
export async function findMcpServer(appId: number | null, nameOrRegistry: string): Promise<McpServerStatus | null> {
  const key = nameOrRegistry.trim().toLowerCase();
  if (!key) return null;
  // A Verified server added by its address (by the agent, or pasted) has no
  // registry name: it is still that server, not one to Connect again (QA).
  const { VERIFIED_MCP_SERVERS } = await import("@/shared/mcp-catalog");
  const norm = (u: string | null | undefined) => (u ?? "").trim().replace(/\/+$/, "").toLowerCase();
  const verifiedUrls = new Set(
    (VERIFIED_MCP_SERVERS.find((v) => v.name.toLowerCase() === key)?.fallback.remotes ?? []).map((r) => norm(r.url)),
  );
  const sameAddress = (url: string | null | undefined) => verifiedUrls.size > 0 && verifiedUrls.has(norm(url));
  if (appId != null) {
    const rows = await db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.scope, "workspace"), eq(mcpServers.appId, appId)));
    const row =
      rows.find((r) => r.registryId?.toLowerCase() === key) ??
      rows.find((r) => r.name.toLowerCase() === key) ??
      rows.find((r) => sameAddress(r.url));
    if (row) {
      const needs: McpConnectionNeeds =
        row.authType === "oauth" && !oauthConnectedFromRow(row)
          ? "sign-in"
          : row.authType === "api_key" && !deserializeApiKeyFromDb(row.apiKey)?.trim()
            ? "key"
            : null;
      return {
        where: "local",
        id: row.id,
        name: row.name,
        enabled: !!row.enabled,
        needs,
        authType: row.authType,
        registryName: row.registryId ?? null,
      };
    }
  }
  const account = (await listConnectorRows()) ?? [];
  const c =
    account.find((r) => r.registryName?.toLowerCase() === key) ??
    account.find((r) => r.name.toLowerCase() === key) ??
    account.find((r) => sameAddress(r.url));
  if (!c) return null;
  return {
    where: "account",
    id: c.id,
    name: c.name,
    enabled: c.enabled,
    needs: c.connected ? null : c.authType === "oauth" ? "sign-in" : c.authType === "none" ? null : "key",
    authType: c.authType,
    registryName: c.registryName,
  };
}

/**
 * What the model is told when a server waits on the user: a card is up, and it
 * hears back like a finished background task, so it ends its turn rather than
 * sending them to the website or asking them to say "try again" (owner).
 */
export function waitingOnUserNote(name: string): string {
  return `The user has a card to connect "${name}". You will be told when they connect it, like a finished background task, so end your turn here.`;
}

// ─── Suggestions ────────────────────────────────────────────────────────────

export interface McpSuggestion {
  id: string;
  chatId: number;
  appId: number | null;
  /** Registry name (`app.linear/linear`) or the name of a server already added. */
  server: string;
  title: string;
  /** Why the agent wants it, in its words. */
  reason: string;
  /** The model is waiting on the answer. */
  wait: boolean;
  createdAt: number;
}

export type McpSuggestionOutcome =
  | { connected: true; server: string; where: "local" | "account"; tools?: string[] }
  | { connected: false; reason: string };

const pending = new Map<string, McpSuggestion>();
const waiters = new Map<string, (o: McpSuggestionOutcome) => void>();

type Listener = (ev: { type: "added" | "resolved"; suggestion: McpSuggestion; outcome?: McpSuggestionOutcome }) => void;
let listener: Listener | null = null;

/** An extra observer (tests). Surfaces are told by `broadcast` below either way. */
export function setMcpSuggestionListener(fn: Listener): void {
  listener = fn;
}

/** A suggestion with what a card shows: the catalog entry and where the server stands. */
export async function describeMcpSuggestion(s: McpSuggestion) {
  const { getMcpCatalogEntry } = await import("./registry-catalog");
  const [status, entry] = await Promise.all([
    findMcpServer(s.appId, s.server).catch(() => null),
    getMcpCatalogEntry(s.server).catch(() => null),
  ]);
  return { ...s, entry, status };
}

/**
 * Tell every surface a card came or went: app windows, and the CLI and ACP
 * sessions (the Electron stub routes broadcasts to them). Done here, not by a
 * listener the IPC host registers, because a plain ACP session never loads
 * the MCP handlers — its cards went nowhere (QA).
 */
function broadcast(type: "added" | "resolved", suggestion: McpSuggestion, outcome?: McpSuggestionOutcome): void {
  void (async () => {
    try {
      const { broadcastToAllWindows } = await import("@/ipc/utils/broadcast_all_windows");
      const payload = type === "added" ? await describeMcpSuggestion(suggestion) : suggestion;
      broadcastToAllWindows("mcp:suggestion", {
        type,
        chatId: suggestion.chatId,
        suggestion: payload,
        ...(outcome ? { outcome } : {}),
      });
    } catch {
      // No window and no session to tell (tests): nothing to do.
    }
  })();
}

export function addMcpSuggestion(s: Omit<McpSuggestion, "id" | "createdAt">): McpSuggestion {
  // One card per server per chat: asking again replaces the earlier one.
  for (const [id, old] of pending) {
    if (old.chatId === s.chatId && old.server.toLowerCase() === s.server.toLowerCase()) {
      resolveMcpSuggestion(id, { connected: false, reason: "replaced by a newer suggestion" });
    }
  }
  const suggestion: McpSuggestion = { ...s, id: randomUUID(), createdAt: Date.now() };
  pending.set(suggestion.id, suggestion);
  listener?.({ type: "added", suggestion });
  broadcast("added", suggestion);
  return suggestion;
}

/** Wait for the user's answer; a stopped turn answers "declined". */
export function waitForMcpSuggestion(id: string, signal?: AbortSignal): Promise<McpSuggestionOutcome> {
  return new Promise((resolve) => {
    if (!pending.has(id)) return resolve({ connected: false, reason: "it is no longer pending" });
    const onAbort = () => resolveMcpSuggestion(id, { connected: false, reason: "the turn was stopped" });
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    waiters.set(id, (o) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(o);
    });
  });
}

export function listMcpSuggestions(chatId?: number): McpSuggestion[] {
  return [...pending.values()].filter((s) => chatId == null || s.chatId === chatId);
}

/**
 * The user answered a card (or it was replaced or stopped). A model that is
 * waiting gets the answer as its tool result; otherwise a connection is
 * queued for the chat and wakes it, and a "not now" is only noted.
 */
export function resolveMcpSuggestion(id: string, outcome: McpSuggestionOutcome): boolean {
  const s = pending.get(id);
  if (!s) return false;
  pending.delete(id);
  listener?.({ type: "resolved", suggestion: s, outcome });
  broadcast("resolved", s, outcome);
  const waiter = waiters.get(id);
  if (waiter) {
    waiters.delete(id);
    waiter(outcome);
    return true;
  }
  if (outcome.connected) {
    recordMcpConnectResult(s.chatId, {
      server: outcome.server,
      where: outcome.where,
      tools: outcome.tools ?? [],
    });
  }
  return true;
}

/** For tests. */
export function clearMcpSuggestionsForTests(): void {
  pending.clear();
  waiters.clear();
}

// ─── Connections delivered to the agent, like finished background work ─────

interface McpConnectResult {
  server: string;
  where: "local" | "account";
  tools: string[];
  at: number;
}

const results = new Map<number, McpConnectResult[]>();
let wakeNotifier: ((chatId: number, ev: { server: string; status: "finished" }) => void) | null = null;

/** Set by the IPC host: the same `chat:background-job-update` wake as sub-agents. */
export function setMcpConnectNotifier(fn: (chatId: number, ev: { server: string; status: "finished" }) => void): void {
  wakeNotifier = fn;
}

export function recordMcpConnectResult(chatId: number, r: Omit<McpConnectResult, "at">): void {
  const list = results.get(chatId) ?? [];
  list.push({ ...r, at: Date.now() });
  results.set(chatId, list.slice(-10));
  wakeNotifier?.(chatId, { server: r.server, status: "finished" });
}

export function hasPendingMcpConnectResults(chatId: number): boolean {
  return (results.get(chatId)?.length ?? 0) > 0;
}

/** Take-once, like every other background result. */
export function takePendingMcpConnectResults(chatId: number): string | null {
  const list = results.get(chatId);
  if (!list?.length) return null;
  results.delete(chatId);
  return [
    "The user connected an MCP server you suggested. It is ready to use with mcp_call.",
    ...list.map(
      (r) =>
        `MCP SERVER "${r.server}" connected (${r.where === "account" ? "on their account" : "on this computer"})` +
        (r.tools.length ? `: ${r.tools.slice(0, 40).join(", ")}${r.tools.length > 40 ? ", …" : ""}` : ""),
    ),
  ].join("\n");
}

export function describePendingMcpConnectResults(chatId: number): string[] {
  return (results.get(chatId) ?? []).map((r) => `${r.server} connected`);
}
