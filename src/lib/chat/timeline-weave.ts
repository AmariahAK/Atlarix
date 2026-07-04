/**
 * W7 (v14.8.11) — weave IPC-only thread items into the content-parsed timeline.
 *
 * Compaction/background/plan cards (and interceptor-only tool cards) arrive
 * purely as IPC activity events with NO representation in the assistant
 * content string, so the renderer used to append them as a trailing block —
 * they stuck to the BOTTOM of the message while streaming added more content
 * cards above them. Content parts carry no timestamps, but content TOOL parts
 * can be anchored to their thread twins by (toolName, occurrence); an IPC item
 * whose ts falls STRICTLY between two anchored parts is inserted there.
 * Anything unanchorable falls back to the tail — exactly today's behavior —
 * so a heuristic miss can never render worse than before this fix.
 *
 * Pure functions, renderer-free — unit-tested in isolation.
 */

import type { AssistantMessagePart } from "@/lib/chat/assistant-message-parts";
import type { StreamThreadItem } from "@/lib/chat/stream-thread";
import { compareThreadItems } from "@/lib/chat/stream-thread";

export type WovenEntry =
  | { type: "part"; part: AssistantMessagePart }
  | { type: "thread"; item: StreamThreadItem };

/** Thread kinds that may be woven inline; panels/rounds always stay tail. */
const WEAVABLE_KINDS = new Set<string>(["background", "plan", "tool"]);

export function weaveIpcItemsIntoParts(args: {
  /** Content parts before the sub-agent panel split. */
  before: AssistantMessagePart[];
  /** Content parts after the split (empty when there is no panel). */
  after: AssistantMessagePart[];
  /** The (already display-filtered) IPC-only items to place. */
  items: StreamThreadItem[];
  /** Full thread — the ts source for anchoring content tool parts. */
  anchorsFrom: StreamThreadItem[];
}): {
  before: WovenEntry[];
  after: WovenEntry[];
  tail: StreamThreadItem[];
} {
  const { before, after, items, anchorsFrom } = args;
  const allParts = [...before, ...after];
  const boundary = before.length;

  const asEntries = (parts: AssistantMessagePart[]): WovenEntry[] =>
    parts.map((part) => ({ type: "part" as const, part }));

  if (items.length === 0) {
    return { before: asEntries(before), after: asEntries(after), tail: [] };
  }

  // Anchor content tool parts to thread tool items by (toolName, occurrence).
  const threadTools = anchorsFrom
    .filter((i): i is Extract<StreamThreadItem, { kind: "tool" }> => i.kind === "tool")
    .sort(compareThreadItems);
  const occurrence = new Map<string, number>();
  const anchors: Array<{ partIndex: number; ts: number }> = [];
  for (let i = 0; i < allParts.length; i++) {
    const part = allParts[i]!;
    if (part.type !== "tool") continue;
    const n = occurrence.get(part.toolName) ?? 0;
    occurrence.set(part.toolName, n + 1);
    const twin = threadTools.filter((t) => t.toolName === part.toolName)[n];
    if (twin) anchors.push({ partIndex: i, ts: twin.ts });
  }

  // Two anchored positions are needed to bracket anything.
  const sortedItems = [...items].sort(compareThreadItems);
  const insertionsByPartIndex = new Map<number, StreamThreadItem[]>();
  const tail: StreamThreadItem[] = [];
  for (const item of sortedItems) {
    let placed = false;
    if (WEAVABLE_KINDS.has(item.kind) && anchors.length >= 2) {
      for (let a = 0; a + 1 < anchors.length; a++) {
        const lo = anchors[a]!;
        const hi = anchors[a + 1]!;
        if (item.ts >= lo.ts && item.ts < hi.ts) {
          const list = insertionsByPartIndex.get(hi.partIndex) ?? [];
          list.push(item);
          insertionsByPartIndex.set(hi.partIndex, list);
          placed = true;
          break;
        }
      }
    }
    if (!placed) tail.push(item);
  }

  const weave = (parts: AssistantMessagePart[], offset: number): WovenEntry[] => {
    const out: WovenEntry[] = [];
    for (let i = 0; i < parts.length; i++) {
      const inserts = insertionsByPartIndex.get(offset + i);
      if (inserts) {
        for (const item of inserts) out.push({ type: "thread", item });
      }
      out.push({ type: "part", part: parts[i]! });
    }
    return out;
  };

  return {
    before: weave(before, 0),
    after: weave(after, boundary),
    tail,
  };
}
