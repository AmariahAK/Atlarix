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
  lastTurnCostUsdByChatIdAtom,
  pendingUserQuestionByChatIdAtom,
  livePlanUpdateByAssistantMessageIdAtom,
  planSnapshotByAssistantMessageIdAtom,
  completedTurnThinkingByAssistantMessageIdAtom,
  inlineTimelineByMessageIdAtom,
  interleavedDisplayContentByMessageIdAtom,
  completedStreamThreadByAssistantMessageIdAtom,
  sourcesByAssistantMessageIdAtom,
  streamThreadByChatIdAtom,
  streamLastActivityAtByChatIdAtom,
  evictedChatIdsAtom,
  messagesForChatAtom,
  isStreamingForChatAtom,
  streamThreadForChatAtom,
  activityStreamItemsForChatAtom,
  completedStreamThreadForMessageAtom,
  inlineTimelineForMessageAtom,
  completedTurnThinkingForMessageAtom,
  interleavedDisplayContentForMessageAtom,
  sourcesForMessageAtom,
  waitingOnCommandByChatIdAtom,
  pendingInterjectionsByChatIdAtom,
  turnSnapshotTurnIdByMessageIdAtom,
  activeChatIdAtom,
  selectedChatIdAtom,
} from "@/atoms/chatAtoms";
import { clearActivityForChatInStore } from "./activity-stream";

/**
 * v12 (TODO 2.4): renderer memory-leak cleanup — the per-chat jotai maps were
 * never pruned on session delete, leaking message arrays, stream threads and
 * plan/thinking snapshots after 100+ deleted chats. Call this from the delete
 * flow with the session's transport chatId.
 *
 * v14.36.0: also used to EVICT a cold-but-living chat (`reason: "evicted"`).
 * Until then both callers were terminal — a deleted session and a brand-new one —
 * so nothing exercised the case where the chat comes back. Two things follow from
 * that, and both are handled below: the active/selected ids must be left alone
 * (a cold chat is by definition not the active one, so clearing them would blank
 * the screen the user is looking at), and the chat must be RECORDED as evicted so
 * activation knows to reload it rather than trusting whatever a background stream
 * happens to have put back.
 */
export function clearChatAtomsForChat(
  chatId: number,
  opts?: { reason?: "deleted" | "evicted" },
): void {
  const store = getDefaultStore();
  const evicting = opts?.reason === "evicted";

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
  store.set(turnSnapshotTurnIdByMessageIdAtom, (prev) => {
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
  // Was missing from the original v12 list, so it leaked on session DELETE too —
  // and it is not a small one: this holds the fully rendered body of every
  // assistant turn, which is the largest per-message string we keep.
  deleteMessageKeyedRecord(interleavedDisplayContentByMessageIdAtom);

  // Chat-id-keyed state.
  deleteMapKey(chatMessagesByIdAtom);
  deleteMapKey(chatErrorByIdAtom);
  deleteMapKey(isStreamingByIdAtom);
  deleteMapKey(chatStreamCountByIdAtom);
  deleteMapKey(streamThreadByChatIdAtom);
  deleteMapKey(streamLastActivityAtByChatIdAtom);
  deleteMapKey(waitingOnCommandByChatIdAtom);
  deleteMapKey(pendingInterjectionsByChatIdAtom);
  deleteRecordKey(lastTurnHadToolCallsByChatIdAtom);
  deleteRecordKey(lastReasoningTokensByChatIdAtom);
  deleteRecordKey(lastAuxTokensByChatIdAtom);
  deleteRecordKey(lastTurnCostUsdByChatIdAtom);
  deleteRecordKey(pendingUserQuestionByChatIdAtom);

  store.set(recentStreamChatIdsAtom, (prev) => {
    if (!prev.has(chatId)) return prev;
    const next = new Set(prev);
    next.delete(chatId);
    return next;
  });

  // Drop the atomFamily entries too. `atomFamily` caches one derived atom per
  // key FOR EVER, so without this an eviction frees the data and keeps a wrapper
  // atom per chat — and, worse, one per message id, which is the larger of the
  // two leaks on a long session.
  messagesForChatAtom.remove(chatId);
  isStreamingForChatAtom.remove(chatId);
  streamThreadForChatAtom.remove(chatId);
  activityStreamItemsForChatAtom.remove(chatId);
  for (const id of messageIds) {
    completedStreamThreadForMessageAtom.remove(id);
    inlineTimelineForMessageAtom.remove(id);
    completedTurnThinkingForMessageAtom.remove(id);
    interleavedDisplayContentForMessageAtom.remove(id);
    sourcesForMessageAtom.remove(id);
  }

  if (evicting) {
    // A cold chat is not the active one, so the ids are left exactly as they are:
    // nulling them here would blank the session the user is actually looking at.
    store.set(evictedChatIdsAtom, (prev) => {
      if (prev.has(chatId)) return prev;
      const next = new Set(prev);
      next.add(chatId);
      return next;
    });
  } else {
    if (store.get(activeChatIdAtom) === chatId) store.set(activeChatIdAtom, null);
    if (store.get(selectedChatIdAtom) === chatId) {
      store.set(selectedChatIdAtom, null);
    }
    // A deleted chat can never come back, so it must not linger in the evicted
    // set — that would be a slow leak of exactly the kind this function exists
    // to prevent, and would make a reused chat id reload for no reason.
    store.set(evictedChatIdsAtom, (prev) => {
      if (!prev.has(chatId)) return prev;
      const next = new Set(prev);
      next.delete(chatId);
      return next;
    });
  }

  clearActivityForChatInStore(chatId);
}

/** Forget an eviction — the chat has been genuinely reloaded from the DB. */
export function markChatRehydrated(chatId: number): void {
  getDefaultStore().set(evictedChatIdsAtom, (prev) => {
    if (!prev.has(chatId)) return prev;
    const next = new Set(prev);
    next.delete(chatId);
    return next;
  });
}

/** True when this chat's renderer state was evicted and not yet reloaded. */
export function isChatEvicted(chatId: number): boolean {
  return getDefaultStore().get(evictedChatIdsAtom).has(chatId);
}
