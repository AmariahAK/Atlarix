import type { InlineTimelineItem } from "@/lib/chat/inline-timeline";
import { parseAssistantMessageParts } from "@/lib/chat/assistant-message-parts";
import { getToolActivityLabel } from "@/lib/tool-activity-labels";
import type { StreamThreadItem } from "@/lib/chat/stream-thread";
import type { DisplaySnapshotV1 } from "@/lib/chat/display-snapshot";
import { flattenToolGroupsInThread } from "@/lib/chat/group-stream-tools";
import {
  buildCompletedStreamThreadFromAssistantContent,
  consolidateSubagentRoundsInThread,
  mergeSubAgentRunEntries,
} from "@/lib/chat/stream-thread";

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

function threadFromSnapshot(
  snapshot: DisplaySnapshotV1,
  assistantContent?: string,
): StreamThreadItem[] {
  let thread = flattenToolGroupsInThread(
    consolidateSubagentRoundsInThread(snapshot.completedThread),
  );
  if (!assistantContent?.trim()) return thread;

  const fromContent =
    buildCompletedStreamThreadFromAssistantContent(assistantContent);
  const snapshotRound = thread.find((i) => i.kind === "subagent_round");
  const contentRound = fromContent.find((i) => i.kind === "subagent_round");
  if (snapshotRound && contentRound) {
    const mergedAgents = mergeSubAgentRunEntries(
      snapshotRound.agents,
      contentRound.agents,
    );
    thread = thread.map((item) =>
      item.kind === "subagent_round" ? { ...item, agents: mergedAgents } : item,
    );
  } else if (!snapshotRound && contentRound) {
    thread = [...thread, contentRound];
  }
  return thread;
}

export function hydrateStreamDisplayForMessages(
  messages: Array<{
    id: number;
    role: string;
    content: string;
    displaySnapshot?: DisplaySnapshotV1 | null;
  }>,
): {
  completedThreads: Record<number, StreamThreadItem[]>;
  inlineTimelines: Record<number, InlineTimelineItem[]>;
} {
  const completedThreads: Record<number, StreamThreadItem[]> = {};
  const inlineTimelines: Record<number, InlineTimelineItem[]> = {};

  for (const m of messages) {
    if (m.role !== "assistant" || !m.content?.trim()) continue;

    if (m.displaySnapshot) {
      const thread = threadFromSnapshot(m.displaySnapshot, m.content);
      if (thread.length > 0) {
        completedThreads[m.id] = thread;
      }
      const timeline =
        m.displaySnapshot.inlineTimeline ??
        buildInlineTimelineFromAssistantContent(m.content);
      if (timeline.length > 0) {
        inlineTimelines[m.id] = timeline;
      }
      continue;
    }

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
