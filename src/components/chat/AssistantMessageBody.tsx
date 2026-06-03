import { useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import {
  activeChatIdAtom,
  completedStreamThreadByAssistantMessageIdAtom,
  completedTurnThinkingByAssistantMessageIdAtom,
  inlineTimelineByMessageIdAtom,
  selectedChatIdAtom,
  sourcesByAssistantMessageIdAtom,
  streamThreadByChatIdAtom,
} from "@/atoms/chatAtoms";
import { extractSourcesFromMessageParts } from "@/lib/chat/citation-sources";
import {
  activityStreamItemsAtom,
  type SourceItem,
} from "@/atoms/sourceAtoms";
import { frozenThoughtContentForTurn } from "@/lib/chat/frozen-turn-display";
import {
  extractVisibleAnswerMarkdown,
  isOnlyToolDebris,
  sanitizeMarkdownForDisplay,
} from "@/lib/chat/answer-display";
import {
  parseAssistantMessageParts,
  type AssistantMessagePart,
} from "@/lib/chat/assistant-message-parts";
import { filterDelegateToolParts } from "@/lib/chat/delegate-handoff";
import type { PlanCardData } from "@/lib/plan-cards/plan-card-renderer";
import { AtlarixMarkdownSegment } from "./AtlarixMarkdownSegment";
import { InlineThoughtBlock } from "./InlineThoughtBlock";
import { InlinePlanArtifactSlot } from "./InlinePlanArtifactSlot";
import { InlineToolPartCard } from "./InlineToolPartCard";
import { InlinePermissionApprovals } from "./InlinePermissionApprovals";
import { StreamToolCallCard } from "./StreamToolCallCard";
import { flattenToolGroupsInThread } from "@/lib/chat/group-stream-tools";
import {
  consolidateSubagentRoundsInThread,
  hasActiveSubagentActivity,
  hasDelegateToolParts,
  hasSubagentRoundPanel,
  mergeSubAgentRunEntries,
  proseAlreadyRendered,
  resolveLiveSubagentRound,
  splitInterleavedAroundDelegates,
  synthesizeSubagentRoundFromParts,
  type StreamThreadItem,
  type StreamThreadToolStatus,
  type SubAgentRunEntry,
} from "@/lib/chat/stream-thread";
import { isToolExpandable as isToolExpandViewExpandable } from "@/lib/chat/tool-expand-view";
import { CollapsedScrollSection } from "./CollapsedScrollSection";
import { SubAgentCard } from "./subagent/SubAgentCard";
import { SubAgentsRoundPanel } from "./subagent/SubAgentsRoundPanel";

export function AssistantMessageBody({
  content,
  isStreaming,
  assistantMessageId,
  chatId: chatIdProp,
  contentDrivenThread = false,
  onPlanSwitchToBuild: _onPlanSwitchToBuild,
  onPlanArtifactBuild,
  planArtifactBuildDisabled,
}: {
  content: string;
  isStreaming: boolean;
  assistantMessageId?: number;
  chatId?: number | null;
  /** Ephemeral / floating chat: tools and thoughts come from atlarix tags in content. */
  contentDrivenThread?: boolean;
  onPlanSwitchToBuild?: (autoMessage: string, planData: PlanCardData) => void;
  onPlanArtifactBuild?: (planId: string) => void;
  planArtifactBuildDisabled?: boolean;
}) {
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const activeChatId = useAtomValue(activeChatIdAtom);
  const chatId = chatIdProp ?? activeChatId ?? selectedChatId;
  const streamThreadByChatId = useAtomValue(streamThreadByChatIdAtom);
  const completedStreamThreadByMessage = useAtomValue(
    completedStreamThreadByAssistantMessageIdAtom,
  );
  const inlineTimelineByMessage = useAtomValue(inlineTimelineByMessageIdAtom);
  const thinkingByMessage = useAtomValue(
    completedTurnThinkingByAssistantMessageIdAtom,
  );
  const sourcesByMessage = useAtomValue(sourcesByAssistantMessageIdAtom);
  const activityItems = useAtomValue(activityStreamItemsAtom);

  const parts = useMemo(
    () => parseAssistantMessageParts(content, isStreaming),
    [content, isStreaming],
  );

  const trailingAnswer = useMemo(() => {
    const raw = extractVisibleAnswerMarkdown(content);
    const sanitized = sanitizeMarkdownForDisplay(raw);
    if (!sanitized || isOnlyToolDebris(sanitized)) return "";
    return sanitized;
  }, [content]);

  const hasMarkdownPart = useMemo(
    () => parts.some((p) => p.type === "markdown"),
    [parts],
  );

  const isStructured = useMemo(
    () =>
      /<think>|<atlarix-(?:mcp-)?tool-(?:call|result)/i.test(content),
    [content],
  );

  const liveThread = useMemo(() => {
    if (!isStreaming || chatId == null) return [];
    return flattenToolGroupsInThread(
      consolidateSubagentRoundsInThread(
        streamThreadByChatId.get(chatId) ?? [],
      ),
    );
  }, [isStreaming, chatId, streamThreadByChatId]);

  const completedThreadRaw = useMemo(() => {
    if (isStreaming || assistantMessageId == null) return [];
    return completedStreamThreadByMessage[assistantMessageId] ?? [];
  }, [
    isStreaming,
    assistantMessageId,
    completedStreamThreadByMessage,
  ]);

  const completedThread = useMemo(
    () =>
      flattenToolGroupsInThread(
        consolidateSubagentRoundsInThread(completedThreadRaw),
      ),
    [completedThreadRaw],
  );

  const synthesizedSubagentRound = useMemo(() => {
    if (isStreaming) return null;
    if (hasSubagentRoundPanel(liveThread) || hasSubagentRoundPanel(completedThread)) {
      return null;
    }
    return synthesizeSubagentRoundFromParts(parts);
  }, [isStreaming, liveThread, completedThread, parts]);

  const displayCompletedThread = useMemo(() => {
    if (!completedThread.length && !synthesizedSubagentRound) return [];
    if (synthesizedSubagentRound && !hasSubagentRoundPanel(completedThread)) {
      return [...completedThread, synthesizedSubagentRound];
    }
    return completedThread;
  }, [completedThread, synthesizedSubagentRound]);

  const liveSubagentRound = useMemo(() => {
    if (chatId == null) return null;
    const threadSource = isStreaming ? liveThread : displayCompletedThread;
    return resolveLiveSubagentRound({
      liveThread: threadSource,
      activityItems,
      chatId,
    });
  }, [
    chatId,
    isStreaming,
    liveThread,
    displayCompletedThread,
    activityItems,
  ]);

  const suppressDelegateTools = useMemo(
    () =>
      hasSubagentRoundPanel(liveThread) ||
      hasSubagentRoundPanel(displayCompletedThread) ||
      Boolean(synthesizedSubagentRound) ||
      Boolean(liveSubagentRound) ||
      (chatId != null && hasActiveSubagentActivity(activityItems, chatId)) ||
      (isStreaming && hasDelegateToolParts(parts)),
    [
      liveThread,
      displayCompletedThread,
      synthesizedSubagentRound,
      liveSubagentRound,
      chatId,
      activityItems,
      isStreaming,
      parts,
    ],
  );

  const { before: partsBeforeDelegate, after: partsAfterDelegate } = useMemo(
    () => splitInterleavedAroundDelegates(parts),
    [parts],
  );

  const interleavedBefore = useMemo(
    () => filterDelegateToolParts(partsBeforeDelegate, suppressDelegateTools),
    [partsBeforeDelegate, suppressDelegateTools],
  );

  const interleavedAfter = useMemo(
    () => filterDelegateToolParts(partsAfterDelegate, suppressDelegateTools),
    [partsAfterDelegate, suppressDelegateTools],
  );

  const [stickyAgents, setStickyAgents] = useState<SubAgentRunEntry[]>([]);

  useEffect(() => {
    if (!isStreaming) {
      setStickyAgents([]);
      return;
    }
    if (!liveSubagentRound?.agents.length) return;
    setStickyAgents((prev) =>
      mergeSubAgentRunEntries(prev, liveSubagentRound.agents),
    );
  }, [liveSubagentRound, isStreaming]);

  const inlineSubagentRound = useMemo(() => {
    if (isStreaming && stickyAgents.length > 0) {
      const status: StreamThreadToolStatus = stickyAgents.some(
        (a) => a.status === "running",
      )
        ? "running"
        : stickyAgents.some((a) => a.status === "error")
          ? "error"
          : "done";
      return {
        kind: "subagent_round" as const,
        id: liveSubagentRound?.id ?? "subagent-round-sticky",
        agents: stickyAgents,
        status,
        ts: liveSubagentRound?.ts ?? Date.now(),
      };
    }
    if (liveSubagentRound) return liveSubagentRound;
    if (!isStreaming && synthesizedSubagentRound) return synthesizedSubagentRound;
    return null;
  }, [liveSubagentRound, isStreaming, synthesizedSubagentRound, stickyAgents]);

  const useInterleavedTimeline = contentDrivenThread || isStructured;

  const showTrailingAnswer =
    trailingAnswer.length > 0 &&
    !hasMarkdownPart &&
    !proseAlreadyRendered(trailingAnswer, parts);

  const citationSources = useMemo(() => {
    if (assistantMessageId != null) {
      const stored = sourcesByMessage[assistantMessageId];
      if (stored?.length) return stored;
    }
    return extractSourcesFromMessageParts(parts);
  }, [assistantMessageId, sourcesByMessage, parts]);

  const interleavedParts = useMemo(
    () => filterDelegateToolParts(parts, suppressDelegateTools),
    [parts, suppressDelegateTools],
  );

  const hasThoughtInInterleavedParts = useMemo(
    () => interleavedParts.some((p) => p.type === "thought"),
    [interleavedParts],
  );

  const frozenThoughtContent = useMemo(() => {
    if (!useInterleavedTimeline || hasThoughtInInterleavedParts) return null;
    if (isStreaming || assistantMessageId == null) return null;
    return frozenThoughtContentForTurn(
      inlineTimelineByMessage[assistantMessageId],
      thinkingByMessage[assistantMessageId],
    );
  }, [
    useInterleavedTimeline,
    hasThoughtInInterleavedParts,
    isStreaming,
    assistantMessageId,
    inlineTimelineByMessage,
    thinkingByMessage,
  ]);

  const ipcTailWhileStreaming = useMemo(() => {
    if (!isStreaming) return [];
    return ipcTimelineTailItems(
      liveThread,
      interleavedParts,
      Boolean(inlineSubagentRound),
    );
  }, [isStreaming, liveThread, interleavedParts, inlineSubagentRound]);

  const postStreamThreadTail = useMemo(() => {
    if (isStreaming || displayCompletedThread.length === 0) return [];
    return completedThreadTailItems(
      displayCompletedThread,
      interleavedParts,
      Boolean(inlineSubagentRound),
    );
  }, [
    isStreaming,
    displayCompletedThread,
    interleavedParts,
    inlineSubagentRound,
  ]);

  const postStreamSubagentItems = useMemo(() => {
    if (isStreaming || inlineSubagentRound) return [];
    const fromThread = displayCompletedThread.filter(
      (i) => i.kind === "subagent_round",
    );
    if (fromThread.length > 0) return fromThread;
    return synthesizedSubagentRound ? [synthesizedSubagentRound] : [];
  }, [
    isStreaming,
    inlineSubagentRound,
    displayCompletedThread,
    synthesizedSubagentRound,
  ]);

  const displayParts = useMemo(
    () => filterDelegateToolParts(parts, suppressDelegateTools),
    [parts, suppressDelegateTools],
  );

  const postStreamThoughtFromParts = useMemo(() => {
    if (useInterleavedTimeline || isStreaming || frozenThoughtContent) return null;
    const thoughts = displayParts.filter(
      (p): p is Extract<AssistantMessagePart, { type: "thought" }> =>
        p.type === "thought",
    );
    if (!thoughts.length) return null;
    return thoughts.map((t) => t.content).join("\n\n");
  }, [
    useInterleavedTimeline,
    isStreaming,
    frozenThoughtContent,
    displayParts,
  ]);

  if (useInterleavedTimeline) {
    return (
      <div className={isStreaming ? "min-h-[4rem] w-full" : "w-full"}>
        {frozenThoughtContent ? (
          <InlineThoughtBlock
            content={frozenThoughtContent}
            isStreaming={false}
          />
        ) : null}
        {interleavedBefore.map((part, index) => (
          <AssistantMessagePartView
            key={partKey(part, index)}
            part={part}
            isStreaming={isStreaming}
            chatId={chatId}
            citationSources={citationSources}
            suppressDelegateTools={suppressDelegateTools}
            onPlanArtifactBuild={onPlanArtifactBuild}
            planArtifactBuildDisabled={planArtifactBuildDisabled}
          />
        ))}
        {inlineSubagentRound ? (
          <SubAgentsRoundPanel
            agents={inlineSubagentRound.agents}
            status={inlineSubagentRound.status}
            isStreaming={isStreaming}
          />
        ) : null}
        {interleavedAfter.map((part, index) => (
          <AssistantMessagePartView
            key={partKey(part, index)}
            part={part}
            isStreaming={isStreaming}
            chatId={chatId}
            citationSources={citationSources}
            suppressDelegateTools={suppressDelegateTools}
            onPlanArtifactBuild={onPlanArtifactBuild}
            planArtifactBuildDisabled={planArtifactBuildDisabled}
          />
        ))}
        {ipcTailWhileStreaming.map((item) => (
          <StreamThreadItemView
            key={`tail-${threadItemKey(item)}`}
            item={item}
            isStreaming={isStreaming}
            chatId={chatId}
            onPlanArtifactBuild={onPlanArtifactBuild}
            planArtifactBuildDisabled={planArtifactBuildDisabled}
          />
        ))}
        {postStreamThreadTail.map((item) => (
          <StreamThreadItemView
            key={`completed-tail-${threadItemKey(item)}`}
            item={item}
            isStreaming={false}
            chatId={chatId}
            onPlanArtifactBuild={onPlanArtifactBuild}
            planArtifactBuildDisabled={planArtifactBuildDisabled}
          />
        ))}
        {postStreamSubagentItems.map((item) => (
          <StreamThreadItemView
            key={`subagent-${threadItemKey(item)}`}
            item={item}
            isStreaming={false}
            chatId={chatId}
            onPlanArtifactBuild={onPlanArtifactBuild}
            planArtifactBuildDisabled={planArtifactBuildDisabled}
          />
        ))}
        {showTrailingAnswer ? (
          <AtlarixMarkdownSegment
            content={trailingAnswer}
            isStreaming={isStreaming}
            citationSources={citationSources}
          />
        ) : null}
        {isStreaming && chatId != null ? (
          <InlinePermissionApprovals chatId={chatId} />
        ) : null}
      </div>
    );
  }

  return (
    <div className={isStreaming ? "min-h-[4rem] w-full" : "w-full"}>
      {frozenThoughtContent ? (
        <InlineThoughtBlock
          content={frozenThoughtContent}
          isStreaming={false}
        />
      ) : null}
      {postStreamThoughtFromParts ? (
        <InlineThoughtBlock
          content={postStreamThoughtFromParts}
          isStreaming={false}
        />
      ) : null}
      {isStreaming
        ? liveThread.map((item) => (
            <StreamThreadItemView
              key={threadItemKey(item)}
              item={item}
              isStreaming={isStreaming}
              chatId={chatId}
              onPlanArtifactBuild={onPlanArtifactBuild}
              planArtifactBuildDisabled={planArtifactBuildDisabled}
            />
          ))
        : null}
      {displayParts.map((part, index) => (
        <AssistantMessagePartView
          key={partKey(part, index)}
          part={part}
          isStreaming={isStreaming}
          chatId={chatId}
          citationSources={citationSources}
          suppressDelegateTools={suppressDelegateTools}
          onPlanArtifactBuild={onPlanArtifactBuild}
          planArtifactBuildDisabled={planArtifactBuildDisabled}
        />
      ))}
      {postStreamThreadTail.map((item) => (
        <StreamThreadItemView
          key={`legacy-tail-${threadItemKey(item)}`}
          item={item}
          isStreaming={false}
          chatId={chatId}
          onPlanArtifactBuild={onPlanArtifactBuild}
          planArtifactBuildDisabled={planArtifactBuildDisabled}
        />
      ))}
      {showTrailingAnswer ? (
        <AtlarixMarkdownSegment content={trailingAnswer} isStreaming={isStreaming} />
      ) : null}
      {isStreaming && chatId != null ? (
        <InlinePermissionApprovals chatId={chatId} />
      ) : null}
    </div>
  );
}

/** Tool names already represented in tag-parsed message parts. */
function toolNamesInParts(parts: AssistantMessagePart[]): Set<string> {
  const names = new Set<string>();
  for (const p of parts) {
    if (p.type === "tool") {
      names.add(p.toolName);
    }
  }
  return names;
}

/** IPC stream rows to append after interleaved parts (sub-agents, running tools not yet in content). */
function ipcTimelineTailItems(
  thread: StreamThreadItem[],
  parts: AssistantMessagePart[],
  excludeSubagentRound = false,
): StreamThreadItem[] {
  const inParts = toolNamesInParts(parts);
  return thread.filter((item) => {
    if (item.kind === "subagent_round") return !excludeSubagentRound;
    if (item.kind === "background" || item.kind === "plan") return true;
    if (item.kind === "tool") {
      if (item.status === "running" && !inParts.has(item.toolName)) {
        return true;
      }
      return false;
    }
    return false;
  });
}

/** Completed-thread rows not already covered by tag-parsed interleaved parts. */
function completedThreadTailItems(
  thread: StreamThreadItem[],
  parts: AssistantMessagePart[],
  excludeSubagentRound = false,
): StreamThreadItem[] {
  const partTools = parts.filter(
    (p): p is Extract<AssistantMessagePart, { type: "tool" }> =>
      p.type === "tool",
  );
  const hasThoughtInParts = parts.some((p) => p.type === "thought");
  const toolNameIndex = new Map<string, number>();

  const partForTool = (toolName: string) => {
    const idx = toolNameIndex.get(toolName) ?? 0;
    toolNameIndex.set(toolName, idx + 1);
    return partTools.filter((p) => p.toolName === toolName)[idx];
  };

  return thread.filter((item) => {
    if (item.kind === "subagent_round") return !excludeSubagentRound;
    if (item.kind === "subagent" || item.kind === "tool_group") return false;
    if (item.kind === "thought") return !hasThoughtInParts;
    if (item.kind === "background" || item.kind === "plan") return true;
    if (item.kind === "tool") {
      const part = partForTool(item.toolName);
      if (!part) return true;
      const partHasResult = Boolean(part.resultText?.trim());
      const threadExpandable =
        item.expand != null && isToolExpandViewExpandable(item.expand);
      if (!partHasResult && threadExpandable) return true;
      return false;
    }
    return false;
  });
}

function threadItemKey(item: StreamThreadItem): string {
  if (item.kind === "plan") return `plan-${item.planId}`;
  return `${item.kind}-${item.id}`;
}

function StreamThreadItemView({
  item,
  isStreaming,
  chatId,
  onPlanArtifactBuild,
  planArtifactBuildDisabled,
}: {
  item: StreamThreadItem;
  isStreaming: boolean;
  chatId: number | null | undefined;
  onPlanArtifactBuild?: (planId: string) => void;
  planArtifactBuildDisabled?: boolean;
}) {
  switch (item.kind) {
    case "thought":
      return (
        <InlineThoughtBlock content={item.content} isStreaming={isStreaming} />
      );
    case "tool":
      return (
        <StreamToolCallCard
          summary={item.summary}
          expand={item.expand}
          detail={item.detail}
          status={item.status}
          toolName={item.toolName}
        />
      );
    case "plan":
      return (
        <InlinePlanArtifactSlot
          planId={item.planId}
          chatId={chatId}
          onBuild={onPlanArtifactBuild}
          buildDisabled={planArtifactBuildDisabled}
        />
      );
    case "background":
      return (
        <CollapsedScrollSection
          summary={item.label}
          status={item.status === "running" ? "running" : "done"}
          defaultCollapsed={item.status !== "running"}
          maxBodyHeightClass="max-h-48"
        >
          {item.detail ? (
            <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap break-words">
              {item.detail}
            </pre>
          ) : null}
        </CollapsedScrollSection>
      );
    case "subagent_round":
      return (
        <SubAgentsRoundPanel
          agents={item.agents}
          status={item.status}
          isStreaming={isStreaming}
          isHistorical={!isStreaming}
        />
      );
    case "tool_group":
      return (
        <>
          {item.tools.map((tool) => (
            <StreamToolCallCard
              key={`${tool.id}-${tool.ts}`}
              summary={tool.summary}
              expand={tool.expand}
              detail={tool.detail}
              status={tool.status}
              toolName={tool.toolName}
            />
          ))}
        </>
      );
    case "subagent":
      return (
        <SubAgentCard
          agentType={item.agentType}
          scope={item.scope}
          summary={item.summary}
          status={
            item.status === "running"
              ? "running"
              : item.status === "error"
                ? "error"
                : "done"
          }
        />
      );
    case "counsel":
      return (
        <CollapsedScrollSection
          summary={item.label}
          status={item.status === "running" ? "running" : "done"}
          defaultCollapsed={item.status !== "running"}
          maxBodyHeightClass="max-h-48"
        >
          {item.detail ? (
            <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap break-words">
              {item.detail}
            </pre>
          ) : null}
        </CollapsedScrollSection>
      );
    default:
      return null;
  }
}

function partKey(part: AssistantMessagePart, index: number): string {
  if (part.type === "plan_artifact") return `plan-${part.planId}`;
  if (part.type === "tool") return `tool-${part.id}-${index}`;
  if (part.type === "thought") return `thought-${index}`;
  return `md-${index}`;
}

function AssistantMessagePartView({
  part,
  isStreaming,
  chatId,
  citationSources,
  suppressDelegateTools,
  onPlanArtifactBuild,
  planArtifactBuildDisabled,
}: {
  part: AssistantMessagePart;
  isStreaming: boolean;
  chatId: number | null | undefined;
  citationSources?: SourceItem[];
  suppressDelegateTools?: boolean;
  onPlanArtifactBuild?: (planId: string) => void;
  planArtifactBuildDisabled?: boolean;
}) {
  switch (part.type) {
    case "thought":
      return (
        <InlineThoughtBlock content={part.content} isStreaming={isStreaming} />
      );
    case "tool":
      return (
        <InlineToolPartCard
          part={part}
          defaultCollapsed
          suppressDelegateTools={suppressDelegateTools}
        />
      );
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
        <AtlarixMarkdownSegment
          content={part.content}
          isStreaming={isStreaming}
          citationSources={citationSources}
        />
      );
    default:
      return null;
  }
}
