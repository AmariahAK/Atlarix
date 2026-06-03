import { getDefaultStore } from "jotai";
import { IpcClient } from "@/ipc/ipc_client";
import { activeChatIdAtom } from "@/atoms/chatAtoms";
import {
  activeWorkspaceSessionIdAtom,
  chatIdToSessionIdAtom,
  loadedSessionResumeAtom,
  sessionIdToChatIdAtom,
  workspaceSessionsRefreshAtom,
} from "@/atoms/sessionAtoms";

/**
 * Resolve the SQLite session id for persisting workspace chat messages.
 * Creates a new session when this ephemeral chat has no mapping yet.
 */
export async function ensureWorkspaceSessionForChat(
  workspaceAppId: number,
  chatId: number,
): Promise<string | null> {
  const store = getDefaultStore();
  const chatMap = store.get(chatIdToSessionIdAtom);
  const existing = chatMap.get(chatId);
  if (existing) {
    return existing;
  }

  const sessionId =
    await IpcClient.getInstance().resolveWorkspaceSessionForTransport(
      chatId,
      workspaceAppId,
    );
  store.set(chatIdToSessionIdAtom, (prev) => {
    const next = new Map(prev);
    next.set(chatId, sessionId);
    return next;
  });
  store.set(sessionIdToChatIdAtom, (prev) => {
    const next = new Map(prev);
    next.set(sessionId, chatId);
    return next;
  });
  if (store.get(activeChatIdAtom) === chatId) {
    store.set(activeWorkspaceSessionIdAtom, sessionId);
    store.set(loadedSessionResumeAtom, false);
  }
  store.set(workspaceSessionsRefreshAtom, (n) => n + 1);
  return sessionId;
}
