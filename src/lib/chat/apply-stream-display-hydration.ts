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
import { flattenToolGroupsInThread } from "@/lib/chat/group-stream-tools";
import { consolidateSubagentRoundsInThread } from "@/lib/chat/stream-thread";
import { getDefaultStore } from "jotai";
import type { Message } from "@/ipc/ipc_types";

function applySnapshotForMessage(
  messageId: number,
  snapshot: DisplaySnapshotV1,
  completedThreads: Record<number, import("@/lib/chat/stream-thread").StreamThreadItem[]>,
  inlineTimelines: Record<number, import("@/lib/chat/inline-timeline").InlineTimelineItem[]>,
  thinking: Record<number, import("@/lib/thinking/extract-thinking-from-content").CompletedTurnThinkingSnapshot>,
  interleaved: Record<number, string>,
): void {
  const thread = flattenToolGroupsInThread(
    consolidateSubagentRoundsInThread(snapshot.completedThread),
  );
  if (thread.length > 0) {
    completedThreads[messageId] = thread;
  }
  if (snapshot.inlineTimeline?.length) {
    inlineTimelines[messageId] = snapshot.inlineTimeline;
  }
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
    applySnapshotForMessage(
      m.id,
      m.displaySnapshot,
      completedThreads,
      inlineTimelines,
      thinking,
      interleaved,
    );
  }

  if (Object.keys(completedThreads).length > 0) {
    getDefaultStore().set(completedStreamThreadByAssistantMessageIdAtom, (prev) => ({
      ...prev,
      ...completedThreads,
    }));
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
    messages.filter((m) => m.chatId === chatId || m.chatId == null).map((m) => m.id),
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
  getDefaultStore().set(completedTurnThinkingByAssistantMessageIdAtom, (prev) => {
    const next = { ...prev };
    for (const id of Object.keys(next)) {
      const num = Number(id);
      if (assistantIds.has(num)) delete next[num];
    }
    return next;
  });
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
  thinking?: import("@/lib/thinking/extract-thinking-from-content").CompletedTurnThinkingSnapshot | null,
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
