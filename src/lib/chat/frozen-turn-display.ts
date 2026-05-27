import type { AgentBusExchange } from "@/atoms/sourceAtoms";
import { parseAssistantMessageParts } from "@/lib/chat/assistant-message-parts";
import type { InlineTimelineItem } from "@/lib/chat/inline-timeline";
import type { CompletedTurnThinkingSnapshot } from "@/lib/thinking/extract-thinking-from-content";
import {
  extractThinkingFromContent,
  hasThinkingSnapshotContent,
} from "@/lib/thinking/extract-thinking-from-content";

/** Thought prose for a completed turn (timeline snap → thinking atom → null). */
export function frozenThoughtContentForTurn(
  timeline: InlineTimelineItem[] | undefined,
  thinking: CompletedTurnThinkingSnapshot | null | undefined,
): string | null {
  if (timeline?.length) {
    const fromTimeline = timeline
      .filter((i): i is Extract<InlineTimelineItem, { kind: "thought" }> =>
        i.kind === "thought",
      )
      .map((i) => i.content)
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (fromTimeline) return fromTimeline;
  }
  if (thinking && hasThinkingSnapshotContent(thinking)) {
    return [
      ...(thinking.thoughts ?? []),
      thinking.reasoningFromTags?.trim(),
      thinking.modelReasoning?.trim(),
    ]
      .filter((x): x is string => Boolean(x && String(x).trim()))
      .join("\n\n");
  }
  return null;
}

/** Extract thought prose from live or final assistant raw content. */
export function extractThoughtContentFromAssistantRaw(
  raw: string,
  options?: { isStreaming?: boolean; busExchanges?: AgentBusExchange[] },
): string | null {
  if (!raw.trim()) return null;
  const snap = extractThinkingFromContent(raw, options);
  const fromSnap = frozenThoughtContentForTurn(undefined, snap);
  if (fromSnap) return fromSnap;
  const parts = parseAssistantMessageParts(raw, options?.isStreaming ?? false);
  const fromParts = parts
    .filter(
      (p): p is Extract<typeof parts[number], { type: "thought" }> =>
        p.type === "thought",
    )
    .map((p) => p.content)
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return fromParts || null;
}

/** Prefer the longest non-empty thought snapshot (live stream vs final raw). */
export function pickBestThoughtContent(
  ...candidates: (string | null | undefined)[]
): string | null {
  let best = "";
  for (const c of candidates) {
    const t = c?.trim();
    if (t && t.length > best.length) best = t;
  }
  return best || null;
}
