import type { InlineTimelineItem } from "@/lib/chat/inline-timeline";
import type { StreamThreadItem } from "@/lib/chat/stream-thread";
import type { CompletedTurnThinkingSnapshot } from "@/lib/thinking/extract-thinking-from-content";

export type DisplaySnapshotV1 = {
  version: 1;
  completedThread: StreamThreadItem[];
  inlineTimeline?: InlineTimelineItem[];
  thinking?: CompletedTurnThinkingSnapshot;
};

export function serializeDisplaySnapshot(
  snapshot: DisplaySnapshotV1,
): string {
  return JSON.stringify(snapshot);
}

function isDisplaySnapshotV1(value: unknown): value is DisplaySnapshotV1 {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as DisplaySnapshotV1).version === 1 &&
    Array.isArray((value as DisplaySnapshotV1).completedThread)
  );
}

export function parseDisplaySnapshot(
  raw: string | DisplaySnapshotV1 | null | undefined,
): DisplaySnapshotV1 | null {
  if (raw == null) return null;
  if (isDisplaySnapshotV1(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isDisplaySnapshotV1(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function buildDisplaySnapshotV1(args: {
  completedThread: StreamThreadItem[];
  inlineTimeline?: InlineTimelineItem[];
  thinking?: CompletedTurnThinkingSnapshot | null;
}): DisplaySnapshotV1 | null {
  if (!args.completedThread.length && !args.inlineTimeline?.length) {
    return null;
  }
  return {
    version: 1,
    completedThread: args.completedThread,
    ...(args.inlineTimeline?.length
      ? { inlineTimeline: args.inlineTimeline }
      : {}),
    ...(args.thinking ? { thinking: args.thinking } : {}),
  };
}
