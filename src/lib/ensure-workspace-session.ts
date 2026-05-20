import { getDefaultStore } from "jotai";
import { IpcClient } from "@/ipc/ipc_client";
import {
  activeWorkspaceSessionIdAtom,
  chatIdToSessionIdAtom,
  loadedSessionResumeAtom,
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

  const session = await IpcClient.getInstance().createWorkspaceSession(workspaceAppId);
  store.set(activeWorkspaceSessionIdAtom, session.id);
  store.set(chatIdToSessionIdAtom, (prev) => {
    const next = new Map(prev);
    next.set(chatId, session.id);
    return next;
  });
  store.set(loadedSessionResumeAtom, false);
  store.set(workspaceSessionsRefreshAtom, (n) => n + 1);
  return session.id;
}
