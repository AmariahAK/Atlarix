/**
 * Per-chat workspace binding — workspace context is fixed on the first stream
 * for a chat and is not changed when the user adds a workspace mid-thread.
 */

import { getDefaultStore } from "jotai";
import {
  chatBoundAppIdByChatIdAtom,
  pendingWorkspaceAppIdAtom,
  selectedAppIdAtom,
  selectedWorkspaceInfoAtom,
} from "@/atoms/appAtoms";

export type WorkspaceAttachInfo = {
  name: string;
  path?: string;
};

/** `null` = not yet bound for this chat in this session. */
export function getChatBoundAppId(chatId: number): number | undefined | null {
  const map = getDefaultStore().get(chatBoundAppIdByChatIdAtom);
  if (!map.has(chatId)) return null;
  return map.get(chatId);
}

export function bindChatToAppId(
  chatId: number,
  appId: number | undefined,
): void {
  getDefaultStore().set(chatBoundAppIdByChatIdAtom, (prev) => {
    const next = new Map(prev);
    next.set(chatId, appId);
    return next;
  });
}

/**
 * Workspace app id for UI (mode picker, context line, message edit chrome).
 * Bound chat wins; otherwise falls back to global selected workspace.
 */
export function resolveChatWorkspaceAppId(
  chatId: number | null | undefined,
): number | null {
  if (chatId != null) {
    const bound = getChatBoundAppId(chatId);
    if (bound !== null) {
      return bound ?? null;
    }
  }
  return getDefaultStore().get(selectedAppIdAtom) ?? null;
}

/** Sync global workspace selection and per-chat binding (session resume, new conversation). */
export function attachWorkspaceToChat(
  chatId: number,
  appId: number,
  info?: WorkspaceAttachInfo,
): void {
  const store = getDefaultStore();
  bindChatToAppId(chatId, appId);
  store.set(pendingWorkspaceAppIdAtom, null);
  store.set(selectedAppIdAtom, appId);
  if (info) {
    store.set(selectedWorkspaceInfoAtom, {
      id: appId,
      name: info.name,
      path: info.path,
    });
  }
}

/** App id to send on stream IPC — bound on first use. */
export function resolveStreamAppId(chatId: number): number | undefined {
  const existing = getChatBoundAppId(chatId);
  if (existing !== null) {
    return existing;
  }
  const selected = getDefaultStore().get(selectedAppIdAtom) ?? undefined;
  bindChatToAppId(chatId, selected);
  return selected;
}

/** True when this chat already has user content without a workspace binding. */
export function shouldDeferWorkspaceToNextChat(
  chatId: number | null | undefined,
  hasUserMessageInThread: boolean,
): boolean {
  if (chatId == null || !hasUserMessageInThread) return false;
  const bound = getChatBoundAppId(chatId);
  return bound === null || bound === undefined;
}
