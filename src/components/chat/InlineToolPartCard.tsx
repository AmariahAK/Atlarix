import type { AssistantMessagePart } from "@/lib/chat/assistant-message-parts";
import { isDelegateToolName } from "@/lib/chat/delegate-handoff";
import { persistedToolPartToStreamCard } from "@/lib/chat/persisted-tool-card";
import { SubAgentCard } from "./subagent/SubAgentCard";
import { StreamToolCallCard } from "./StreamToolCallCard";

/** Persisted / post-stream tool row — same UX as live stream cards. */
export function InlineToolPartCard({
  part,
  suppressDelegateTools = false,
}: {
  part: Extract<AssistantMessagePart, { type: "tool" }>;
  /** @deprecated collapse is status-driven */
  defaultCollapsed?: boolean;
  /** When true, delegate/spawn rows are shown only in SubAgentsRoundPanel. */
  suppressDelegateTools?: boolean;
}) {
  if (suppressDelegateTools && isDelegateToolName(part.toolName)) {
    return null;
  }

  if (part.handoff && isDelegateToolName(part.toolName)) {
    return (
      <SubAgentCard
        agentType={part.handoff.agentRole}
        scope={part.handoff.scope}
        summary={part.handoff.summary}
        status={part.status === "error" ? "error" : "done"}
      />
    );
  }

  const card = persistedToolPartToStreamCard(part);
  return (
    <StreamToolCallCard
      summary={card.summary}
      expand={card.expand}
      status={card.status}
      toolName={card.toolName}
    />
  );
}
