import { memo, useContext } from "react";
import { ThreadDiffByCallIdContext } from "./thread-diff-context";
import type { AssistantMessagePart } from "@/lib/chat/assistant-message-parts";
import { isDelegateToolName } from "@/lib/chat/delegate-handoff";
import { persistedToolPartToStreamCard } from "@/lib/chat/persisted-tool-card";
import { StreamToolCallCard } from "./StreamToolCallCard";

/** Persisted / post-stream tool row — same UX as live stream cards. */
function InlineToolPartCardView({
  part,
  olderStep,
}: {
  part: Extract<AssistantMessagePart, { type: "tool" }>;
  /** @deprecated collapse is status-driven */
  defaultCollapsed?: boolean;
  /** When true, delegate/spawn rows are shown only in SubAgentsRoundPanel. */
  suppressDelegateTools?: boolean;
  /** Not one of the turn's last few steps (see StreamToolCallCard). */
  olderStep?: boolean;
}) {
  // A write's whole-file diff from the finished thread beats the one rebuilt
  // from the model's args (its snippets).
  const threadDiff = useContext(ThreadDiffByCallIdContext).get(
    part.callId ?? "",
  );
  if (isDelegateToolName(part.toolName)) {
    return null;
  }

  const card = persistedToolPartToStreamCard(part);
  return (
    <StreamToolCallCard
      summary={card.summary}
      expand={threadDiff ?? card.expand}
      status={card.status}
      toolName={card.toolName}
      resultText={part.resultText}
      olderStep={olderStep}
      mcpServer={
        part.toolName === "mcp_call" &&
        part.args &&
        typeof (part.args as { server?: unknown }).server === "string"
          ? (part.args as { server: string }).server
          : undefined
      }
    />
  );
}

/**
 * Memoised by VALUE. A streaming message is re-parsed on every flush, so each
 * tool part is a new object every time even when nothing about it changed;
 * comparing identity would rebuild every card's expand view (a diff, a command's
 * output) on every tick of a long turn.
 */
export const InlineToolPartCard = memo(
  InlineToolPartCardView,
  (a, b) =>
    a.olderStep === b.olderStep &&
    a.suppressDelegateTools === b.suppressDelegateTools &&
    a.part.id === b.part.id &&
    a.part.callId === b.part.callId &&
    a.part.toolName === b.part.toolName &&
    a.part.status === b.part.status &&
    a.part.resultText === b.part.resultText &&
    a.part.error === b.part.error &&
    a.part.handoff === b.part.handoff &&
    sameArgs(a.part.args, b.part.args),
);

function sameArgs(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
