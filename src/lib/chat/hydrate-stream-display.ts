import type { InlineTimelineItem } from "@/lib/chat/inline-timeline";
import { buildCompletedStreamThreadFromAssistantContent } from "@/lib/chat/stream-thread";
import { parseAssistantMessageParts } from "@/lib/chat/assistant-message-parts";
import { getToolActivityLabel } from "@/lib/tool-activity-labels";
import type { StreamThreadItem } from "@/lib/chat/stream-thread";

export function buildInlineTimelineFromAssistantContent(
  content: string,
): InlineTimelineItem[] {
  if (!content.trim()) return [];
  const parts = parseAssistantMessageParts(content, false);
  const out: InlineTimelineItem[] = [];
  let ts = 0;
  for (const part of parts) {
    if (part.type === "thought") {
      out.push({
        kind: "thought",
        content: part.content,
        timestamp: ts++,
      });
      continue;
    }
    if (part.type === "tool") {
      const status =
        part.status === "running"
          ? "running"
          : part.status === "error"
            ? "error"
            : "done";
      const detail = part.resultText?.trim();
      out.push({
        kind: "tool",
        id: part.id,
        toolName: part.toolName,
        summary: detail
          ? `${getToolActivityLabel(part.toolName).replace(/…$/u, "")}: ${detail.slice(0, 80)}`
          : getToolActivityLabel(part.toolName).replace(/…$/u, ""),
        detail,
        status,
        timestamp: ts++,
      });
    }
  }
  return out;
}

export function hydrateStreamDisplayForMessages(
  messages: Array<{ id: number; role: string; content: string }>,
): {
  completedThreads: Record<number, StreamThreadItem[]>;
  inlineTimelines: Record<number, InlineTimelineItem[]>;
} {
  const completedThreads: Record<number, StreamThreadItem[]> = {};
  const inlineTimelines: Record<number, InlineTimelineItem[]> = {};

  for (const m of messages) {
    if (m.role !== "assistant" || !m.content?.trim()) continue;
    const thread = buildCompletedStreamThreadFromAssistantContent(m.content);
    if (thread.length > 0) {
      completedThreads[m.id] = thread;
    }
    const timeline = buildInlineTimelineFromAssistantContent(m.content);
    if (timeline.length > 0) {
      inlineTimelines[m.id] = timeline;
    }
  }

  return { completedThreads, inlineTimelines };
}
