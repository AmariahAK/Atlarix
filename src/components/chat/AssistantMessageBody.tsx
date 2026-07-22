import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import {
  activeChatIdAtom,
  activityStreamItemsForChatAtom,
  completedStreamThreadForMessageAtom,
  completedTurnThinkingForMessageAtom,
  inlineTimelineForMessageAtom,
  interleavedDisplayContentForMessageAtom,
  selectedChatIdAtom,
  sourcesForMessageAtom,
  streamThreadForChatAtom,
} from "@/atoms/chatAtoms";
import {
  extractInlineSourcesFromContent,
  extractSourcesFromMessageParts,
} from "@/lib/chat/citation-sources";
import { type SourceItem } from "@/atoms/sourceAtoms";
import { MessageSources } from "@/components/MessageSources";
import { frozenThoughtContentForTurn } from "@/lib/chat/frozen-turn-display";
import {
  extractVisibleAnswerMarkdown,
  isOnlyToolDebris,
  sanitizeMarkdownForDisplay,
} from "@/lib/chat/answer-display";
import {
  parseAssistantMessageParts,
  splitContentPartsAtOffset,
  type AssistantMessagePart,
} from "@/lib/chat/assistant-message-parts";
import {
  filterDelegateToolParts,
  isDelegateToolName,
} from "@/lib/chat/delegate-handoff";
import type { PlanCardData } from "@/lib/plan-cards/plan-card-renderer";
import { AtlarixMarkdownSegment } from "./AtlarixMarkdownSegment";
import { InlineThoughtBlock } from "./InlineThoughtBlock";
import { InlinePlanArtifactSlot } from "./InlinePlanArtifactSlot";
import { InlineToolPartCard } from "./InlineToolPartCard";
import { InlinePermissionApprovals } from "./InlinePermissionApprovals";
import { StreamToolCallCard } from "./StreamToolCallCard";
import { flattenToolGroupsInThread } from "@/lib/chat/group-stream-tools";
import { weaveIpcItemsIntoParts, type WovenEntry } from "@/lib/chat/timeline-weave";
import {
  compareThreadItems,
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
import { groupPaginatableRuns } from "@/lib/chat/paginate-tool-runs";
import { PaginatedToolCards } from "./PaginatedToolCards";
import { CollapsedScrollSection } from "./CollapsedScrollSection";
import { SubAgentCard } from "./subagent/SubAgentCard";
import { SubAgentsRoundPanel } from "./subagent/SubAgentsRoundPanel";

export function AssistantMessageBody({
  content,
  isStreaming,
  assistantMessageId,
  chatId: chatIdProp,
  isLatestAssistant = false,
  contentDrivenThread = false,
  onPlanSwitchToBuild: _onPlanSwitchToBuild,
  onPlanArtifactBuild,
  planArtifactBuildDisabled,
}: {
  content: string;
  isStreaming: boolean;
  assistantMessageId?: number;
  chatId?: number | null;
  /** The last assistant message in the list — the one that was just streaming.
   * Gates the end-of-stream live-thread fallback to ONLY this message. */
  isLatestAssistant?: boolean;
  /** Ephemeral / floating chat: tools and thoughts come from atlarix tags in content. */
  contentDrivenThread?: boolean;
  onPlanSwitchToBuild?: (autoMessage: string, planData: PlanCardData) => void;
  onPlanArtifactBuild?: (planId: string) => void;
  planArtifactBuildDisabled?: boolean;
}) {
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const activeChatId = useAtomValue(activeChatIdAtom);
  const chatId = chatIdProp ?? activeChatId ?? selectedChatId;
  // Scoped to THIS chat — a stream in another chat no longer re-renders this
  // message body every ~50ms flush (perf: kills whole-map fanout).
  const streamThreadForChat = useAtomValue(streamThreadForChatAtom(chatId ?? -1));
  // Per-message / per-chat scoped selectors: a body re-renders only when ITS own
  // slice changes, not on every other message's stream flush (perf: kills the
  // all-mounted-bodies fanout). `-1` for a null id yields the empty slice.
  const msgId = assistantMessageId ?? -1;
  const completedStreamThreadForMessage = useAtomValue(
    completedStreamThreadForMessageAtom(msgId),
  );
  const inlineTimelineForMessage = useAtomValue(inlineTimelineForMessageAtom(msgId));
  const thinkingForMessage = useAtomValue(completedTurnThinkingForMessageAtom(msgId));
  const sourcesForMessage = useAtomValue(sourcesForMessageAtom(msgId));
  const activityItems = useAtomValue(activityStreamItemsForChatAtom(chatId ?? -1));
  const interleavedDisplayContentForMessage = useAtomValue(
    interleavedDisplayContentForMessageAtom(msgId),
  );

  // Persisted `content` is `<think>`-stripped (for model re-ingestion), which
  // collapses thought order on reload. When an ordered display copy exists for
  // a completed message, render from THAT so the frozen view interleaves like
  // streaming. During streaming, `content` already carries the live tags.
  const effectiveContent = useMemo(() => {
    if (isStreaming || assistantMessageId == null) return content;
    return interleavedDisplayContentForMessage ?? content;
  }, [isStreaming, assistantMessageId, interleavedDisplayContentForMessage, content]);

  const parts = useMemo(
    () => parseAssistantMessageParts(effectiveContent, isStreaming),
    [effectiveContent, isStreaming],
  );

  const trailingAnswer = useMemo(() => {
    const raw = extractVisibleAnswerMarkdown(effectiveContent);
    const sanitized = sanitizeMarkdownForDisplay(raw);
    if (!sanitized || isOnlyToolDebris(sanitized)) return "";
    return sanitized;
  }, [effectiveContent]);

  const hasMarkdownPart = useMemo(
    () => parts.some((p) => p.type === "markdown"),
    [parts],
  );

  const isStructured = useMemo(
    () =>
      /<think>|<atlarix-(?:mcp-)?tool-(?:call|result)/i.test(effectiveContent),
    [effectiveContent],
  );

  const liveThread = useMemo(() => {
    if (!isStreaming || chatId == null) return [];
    return flattenToolGroupsInThread(
      consolidateSubagentRoundsInThread(streamThreadForChat),
    );
  }, [isStreaming, chatId, streamThreadForChat]);

  const completedThreadRaw = useMemo(() => {
    if (isStreaming || assistantMessageId == null) return [];
    const completed = completedStreamThreadForMessage;
    if (completed && completed.length) return completed;
    // End-of-stream gap: `isStreaming` flips false a few statements before
    // `persistAndClearLiveStreamThread` freezes the completed thread (same IPC
    // callback in useStreamChat). In that one-frame window the just-finished
    // message would otherwise render with its tool cards dropped — the "cut to a
    // shorter state" flash. Fall back to the still-present live thread, scoped to
    // the latest assistant only so an older tool-less message can't grab it.
    if (isLatestAssistant && chatId != null) {
      const live = streamThreadForChat;
      if (live && live.length) return live;
    }
    return completed ?? [];
  }, [
    isStreaming,
    assistantMessageId,
    completedStreamThreadForMessage,
    isLatestAssistant,
    chatId,
    streamThreadForChat,
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

  // Bug B: native function-calling sub-agent rounds arrive as IPC activity with
  // no marker in the assistant text, so the pre-call and post-call prose are
  // concatenated. Snapshot the content length when the round first appears (=
  // end of the pre-call prose) so the prose can be split around the panel.
  // Recorded once per round id, during streaming only.
  const [subagentSeamOffset, setSubagentSeamOffset] = useState<number | null>(
    null,
  );
  const seamRecordedForRoundRef = useRef<string | null>(null);
  useEffect(() => {
    const roundId = liveSubagentRound?.id ?? null;
    if (!isStreaming || !roundId) return;
    if (seamRecordedForRoundRef.current === roundId) return;
    seamRecordedForRoundRef.current = roundId;
    setSubagentSeamOffset(effectiveContent.length);
  }, [liveSubagentRound, isStreaming, effectiveContent]);

  const { before: partsBeforeDelegate, after: partsAfterDelegate } = useMemo(() => {
    // Content-driven case: a delegate tool tag is present in the text — split there.
    if (parts.some((p) => p.type === "tool" && isDelegateToolName(p.toolName))) {
      return splitInterleavedAroundDelegates(parts);
    }
    // Native-FC case: no delegate tag in the text. Split the raw content at the
    // recorded seam so the continuation renders AFTER the sub-agent panel.
    if (liveSubagentRound && subagentSeamOffset != null) {
      return splitContentPartsAtOffset(
        effectiveContent,
        subagentSeamOffset,
        isStreaming,
      );
    }
    return splitInterleavedAroundDelegates(parts);
  }, [parts, liveSubagentRound, subagentSeamOffset, effectiveContent, isStreaming]);

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
      const stored = sourcesForMessage;
      if (stored?.length) return stored;
    }
    // Tool-result sources (client web_search) + provider-native search sources
    // persisted in content as <atlarix-sources> (v10.1), deduped by URL.
    const fromParts = extractSourcesFromMessageParts(parts);
    const inline = extractInlineSourcesFromContent(content);
    if (inline.length === 0) return fromParts;
    const seen = new Set(fromParts.map((s) => s.url));
    return [...fromParts, ...inline.filter((s) => !seen.has(s.url))];
  }, [assistantMessageId, sourcesForMessage, parts, content]);

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
      inlineTimelineForMessage,
      thinkingForMessage,
    );
  }, [
    useInterleavedTimeline,
    hasThoughtInInterleavedParts,
    isStreaming,
    assistantMessageId,
    inlineTimelineForMessage,
    thinkingForMessage,
  ]);

  const ipcTailWhileStreaming = useMemo(() => {
    if (!isStreaming) return [];
    return ipcTimelineTailItems(
      liveThread,
      interleavedParts,
      Boolean(inlineSubagentRound),
      suppressDelegateTools,
    );
  }, [
    isStreaming,
    liveThread,
    interleavedParts,
    inlineSubagentRound,
    suppressDelegateTools,
  ]);

  const postStreamThreadTail = useMemo(() => {
    if (isStreaming || displayCompletedThread.length === 0) return [];
    return completedThreadTailItems(
      displayCompletedThread,
      interleavedParts,
      Boolean(inlineSubagentRound),
      suppressDelegateTools,
    );
  }, [
    isStreaming,
    displayCompletedThread,
    interleavedParts,
    inlineSubagentRound,
    suppressDelegateTools,
  ]);

  // W7 (v14.8.11): weave IPC-only items (compaction/background/plan cards)
  // into the content timeline at their timestamps instead of pinning them to
  // the bottom. One helper for the streaming AND completed paths so they
  // can't diverge; unanchorable items keep today's tail placement.
  const woven = useMemo(() => {
    return weaveIpcItemsIntoParts({
      before: interleavedBefore,
      after: interleavedAfter,
      items: isStreaming ? ipcTailWhileStreaming : postStreamThreadTail,
      anchorsFrom: isStreaming ? liveThread : displayCompletedThread,
    });
  }, [
    interleavedBefore,
    interleavedAfter,
    isStreaming,
    ipcTailWhileStreaming,
    postStreamThreadTail,
    liveThread,
    displayCompletedThread,
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
        <WovenEntryList
          entries={woven.before}
          isStreaming={isStreaming}
          chatId={chatId}
          citationSources={citationSources}
          suppressDelegateTools={suppressDelegateTools}
          onPlanArtifactBuild={onPlanArtifactBuild}
          planArtifactBuildDisabled={planArtifactBuildDisabled}
        />
        {inlineSubagentRound ? (
          <SubAgentsRoundPanel
            agents={inlineSubagentRound.agents}
            status={inlineSubagentRound.status}
            isStreaming={isStreaming}
          />
        ) : null}
        <WovenEntryList
          entries={woven.after}
          isStreaming={isStreaming}
          chatId={chatId}
          citationSources={citationSources}
          suppressDelegateTools={suppressDelegateTools}
          onPlanArtifactBuild={onPlanArtifactBuild}
          planArtifactBuildDisabled={planArtifactBuildDisabled}
        />
        <PaginatedThreadList
          items={woven.tail}
          keyPrefix={isStreaming ? "tail" : "completed-tail"}
          isStreaming={isStreaming}
          chatId={chatId}
          onPlanArtifactBuild={onPlanArtifactBuild}
          planArtifactBuildDisabled={planArtifactBuildDisabled}
        />
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
        {/* Sources strip — see the note on the legacy branch below. It must be
            mounted HERE too: any turn that actually ran a search carries a
            tool-call tag, which makes `isStructured` true and routes rendering
            through this branch, so a strip only on the legacy path never shows
            for the very turns that have citations. */}
        {!isStreaming && citationSources.length > 0 ? (
          <MessageSources sources={citationSources} />
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
      <PaginatedPartList
        parts={displayParts}
        isStreaming={isStreaming}
        chatId={chatId}
        citationSources={citationSources}
        suppressDelegateTools={suppressDelegateTools}
        onPlanArtifactBuild={onPlanArtifactBuild}
        planArtifactBuildDisabled={planArtifactBuildDisabled}
      />
      <PaginatedThreadList
        items={postStreamThreadTail}
        keyPrefix="legacy-tail"
        isStreaming={false}
        chatId={chatId}
        onPlanArtifactBuild={onPlanArtifactBuild}
        planArtifactBuildDisabled={planArtifactBuildDisabled}
      />
      {showTrailingAnswer ? (
        <AtlarixMarkdownSegment content={trailingAnswer} isStreaming={isStreaming} />
      ) : null}
      {isStreaming && chatId != null ? (
        <InlinePermissionApprovals chatId={chatId} />
      ) : null}
      {/* Web-search sources strip: renders the settled turn's citation sources
          (client web_search tool-results + provider-native `<atlarix-sources>`,
          incl. Atlarix Core's OpenRouter search) as clickable cards. Independent
          of whether the model emitted inline `[^n]` markers — the robust path. */}
      {!isStreaming && citationSources.length > 0 ? (
        <MessageSources sources={citationSources} />
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
  suppressDelegateTools = false,
): StreamThreadItem[] {
  const inParts = toolNamesInParts(parts);
  return thread
    .filter((item) => {
      if (item.kind === "subagent_round") return !excludeSubagentRound;
      if (item.kind === "background" || item.kind === "plan") return true;
      if (item.kind === "tool") {
        // A native-FC delegation has no content tag, so it always looks
        // "not represented" and lands here — as a second, redundant
        // "Sub-agent finished" card under a panel that already lists that
        // agent. Drop it only when a panel exists to represent it.
        if (suppressDelegateTools && isDelegateToolName(item.toolName)) {
          return false;
        }
        // Show tools not represented in the content parts — including COMPLETED
        // ones. Previously only `running` tools passed, so a permission-
        // interceptor write/edit (which never gets a content-tag part) vanished
        // the instant it completed: visible while running, gone after accept.
        return !inParts.has(item.toolName);
      }
      return false;
    })
    .sort(compareThreadItems);
}

/** Completed-thread rows not already covered by tag-parsed interleaved parts. */
function completedThreadTailItems(
  thread: StreamThreadItem[],
  parts: AssistantMessagePart[],
  excludeSubagentRound = false,
  suppressDelegateTools = false,
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

  return thread
    .filter((item) => {
      if (item.kind === "subagent_round") return !excludeSubagentRound;
      if (item.kind === "subagent" || item.kind === "tool_group") return false;
      if (item.kind === "thought") return !hasThoughtInParts;
      if (item.kind === "background" || item.kind === "plan") return true;
      if (item.kind === "tool") {
        // See ipcTimelineTailItems: the round panel is the single home for
        // agents, so a delegate row here is a duplicate of it.
        if (suppressDelegateTools && isDelegateToolName(item.toolName)) {
          return false;
        }
        const part = partForTool(item.toolName);
        if (!part) return true;
        // The inline part renders its own result only when it carries one.
        // When it doesn't, keep the completed thread card if it has its own
        // renderable content (a diff/expand view OR raw result text) so an
        // accepted write/edit whose result arrived via the permission
        // interceptor isn't dropped from the frozen view.
        const partHasResult = Boolean(part.resultText?.trim());
        if (partHasResult) return false;
        const threadExpandable =
          item.expand != null && isToolExpandViewExpandable(item.expand);
        return threadExpandable || Boolean(item.resultText?.trim());
      }
      return false;
    })
    .sort(compareThreadItems);
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
          elapsedMs={item.endTs != null ? item.endTs - item.ts : undefined}
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
              elapsedMs={tool.endTs != null ? tool.endTs - tool.ts : undefined}
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

type PartRenderProps = {
  isStreaming: boolean;
  chatId: number | null | undefined;
  citationSources?: SourceItem[];
  suppressDelegateTools?: boolean;
  onPlanArtifactBuild?: (planId: string) => void;
  planArtifactBuildDisabled?: boolean;
};

/** Render a parts list, paginating long runs of consecutive command/file cards. */
/**
 * W7 (v14.8.11): render a woven timeline — runs of content parts keep the
 * existing PaginatedPartList behavior; IPC-only thread items (compaction /
 * background / interceptor tool cards) render inline at their woven position
 * instead of being pinned to the message tail.
 */
function WovenEntryList({
  entries,
  ...props
}: { entries: WovenEntry[] } & PartRenderProps) {
  const runs: Array<
    | { type: "parts"; parts: AssistantMessagePart[] }
    | { type: "thread"; item: StreamThreadItem }
  > = [];
  for (const entry of entries) {
    if (entry.type === "thread") {
      runs.push({ type: "thread", item: entry.item });
      continue;
    }
    const last = runs[runs.length - 1];
    if (last && last.type === "parts") last.parts.push(entry.part);
    else runs.push({ type: "parts", parts: [entry.part] });
  }
  return (
    <>
      {runs.map((run, ri) =>
        run.type === "parts" ? (
          <PaginatedPartList key={`woven-run-${ri}`} parts={run.parts} {...props} />
        ) : (
          <StreamThreadItemView
            key={`woven-${threadItemKey(run.item)}`}
            item={run.item}
            isStreaming={props.isStreaming}
            chatId={props.chatId}
            onPlanArtifactBuild={props.onPlanArtifactBuild}
            planArtifactBuildDisabled={props.planArtifactBuildDisabled}
          />
        ),
      )}
    </>
  );
}

function PaginatedPartList({
  parts,
  ...props
}: { parts: AssistantMessagePart[] } & PartRenderProps) {
  const groups = groupPaginatableRuns(parts, (p) =>
    p.type === "tool" ? p.toolName : null,
  );
  return (
    <>
      {groups.map((g, gi) =>
        g.type === "single" ? (
          <AssistantMessagePartView
            key={partKey(g.item, gi)}
            part={g.item}
            {...props}
          />
        ) : (
          <PaginatedToolCards
            key={`part-run-${gi}`}
            label="steps"
            cards={g.items.map((p, pi) => (
              <AssistantMessagePartView
                key={partKey(p, pi)}
                part={p}
                {...props}
              />
            ))}
          />
        ),
      )}
    </>
  );
}

type ThreadRenderProps = {
  isStreaming: boolean;
  chatId: number | null | undefined;
  keyPrefix: string;
  onPlanArtifactBuild?: (planId: string) => void;
  planArtifactBuildDisabled?: boolean;
};

/** Render a thread-item list, paginating long runs of consecutive command/file cards. */
function PaginatedThreadList({
  items,
  keyPrefix,
  ...props
}: { items: StreamThreadItem[] } & ThreadRenderProps) {
  const groups = groupPaginatableRuns(items, (i) =>
    i.kind === "tool" ? i.toolName : null,
  );
  return (
    <>
      {groups.map((g, gi) =>
        g.type === "single" ? (
          <StreamThreadItemView
            key={`${keyPrefix}-${threadItemKey(g.item)}`}
            item={g.item}
            {...props}
          />
        ) : (
          <PaginatedToolCards
            key={`${keyPrefix}-run-${gi}`}
            label="steps"
            cards={g.items.map((i) => (
              <StreamThreadItemView
                key={`${keyPrefix}-${threadItemKey(i)}`}
                item={i}
                {...props}
              />
            ))}
          />
        ),
      )}
    </>
  );
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
