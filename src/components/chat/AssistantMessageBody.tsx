import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAtomValue } from "jotai";
import { activeChatIdAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";
import {
  extractVisibleAnswerMarkdown,
  isOnlyToolDebris,
  sanitizeMarkdownForDisplay,
} from "@/lib/chat/answer-display";
import {
  parseAssistantMessageParts,
  type AssistantMessagePart,
} from "@/lib/chat/assistant-message-parts";
import type { PlanCardData } from "@/lib/plan-cards/plan-card-renderer";
import { AtlarixMarkdownSegment } from "./AtlarixMarkdownSegment";
import { InlineThoughtBlock } from "./InlineThoughtBlock";
import { InlinePlanArtifactSlot } from "./InlinePlanArtifactSlot";
import { InlineToolPartCard } from "./InlineToolPartCard";
import { InlineContextToolGroup } from "./InlineContextToolGroup";
import { InlinePermissionPrompts } from "./InlinePermissionPrompts";
import { InlineCounselSection } from "./InlineCounselSection";
import { groupAssistantDisplayParts } from "@/lib/chat/display-parts-group";
import {
  customLink,
  markdownTableComponents,
  renderTextWithPathMentions,
} from "./AtlarixMarkdownParser";
import { CodeHighlight } from "./CodeHighlight";
import { activityStreamItemsAtom } from "@/atoms/sourceAtoms";

export function AssistantMessageBody({
  content,
  isStreaming,
  assistantMessageId,
  chatId: chatIdProp,
  onPlanSwitchToBuild: _onPlanSwitchToBuild,
  onPlanArtifactBuild,
  planArtifactBuildDisabled,
}: {
  content: string;
  isStreaming: boolean;
  assistantMessageId?: number;
  chatId?: number | null;
  onPlanSwitchToBuild?: (autoMessage: string, planData: PlanCardData) => void;
  onPlanArtifactBuild?: (planId: string) => void;
  planArtifactBuildDisabled?: boolean;
}) {
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const activeChatId = useAtomValue(activeChatIdAtom);
  const chatId = chatIdProp ?? activeChatId ?? selectedChatId;
  const activityItems = useAtomValue(activityStreamItemsAtom);

  const parts = useMemo(
    () => parseAssistantMessageParts(content, isStreaming),
    [content, isStreaming],
  );

  const answerFallback = useMemo(() => {
    const raw = extractVisibleAnswerMarkdown(content);
    return sanitizeMarkdownForDisplay(raw);
  }, [content]);

  const hasThoughtOrTool = parts.some(
    (p) => p.type === "thought" || p.type === "tool",
  );

  const hasVisibleParts = parts.some(
    (p) =>
      p.type === "thought" ||
      p.type === "tool" ||
      p.type === "plan_artifact" ||
      (p.type === "markdown" && p.content.trim().length > 0),
  );

  const showFallback =
    answerFallback.length > 0 &&
    !isOnlyToolDebris(answerFallback) &&
    !isOnlyToolDebris(content) &&
    !hasThoughtOrTool &&
    !hasVisibleParts;

  const counselItems = useMemo(() => {
    if (isStreaming && chatId != null) {
      return activityItems.filter((i) => i.chatId == null || i.chatId === chatId);
    }
    return [];
  }, [activityItems, chatId, isStreaming]);

  const displayItems = useMemo(
    () => groupAssistantDisplayParts(parts),
    [parts],
  );

  const firstMarkdownIdx = useMemo(
    () => displayItems.findIndex(
      (item) => item.kind === "item" && item.part.type === "markdown",
    ),
    [displayItems],
  );

  return (
    <>
      {displayItems.map((item, index) => (
        <React.Fragment key={displayItemKey(item, index)}>
          {index === (firstMarkdownIdx === -1 ? displayItems.length : firstMarkdownIdx) &&
          counselItems.length > 0 ? (
            <InlineCounselSection items={counselItems} defaultCollapsed={!isStreaming} />
          ) : null}
          {item.kind === "context_group" ? (
            <InlineContextToolGroup tools={item.tools} defaultCollapsed />
          ) : (
            <AssistantMessagePartView
              part={item.part}
              isStreaming={isStreaming}
              chatId={chatId}
              onPlanArtifactBuild={onPlanArtifactBuild}
              planArtifactBuildDisabled={planArtifactBuildDisabled}
            />
          )}
        </React.Fragment>
      ))}
      {showFallback ? (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code: (props) => <CodeHighlight {...props} isStreaming={isStreaming} />,
            a: customLink,
            text: ({ children }) => <>{renderTextWithPathMentions(children)}</>,
            ...markdownTableComponents,
          }}
        >
          {answerFallback}
        </ReactMarkdown>
      ) : null}
      {isStreaming && chatId != null ? (
        <InlinePermissionPrompts chatId={chatId} />
      ) : null}
    </>
  );
}

function displayItemKey(
  item: ReturnType<typeof groupAssistantDisplayParts>[number],
  index: number,
): string {
  if (item.kind === "context_group") {
    return `ctx-${item.tools.map((t) => t.id).join("-")}-${index}`;
  }
  const part = item.part;
  if (part.type === "plan_artifact") return `plan-${part.planId}`;
  if (part.type === "tool") return `tool-${part.id}-${index}`;
  if (part.type === "thought") return `thought-${index}`;
  return `md-${index}`;
}

function AssistantMessagePartView({
  part,
  isStreaming,
  chatId,
  onPlanArtifactBuild,
  planArtifactBuildDisabled,
}: {
  part: AssistantMessagePart;
  isStreaming: boolean;
  chatId: number | null | undefined;
  onPlanArtifactBuild?: (planId: string) => void;
  planArtifactBuildDisabled?: boolean;
}) {
  switch (part.type) {
    case "thought":
      return (
        <InlineThoughtBlock content={part.content} isStreaming={isStreaming} />
      );
    case "tool":
      return <InlineToolPartCard part={part} defaultCollapsed />;
    case "plan_artifact":
      return (
        <InlinePlanArtifactSlot
          planId={part.planId}
          chatId={chatId}
          onBuild={onPlanArtifactBuild}
          buildDisabled={planArtifactBuildDisabled}
        />
      );
    case "markdown":
      return (
        <AtlarixMarkdownSegment content={part.content} isStreaming={isStreaming} />
      );
    default:
      return null;
  }
}
