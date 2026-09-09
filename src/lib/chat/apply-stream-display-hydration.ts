import {
  completedStreamThreadByAssistantMessageIdAtom,
  completedTurnThinkingByAssistantMessageIdAtom,
  inlineTimelineByMessageIdAtom,
  interleavedDisplayContentByMessageIdAtom,
} from "@/atoms/chatAtoms";
import {
  buildDisplaySnapshotV1,
  type DisplaySnapshotV1,
} from "@/lib/chat/display-snapshot";
import { hydrateStreamDisplayForMessages } from "@/lib/chat/hydrate-stream-display";
import { getDefaultStore } from "jotai";
import type { Message } from "@/ipc/ipc_types";

/**
 * Fold a snapshot's thinking + interleaved content into the accumulators.
 *
 * Deliberately does NOT touch `completedThreads` or `inlineTimelines`.
 * `hydrateStreamDisplayForMessages` already produced both, and its thread is
 * STRICTLY better: `threadFromSnapshot` merges the sub-agent round recovered from
 * the assistant's raw content into the one stored in the snapshot
 * (`mergeSubAgentRunEntries`), and falls back to the content-derived timeline when
 * the snapshot has none.
 *
 * This function used to recompute a snapshot-only thread and assign it over the top,
 * so that merge was computed and then thrown away on every session load — the
 * sub-agent entries it recovered simply vanished, and the flatten/consolidate pass
 * ran twice per assistant message for the privilege.
 */
function applySnapshotForMessage(
  messageId: number,
  snapshot: DisplaySnapshotV1,
  thinking: Record<
    number,
    import("@/lib/thinking/extract-thinking-from-content").CompletedTurnThinkingSnapshot
  >,
  interleaved: Record<number, string>,
): void {
  if (snapshot.thinking) {
    thinking[messageId] = snapshot.thinking;
  }
  if (snapshot.interleavedContent?.trim()) {
    interleaved[messageId] = snapshot.interleavedContent;
  }
}

/** Restore tool/sub-agent UI atoms after loading messages from SQLite, sessions, or getChat. */
export function applyStreamDisplayHydration(messages: Message[]): void {
  const { completedThreads, inlineTimelines } = hydrateStreamDisplayForMessages(
    messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: String(m.content ?? ""),
      displaySnapshot: m.displaySnapshot ?? null,
    })),
  );

  const thinking: Record<
    number,
    import("@/lib/thinking/extract-thinking-from-content").CompletedTurnThinkingSnapshot
  > = {};
  const interleaved: Record<number, string> = {};

  for (const m of messages) {
    if (m.role !== "assistant" || !m.displaySnapshot) continue;
    applySnapshotForMessage(m.id, m.displaySnapshot, thinking, interleaved);
  }

  if (Object.keys(completedThreads).length > 0) {
    getDefaultStore().set(
      completedStreamThreadByAssistantMessageIdAtom,
      (prev) => ({
        ...prev,
        ...completedThreads,
      }),
    );
  }
  if (Object.keys(inlineTimelines).length > 0) {
    getDefaultStore().set(inlineTimelineByMessageIdAtom, (prev) => ({
      ...prev,
      ...inlineTimelines,
    }));
  }
  if (Object.keys(thinking).length > 0) {
    getDefaultStore().set(
      completedTurnThinkingByAssistantMessageIdAtom,
      (prev) => ({
        ...prev,
        ...thinking,
      }),
    );
  }
  if (Object.keys(interleaved).length > 0) {
    getDefaultStore().set(interleavedDisplayContentByMessageIdAtom, (prev) => ({
      ...prev,
      ...interleaved,
    }));
  }
}

/** Replace hydration state for one chat's assistant messages (session switch / reload). */
export function replaceDisplayHydrationForChat(
  chatId: number,
  messages: Message[],
): void {
  const assistantIds = new Set(
    messages
      .filter((m) => m.chatId === chatId || m.chatId == null)
      .map((m) => m.id),
  );

  getDefaultStore().set(
    completedStreamThreadByAssistantMessageIdAtom,
    (prev) => {
      const next = { ...prev };
      for (const id of Object.keys(next)) {
        const num = Number(id);
        if (assistantIds.has(num)) delete next[num];
      }
      return next;
    },
  );
  getDefaultStore().set(inlineTimelineByMessageIdAtom, (prev) => {
    const next = { ...prev };
    for (const id of Object.keys(next)) {
      const num = Number(id);
      if (assistantIds.has(num)) delete next[num];
    }
    return next;
  });
  getDefaultStore().set(
    completedTurnThinkingByAssistantMessageIdAtom,
    (prev) => {
      const next = { ...prev };
      for (const id of Object.keys(next)) {
        const num = Number(id);
        if (assistantIds.has(num)) delete next[num];
      }
      return next;
    },
  );
  getDefaultStore().set(interleavedDisplayContentByMessageIdAtom, (prev) => {
    const next = { ...prev };
    for (const id of Object.keys(next)) {
      const num = Number(id);
      if (assistantIds.has(num)) delete next[num];
    }
    return next;
  });

  applyStreamDisplayHydration(messages);
}

/** Build snapshot JSON from current atoms for persisting after stream end. */
export function buildDisplaySnapshotPayloadForMessage(
  messageId: number,
  completedThread: import("@/lib/chat/stream-thread").StreamThreadItem[],
  inlineTimeline?: import("@/lib/chat/inline-timeline").InlineTimelineItem[],
  thinking?:
    | import("@/lib/thinking/extract-thinking-from-content").CompletedTurnThinkingSnapshot
    | null,
  interleavedContent?: string | null,
): string | null {
  const snap = buildDisplaySnapshotV1({
    completedThread,
    inlineTimeline,
    thinking,
    interleavedContent,
  });
  if (!snap) return null;
  return JSON.stringify(snap);
}
