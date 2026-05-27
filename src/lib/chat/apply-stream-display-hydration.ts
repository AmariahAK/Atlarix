import {
  completedStreamThreadByAssistantMessageIdAtom,
  inlineTimelineByMessageIdAtom,
} from "@/atoms/chatAtoms";
import { hydrateStreamDisplayForMessages } from "@/lib/chat/hydrate-stream-display";
import { getDefaultStore } from "jotai";
import type { Message } from "@/ipc/ipc_types";

/** Restore tool/sub-agent UI atoms after loading messages from SQLite or getChat. */
export function applyStreamDisplayHydration(messages: Message[]): void {
  const { completedThreads, inlineTimelines } = hydrateStreamDisplayForMessages(
    messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: String(m.content ?? ""),
    })),
  );

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
}
