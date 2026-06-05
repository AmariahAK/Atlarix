import { getDefaultStore } from "jotai";
import {
  chatMessagesByIdAtom,
  chatErrorByIdAtom,
  isStreamingByIdAtom,
  chatStreamCountByIdAtom,
  recentStreamChatIdsAtom,
  lastTurnHadToolCallsByChatIdAtom,
  lastReasoningTokensByChatIdAtom,
  lastAuxTokensByChatIdAtom,
  pendingUserQuestionByChatIdAtom,
  livePlanUpdateByAssistantMessageIdAtom,
  planSnapshotByAssistantMessageIdAtom,
  completedTurnThinkingByAssistantMessageIdAtom,
  inlineTimelineByMessageIdAtom,
  completedStreamThreadByAssistantMessageIdAtom,
  sourcesByAssistantMessageIdAtom,
  streamThreadByChatIdAtom,
  streamLastActivityAtByChatIdAtom,
  streamSlowWarningByChatIdAtom,
  activeChatIdAtom,
  selectedChatIdAtom,
} from "@/atoms/chatAtoms";
import { clearActivityForChatInStore } from "./activity-stream";

/**
 * v12 (TODO 2.4): renderer memory-leak cleanup — the per-chat jotai maps were
 * never pruned on session delete, leaking message arrays, stream threads and
 * plan/thinking snapshots after 100+ deleted chats. Call this from the delete
 * flow with the session's transport chatId.
 */
export function clearChatAtomsForChat(chatId: number): void {
  const store = getDefaultStore();

  // Per-assistant-message atoms are keyed by message id — collect this chat's
  // message ids BEFORE dropping the message list.
  const messageIds = new Set(
    (store.get(chatMessagesByIdAtom).get(chatId) ?? []).map((m) => m.id),
  );

  const deleteMapKey = <V>(a: any) => {
    store.set(a, (prev: Map<number, V>) => {
      if (!prev.has(chatId)) return prev;
      const next = new Map(prev);
      next.delete(chatId);
      return next;
    });
  };
  const deleteRecordKey = (a: any) => {
    store.set(a, (prev: Record<number, unknown>) => {
      if (!(chatId in prev)) return prev;
      const { [chatId]: _gone, ...rest } = prev;
      return rest;
    });
  };
  const deleteMessageKeyedRecord = (a: any) => {
    if (messageIds.size === 0) return;
    store.set(a, (prev: Record<number, unknown>) => {
      const keys = Object.keys(prev).map(Number).filter((k) => messageIds.has(k));
      if (keys.length === 0) return prev;
      const next = { ...prev };
      for (const k of keys) delete next[k];
      return next;
    });
  };

  // Message-id-keyed snapshots first (need messageIds computed above).
  store.set(livePlanUpdateByAssistantMessageIdAtom, (prev) => {
    const keys = [...prev.keys()].filter((k) => messageIds.has(k));
    if (keys.length === 0) return prev;
    const next = new Map(prev);
    for (const k of keys) next.delete(k);
    return next;
  });
  deleteMessageKeyedRecord(planSnapshotByAssistantMessageIdAtom);
  deleteMessageKeyedRecord(completedTurnThinkingByAssistantMessageIdAtom);
  deleteMessageKeyedRecord(inlineTimelineByMessageIdAtom);
  deleteMessageKeyedRecord(completedStreamThreadByAssistantMessageIdAtom);
  deleteMessageKeyedRecord(sourcesByAssistantMessageIdAtom);

  // Chat-id-keyed state.
  deleteMapKey(chatMessagesByIdAtom);
  deleteMapKey(chatErrorByIdAtom);
  deleteMapKey(isStreamingByIdAtom);
  deleteMapKey(chatStreamCountByIdAtom);
  deleteMapKey(streamThreadByChatIdAtom);
  deleteMapKey(streamLastActivityAtByChatIdAtom);
  deleteMapKey(streamSlowWarningByChatIdAtom);
  deleteRecordKey(lastTurnHadToolCallsByChatIdAtom);
  deleteRecordKey(lastReasoningTokensByChatIdAtom);
  deleteRecordKey(lastAuxTokensByChatIdAtom);
  deleteRecordKey(pendingUserQuestionByChatIdAtom);

  store.set(recentStreamChatIdsAtom, (prev) => {
    if (!prev.has(chatId)) return prev;
    const next = new Set(prev);
    next.delete(chatId);
    return next;
  });

  if (store.get(activeChatIdAtom) === chatId) store.set(activeChatIdAtom, null);
  if (store.get(selectedChatIdAtom) === chatId) {
    store.set(selectedChatIdAtom, null);
  }

  clearActivityForChatInStore(chatId);
}
