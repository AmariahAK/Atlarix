import { useMemo } from "react";
import { useAtomValue } from "jotai";
import type { ActivityStreamItem } from "@/atoms/sourceAtoms";
import {
  completedTurnThinkingByAssistantMessageIdAtom,
  inlineTimelineByMessageIdAtom,
} from "@/atoms/chatAtoms";
import {
  buildInlineTimelineFromActivity,
  type InlineTimelineItem,
} from "@/lib/chat/inline-timeline";
import { InlineThoughtBlock } from "./InlineThoughtBlock";
import { StreamToolCallCard } from "./StreamToolCallCard";
import { InlinePermissionPrompts } from "./InlinePermissionPrompts";

export function MessageActivityTimeline({
  messageId,
  chatId,
  activityItems,
  isStreaming,
}: {
  messageId: number;
  chatId: number;
  activityItems: ActivityStreamItem[];
  isStreaming: boolean;
}) {
  const frozenByMessage = useAtomValue(inlineTimelineByMessageIdAtom);
  const thinkingByMessage = useAtomValue(
    completedTurnThinkingByAssistantMessageIdAtom,
  );

  const items: InlineTimelineItem[] = useMemo(() => {
    const frozen = frozenByMessage[messageId];
    if (frozen?.length) return frozen;
    const thinking = thinkingByMessage[messageId];
    return buildInlineTimelineFromActivity(activityItems, thinking);
  }, [frozenByMessage, messageId, activityItems, thinkingByMessage]);

  if (!items.length && !isStreaming) return null;

  return (
    <div className="mb-2 space-y-0">
      {items.map((item, i) =>
        item.kind === "thought" ? (
          <InlineThoughtBlock
            key={`thought-${i}`}
            content={item.content}
            isStreaming={isStreaming}
          />
        ) : (
          <StreamToolCallCard
            key={item.id || `tool-${i}`}
            summary={item.summary}
            detail={item.detail}
            status={item.status}
            defaultCollapsed={!isStreaming}
          />
        ),
      )}
      {isStreaming ? <InlinePermissionPrompts chatId={chatId} /> : null}
    </div>
  );
}
