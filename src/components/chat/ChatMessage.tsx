import type { Message } from "@/ipc/ipc_types";
import {
  AtlarixMarkdownParser,
  CHAT_MESSAGE_MARKDOWN_PROSE,
  VanillaMarkdownParser,
} from "./AtlarixMarkdownParser";
import { useStreamChat } from "@/hooks/useStreamChat";
import {
  CheckCircle,
  XCircle,
  Clock,
  GitCommit,
  Copy,
  Check,
  Info,
  Edit2,
  Undo2,
  Compass,
  FileText,
  Download,
  X,
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { useVersions } from "@/hooks/useVersions";
import { getDefaultStore, useAtomValue, useSetAtom } from "jotai";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import {
  activityStreamItemsAtom,
  previewTabAtom,
  rightPanelVisibleAtom,
} from "@/atoms/sourceAtoms";
import {
  activeChatIdAtom,
  chatMessagesByIdAtom,
  counselPreviewByMessageIdAtom,
  lastTurnHadToolCallsByChatIdAtom,
  livePlanUpdateByAssistantMessageIdAtom,
  planSnapshotByAssistantMessageIdAtom,
  responseDoneAnimationAtom,
  restartedAfterMessageIdAtom,
  selectedChatIdAtom,
  completedTurnArtifactsByAssistantMessageIdAtom,
} from "@/atoms/chatAtoms";
import { useSettings } from "@/hooks/useSettings";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import AtlarixAnimation from "../atlarix/AtlarixAnimation";
import { useModelDisplayName } from "../ChatConfigDropdown";
import {
  formatAutoTierLabel,
  useLastAutoRoutedTier,
} from "@/hooks/useLastAutoRoutedTier";
import { IpcClient } from "@/ipc/ipc_client";
import { showError, showInfo } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import type { PlanCardData } from "@/lib/plan-cards/plan-card-renderer";
import { TaskLedgerPlanCard } from "./TaskLedgerPlanCard";
import { AgentActivityLog, buildActivityLogRows } from "./AgentActivityLog";
import type { ActivityStreamItem } from "@/atoms/sourceAtoms";
import { CounselChatPreview } from "./CounselChatPreview";
import { TurnArtifactsCards } from "./TurnArtifactsCards";
import {
  InlineThoughtsBlock,
  shouldRenderInlineThoughtsPanel,
} from "../ActivityDisplay";
import { AttachmentChip } from "./AttachmentChip";

interface ChatMessageProps {
  message: Message;
  isLastMessage: boolean;
}

const ChatMessage = ({ message, isLastMessage }: ChatMessageProps) => {
  const { isStreaming, streamMessage } = useStreamChat();
  const { settings } = useSettings();
  const appId = useAtomValue(selectedAppIdAtom);
  const activeChatId = useAtomValue(activeChatIdAtom);
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const setMessagesById = useSetAtom(chatMessagesByIdAtom);
  const setCounselPreviewByMessageId = useSetAtom(counselPreviewByMessageIdAtom);
  const counselPreviewPinned = useAtomValue(counselPreviewByMessageIdAtom)[message.id];
  const setRestartedAfterMessageId = useSetAtom(restartedAfterMessageIdAtom);
  const currentChatId = activeChatId ?? selectedChatId;
  const activityItems = useAtomValue(activityStreamItemsAtom);
  const livePlanByAssistantMessageId = useAtomValue(livePlanUpdateByAssistantMessageIdAtom);
  const planSnapshotsByMessageId = useAtomValue(planSnapshotByAssistantMessageIdAtom);
  const completedTurnArtifactsById = useAtomValue(
    completedTurnArtifactsByAssistantMessageIdAtom,
  );
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const setPreviewTab = useSetAtom(previewTabAtom);
  const [frozenActivity, setFrozenActivity] = useState<ActivityStreamItem[] | null>(null);
  const prevStreamingWhenLastRef = useRef(false);

  const filteredLiveActivity = useMemo(
    () =>
      currentChatId == null
        ? []
        : activityItems.filter(
            (i) => i.chatId == null || i.chatId === currentChatId,
          ),
    [activityItems, currentChatId],
  );

  useEffect(() => {
    if (message.role !== "assistant" || currentChatId == null) return;
    if (!isLastMessage) return;

    if (isStreaming) {
      setFrozenActivity(null);
      prevStreamingWhenLastRef.current = true;
      return;
    }

    if (prevStreamingWhenLastRef.current) {
      const snap = getDefaultStore()
        .get(activityStreamItemsAtom)
        .filter((i) => i.chatId == null || i.chatId === currentChatId);
      setFrozenActivity(snap);
      const counselTypes = new Set<ActivityStreamItem["type"]>([
        "counsel_start",
        "counsel_participant_complete",
        "counsel_synthesising",
        "counsel_complete",
      ]);
      const counselOnly = snap.filter((i) => counselTypes.has(i.type));
      if (counselOnly.length > 0) {
        setCounselPreviewByMessageId((prev) => ({
          ...prev,
          [message.id]: counselOnly,
        }));
      }
    }
    prevStreamingWhenLastRef.current = false;
  }, [
    isStreaming,
    isLastMessage,
    message.role,
    message.id,
    currentChatId,
    setCounselPreviewByMessageId,
  ]);

  const displayActivityItems = useMemo(() => {
    if (message.role !== "assistant" || currentChatId == null) return [];
    if (!isLastMessage) return frozenActivity ?? [];
    if (isStreaming) return filteredLiveActivity;
    return frozenActivity ?? filteredLiveActivity;
  }, [
    message.role,
    currentChatId,
    isLastMessage,
    isStreaming,
    frozenActivity,
    filteredLiveActivity,
  ]);

  const activityLogRows = useMemo(
    () => buildActivityLogRows(displayActivityItems),
    [displayActivityItems],
  );
  const hasActivityLogRows =
    message.role === "assistant" && activityLogRows.length > 0;
  const hasToolStreamActivity = displayActivityItems.some((i) => i.type === "tool_use");
  const suppressActivityLogForInlineThoughts =
    message.role === "assistant" &&
    isLastMessage &&
    isStreaming &&
    shouldRenderInlineThoughtsPanel(displayActivityItems, settings?.agentMode) &&
    !hasToolStreamActivity;
  const liftInlineThoughtsAboveStreamChrome =
    message.role === "assistant" &&
    isLastMessage &&
    isStreaming &&
    shouldRenderInlineThoughtsPanel(displayActivityItems, settings?.agentMode);
  const liftInlineThoughtsAboveCompletedChrome =
    message.role === "assistant" &&
    !isStreaming &&
    shouldRenderInlineThoughtsPanel(displayActivityItems, settings?.agentMode);
  const showAgentActivityLog =
    hasActivityLogRows && !suppressActivityLogForInlineThoughts;

  const counselPreviewItems = useMemo(() => {
    if (message.role !== "assistant") return [];
    if (counselPreviewPinned?.length) return counselPreviewPinned;
    const pool = isLastMessage ? displayActivityItems : frozenActivity ?? [];
    return pool.filter((i) =>
      [
        "counsel_start",
        "counsel_participant_complete",
        "counsel_synthesising",
        "counsel_complete",
      ].includes(i.type),
    );
  }, [
    message.role,
    counselPreviewPinned,
    isLastMessage,
    displayActivityItems,
    frozenActivity,
  ]);

  const showCounselPreview = counselPreviewItems.length > 0;

  const openActivityStreamPanel = () => {
    setRightPanelVisible(true);
    setPreviewTab("activity");
  };

  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);
  const lastTurnHadToolCallsByChatId = useAtomValue(lastTurnHadToolCallsByChatIdAtom);
  const doneAnimationState = useAtomValue(responseDoneAnimationAtom);
  const setDoneAnimation = useSetAtom(responseDoneAnimationAtom);
  const agentMode = settings?.agentMode ?? "guided";
  const isAgentAnimationMode = agentMode === "guided" || agentMode === "autonomous";
  const hasCounselStreamActivity = useMemo(() => {
    if (message.role !== "assistant" || !isLastMessage || !isStreaming) return false;
    return displayActivityItems.some((i) =>
      [
        "counsel_start",
        "counsel_participant_complete",
        "counsel_synthesising",
        "counsel_complete",
      ].includes(i.type),
    );
  }, [message.role, isLastMessage, isStreaming, displayActivityItems]);
  const streamingChipSecondary =
    showCounselPreview || hasCounselStreamActivity
      ? "Counsel"
      : isAgentAnimationMode
        ? "Working"
        : "Thinking";
  const modelDisplayName = useModelDisplayName();
  const lastAutoRoutedTier = useLastAutoRoutedTier(currentChatId);
  const autoRoutingOn = settings?.autoModelRouting === true;
  const streamingModelBadge =
    autoRoutingOn && lastAutoRoutedTier
      ? `Auto · ${formatAutoTierLabel(lastAutoRoutedTier)} tier`
      : modelDisplayName;
  const showNoActionsThisTurn =
    isLastMessage &&
    !isStreaming &&
    message.role === "assistant" &&
    isAgentAnimationMode &&
    currentChatId != null &&
    lastTurnHadToolCallsByChatId[currentChatId] === false;
  const { versions: liveVersions } = useVersions(appId);
  //handle copy chat
  const { copyMessageContent, copied } = useCopyToClipboard();
  const handleCopyFormatted = async () => {
    await copyMessageContent(message.content);
  };
  // Find the version that was active when this message was sent
  const messageVersion = useMemo(() => {
    if (
      message.role === "assistant" &&
      message.commitHash &&
      liveVersions.length
    ) {
      return (
        liveVersions.find(
          (version) =>
            message.commitHash &&
            version.oid.slice(0, 7) === message.commitHash.slice(0, 7),
        ) || null
      );
    }
    return null;
  }, [message.commitHash, message.role, liveVersions]);

  // handle copy request id
  const [copiedRequestId, setCopiedRequestId] = useState(false);
  const copiedRequestIdTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    return () => {
      if (copiedRequestIdTimeoutRef.current) {
        clearTimeout(copiedRequestIdTimeoutRef.current);
      }
    };
  }, []);

  // Clear "done" animation when time expires (when showing A beneath this message)
  const showDoneBeneath = Boolean(
    message.role === "assistant" &&
      isLastMessage &&
      !isStreaming &&
      currentChatId != null &&
      doneAnimationState?.chatId === currentChatId &&
      Date.now() < doneAnimationState.until
  );
  useEffect(() => {
    if (!showDoneBeneath || !doneAnimationState) return;
    const remaining = doneAnimationState.until - Date.now();
    if (remaining <= 0) {
      setDoneAnimation(null);
      return;
    }
    const t = setTimeout(() => setDoneAnimation(null), remaining);
    return () => clearTimeout(t);
  }, [showDoneBeneath, doneAnimationState, setDoneAnimation]);

  const planCardPayload = useMemo(() => {
    if (message.role !== "assistant") return null;
    const live =
      isStreaming && livePlanByAssistantMessageId.get(message.id);
    if (live && live.steps.length > 0) {
      return { data: live, collapsed: false as const, isLive: true as const };
    }
    const snap = planSnapshotsByMessageId[message.id];
    if (snap && snap.steps.length > 0) {
      const allDone = snap.steps.every((s) => s.status === "done" || s.status === "failed");
      const collapsed = !isLastMessage || (!isStreaming && snap.status === "complete" && allDone);
      return { data: snap, collapsed, isLive: false as const };
    }
    return null;
  }, [
    message.role,
    message.id,
    isLastMessage,
    isStreaming,
    livePlanByAssistantMessageId,
    planSnapshotsByMessageId,
  ]);

  // Format the message timestamp
  const formatTimestamp = (timestamp: string | Date) => {
    const now = new Date();
    const messageTime = new Date(timestamp);
    const diffInHours =
      (now.getTime() - messageTime.getTime()) / (1000 * 60 * 60);
    if (diffInHours < 24) {
      return formatDistanceToNow(messageTime, { addSuffix: true });
    } else {
      return format(messageTime, "MMM d, yyyy 'at' h:mm a");
    }
  };

  const handleEditSend = async () => {
    if (currentChatId == null || message.role !== "user") return;
    try {
      await IpcClient.getInstance().editMessage(currentChatId, message.id, editContent);
      const chat = await IpcClient.getInstance().getChat(currentChatId);
      setMessagesById((prev) => {
        const next = new Map(prev);
        next.set(currentChatId, chat.messages);
        return next;
      });
      setRestartedAfterMessageId(message.id);
      streamMessage({ prompt: "", chatId: currentChatId, continueAfterQuestions: true });
      setIsEditing(false);
    } catch (err) {
      showError(err);
    }
  };

  const handlePlanSwitchToBuild = (autoMessage: string, planData: PlanCardData) => {
    if (currentChatId == null || isStreaming) return;
    const steps = planData.taskGroups.flatMap((g) =>
      g.tasks.map((t) => ({ description: `${g.title}: ${t.label}` })),
    );
    void streamMessage({
      prompt: autoMessage,
      chatId: currentChatId,
      prefillTaskLedger: { steps },
    });
  };

  const isEphemeralChat =
    currentChatId != null && currentChatId < 0;
  const canCheckSnapshot =
    message.role === "assistant" &&
    !isStreaming &&
    Boolean(message.content) &&
    Boolean(appId) &&
    !isEphemeralChat;

  const [hasWorkspaceSnapshot, setHasWorkspaceSnapshot] = useState<
    boolean | null
  >(null);

  useEffect(() => {
    if (!canCheckSnapshot || !appId) {
      setHasWorkspaceSnapshot(null);
      return;
    }
    let cancelled = false;
    setHasWorkspaceSnapshot(null);
    void IpcClient.getInstance()
      .snapshotExists({ appId, turnId: String(message.id) })
      .then((exists) => {
        if (!cancelled) setHasWorkspaceSnapshot(exists);
      })
      .catch(() => {
        if (!cancelled) setHasWorkspaceSnapshot(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canCheckSnapshot, appId, message.id, message.content, isStreaming]);

  const handleRevertClick = async () => {
    if (currentChatId == null || message.role !== "assistant" || !appId) return;
    if (isEphemeralChat) {
      showError("File revert is not available for temporary workspace chats.");
      return;
    }
    if (hasWorkspaceSnapshot === false) {
      showError("No snapshot for this turn — nothing to revert.");
      return;
    }
    if (hasWorkspaceSnapshot !== true) return;
    const ok = window.confirm(
      "Revert workspace files and diagram to the state before this assistant reply?\n\nYour conversation stays visible; this turn and later messages will be marked as reverted.",
    );
    if (!ok) return;
    try {
      await IpcClient.getInstance().revertToMessage(currentChatId, message.id);
      const chat = await IpcClient.getInstance().getChat(currentChatId);
      setMessagesById((prev) => {
        const next = new Map(prev);
        next.set(currentChatId, chat.messages);
        return next;
      });
      setRestartedAfterMessageId(message.id);
      showInfo("Revert applied. Files and diagram restored; conversation unchanged.");
    } catch (err) {
      showError(err);
    }
  };

  return (
    <div
      className={`flex ${
        message.role === "assistant" ? "justify-start" : "justify-end"
      }`}
    >
      <div className={`mt-2 w-full max-w-3xl mx-auto group`}>
        <div
          className={`rounded-lg p-2 relative ${
            message.role === "assistant" ? "" : "ml-24 bg-(--sidebar-accent)"
          } ${message.isReverted ? "ring-1 ring-amber-500/40 bg-muted/30" : ""}${
            message.role === "user" && message.isSynthetic
              ? " opacity-80 border border-dashed border-border/50"
              : ""
          }`}
        >
          {message.role === "user" && !isEditing && !message.isSynthetic ? (
            <div className="absolute top-2 right-2 flex items-center gap-1">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleCopyFormatted}
                      className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-background/70 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-background transition-colors"
                      title="Copy"
                      aria-label="Copy message"
                    >
                      {copied ? (
                        <>
                          <Check className="h-3 w-3 text-green-500" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {copied ? "Copied!" : "Copy"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <button
                type="button"
                onClick={() => { setEditContent(message.content); setIsEditing(true); }}
                className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-background/70 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-background transition-colors"
                title="Edit"
                aria-label="Edit message"
              >
                <Edit2 className="h-3 w-3" />
                <span>Edit</span>
              </button>
            </div>
          ) : null}
          {message.role === "user" && message.isSynthetic && !isEditing ? (
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
              {message.content.trimStart().startsWith("Auto-correction (")
                ? "Auto-correction"
                : "Session compaction"}
            </div>
          ) : null}
          {message.role === "user" && isEditing ? (
            <>
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="w-full min-h-[80px] p-2 rounded border border-border bg-background text-sm resize-y"
                autoFocus
              />
              <div className="flex gap-2 mt-2">
                <Button size="sm" onClick={handleEditSend}>
                  Send
                </Button>
                <Button size="sm" variant="outline" onClick={() => { setIsEditing(false); setEditContent(message.content); }}>
                  Cancel
                </Button>
              </div>
            </>
          ) : message.role === "assistant" && isLastMessage && isStreaming ? (
            <>
              {liftInlineThoughtsAboveStreamChrome ? (
                <InlineThoughtsBlock className="mt-0 mb-2" />
              ) : null}
              {showAgentActivityLog ? (
                <div className="mb-2 space-y-1">
                  <AgentActivityLog
                    items={displayActivityItems}
                    isStreaming
                    defaultCollapsed={hasToolStreamActivity}
                  />
                  <button
                    type="button"
                    onClick={openActivityStreamPanel}
                    className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
                  >
                    ↗ View in Activity Stream
                  </button>
                </div>
              ) : null}
              {planCardPayload ? (
                <div className="mb-2">
                  <TaskLedgerPlanCard
                    task={planCardPayload.data.task}
                    steps={planCardPayload.data.steps}
                    status={planCardPayload.data.status}
                    isLive={planCardPayload.isLive}
                    collapsed={planCardPayload.collapsed}
                  />
                </div>
              ) : null}
              {/* Thoughts strip (when lifted) → activity → plan → answer + thinking inside parser */}
              {message.content ? (
                <div
                  className={CHAT_MESSAGE_MARKDOWN_PROSE}
                  suppressHydrationWarning
                >
                  <AtlarixMarkdownParser
                    content={message.content}
                    onPlanSwitchToBuild={handlePlanSwitchToBuild}
                    suppressInlineThoughts={
                      liftInlineThoughtsAboveStreamChrome || !isLastMessage
                    }
                  />
                </div>
              ) : null}
              {showCounselPreview ? (
                <CounselChatPreview items={counselPreviewItems} />
              ) : null}
              <div
                className={`${message.content ? "mt-2" : "mt-0"} flex justify-start`}
                aria-live="polite"
              >
                <div className="inline-flex items-center gap-2 max-w-full rounded-md border border-border/40 bg-muted/25 px-2 py-1 text-[11px] text-muted-foreground">
                  <Compass
                    className="h-3 w-3 shrink-0 text-primary/85 animate-spin-slow"
                    aria-hidden
                  />
                  <span className="font-medium text-foreground/85 truncate min-w-0">
                    {streamingModelBadge}
                  </span>
                  <span className="text-[10px] opacity-70 shrink-0">·</span>
                  <span className="text-[10px] shrink-0">{streamingChipSecondary}</span>
                  <span className="flex items-center gap-0.5 pl-0.5" aria-hidden>
                    <span className="inline-block h-1 w-1 rounded-full bg-primary/75 animate-pulse" />
                    <span className="inline-block h-1 w-1 rounded-full bg-primary/75 animate-pulse [animation-delay:150ms]" />
                    <span className="inline-block h-1 w-1 rounded-full bg-primary/75 animate-pulse [animation-delay:300ms]" />
                  </span>
                </div>
              </div>
            </>
          ) : (
            <div
              className={CHAT_MESSAGE_MARKDOWN_PROSE}
              suppressHydrationWarning
            >
              {message.role === "assistant" ? (
                <>
                  {liftInlineThoughtsAboveCompletedChrome ? (
                    <InlineThoughtsBlock className="mt-0 mb-2" />
                  ) : null}
                  {showAgentActivityLog ? (
                    <div className="mb-2 space-y-1">
                      <AgentActivityLog
                        items={displayActivityItems}
                        isStreaming={false}
                        defaultCollapsed
                      />
                      <button
                        type="button"
                        onClick={openActivityStreamPanel}
                        className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
                      >
                        ↗ View in Activity Stream
                      </button>
                    </div>
                  ) : null}
                  {planCardPayload ? (
                    <div className="mb-2">
                      <TaskLedgerPlanCard
                        task={planCardPayload.data.task}
                        steps={planCardPayload.data.steps}
                        status={planCardPayload.data.status}
                        isLive={planCardPayload.isLive}
                        collapsed={planCardPayload.collapsed}
                      />
                    </div>
                  ) : null}
                  <AtlarixMarkdownParser
                    content={message.content}
                    onPlanSwitchToBuild={handlePlanSwitchToBuild}
                    suppressInlineThoughts={
                      liftInlineThoughtsAboveCompletedChrome || !isLastMessage
                    }
                  />
                  {showCounselPreview ? (
                    <CounselChatPreview items={counselPreviewItems} />
                  ) : null}
                  {completedTurnArtifactsById[message.id] ? (
                    <TurnArtifactsCards artifacts={completedTurnArtifactsById[message.id]!} />
                  ) : null}
                  {showNoActionsThisTurn && (
                    <div className="mt-2 text-xs text-muted-foreground">No actions this turn.</div>
                  )}
                </>
              ) : (
                <>
                  {message.attachments && message.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {message.attachments.map((attachment) => (
                        <AttachmentChip
                          key={attachment.id}
                          id={attachment.id}
                          filename={attachment.filename}
                          mimeType={attachment.mimeType}
                          size={attachment.size}
                        />
                      ))}
                    </div>
                  )}
                  <VanillaMarkdownParser content={message.content} />
                </>
              )}
            </div>
          )}
          {/* Done phase: show A beneath last assistant message for ~2s after response completes */}
          {message.role === "assistant" && isLastMessage && !isStreaming && showDoneBeneath && (
            <div className="mt-3 flex justify-start">
              <AtlarixAnimation size="sm" phase="done" />
            </div>
          )}
          {(message.role === "assistant" && message.content && !isStreaming) ||
          message.approvalState ? (
            <div
              className={`mt-2 flex items-center ${
                message.role === "assistant" &&
                message.content &&
                !isStreaming &&
                message.approvalState
                  ? "justify-between"
                  : ""
              } text-xs`}
            >
              {message.role === "assistant" &&
                message.content &&
                !isStreaming && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          data-testid="copy-message-button"
                          onClick={handleCopyFormatted}
                          className="flex items-center space-x-1 px-2 py-1 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors duration-200 cursor-pointer"
                        >
                          {copied ? (
                            <Check className="h-4 w-4 text-green-500" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                          <span className="hidden sm:inline"></span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {copied ? "Copied!" : "Copy"}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              {message.approvalState && (
                <div className="flex items-center space-x-1">
                  {message.approvalState === "approved" ? (
                    <>
                      <CheckCircle className="h-4 w-4 text-green-500" />
                      <span>Approved</span>
                    </>
                  ) : message.approvalState === "rejected" ? (
                    <>
                      <XCircle className="h-4 w-4 text-red-500" />
                      <span>Rejected</span>
                    </>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}
        </div>
        {message.role === "assistant" && !isStreaming && Boolean(message.content) && (
          <div className="mt-1">
            {appId && !isEphemeralChat && hasWorkspaceSnapshot === true ? (
              <button
                type="button"
                onClick={handleRevertClick}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                <Undo2 className="h-3 w-3" />
                Revert workspace to here
              </button>
            ) : appId && isEphemeralChat ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-xs text-muted-foreground/50 flex items-center gap-1 cursor-not-allowed">
                      <Undo2 className="h-3 w-3" />
                      Revert workspace to here
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    File revert is not available for temporary workspace chats.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : appId &&
              !isEphemeralChat &&
              (hasWorkspaceSnapshot === false ||
                hasWorkspaceSnapshot === null) ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-xs text-muted-foreground/50 flex items-center gap-1 cursor-not-allowed">
                      <Undo2 className="h-3 w-3" />
                      Revert workspace to here
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {hasWorkspaceSnapshot === null
                      ? "Checking snapshot…"
                      : "No snapshot for this turn"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : !appId ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-xs text-muted-foreground/50 flex items-center gap-1 cursor-not-allowed">
                      <Undo2 className="h-3 w-3" />
                      Revert workspace to here
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Attach a workspace to enable code revert</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
            {message.isReverted ? (
              <span className="ml-2 text-xs text-amber-600 dark:text-amber-500">Reverted</span>
            ) : null}
          </div>
        )}
        {/* Timestamp and commit info for assistant messages - only visible on hover */}
        {message.role === "assistant" && message.createdAt && (
          <div className="mt-1 flex flex-wrap items-center justify-start space-x-2 text-xs text-gray-500 dark:text-gray-400 ">
            <div className="flex items-center space-x-1">
              <Clock className="h-3 w-3" />
              <span>{formatTimestamp(message.createdAt)}</span>
            </div>
            {messageVersion && messageVersion.message && (
              <div className="flex items-center space-x-1">
                <GitCommit className="h-3 w-3" />
                {messageVersion && messageVersion.message && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="max-w-50 truncate font-medium">
                        {
                          messageVersion.message
                            .replace(/^\[dyad\]\s*/i, "")
                            .split("\n")[0]
                        }
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{messageVersion.message}</TooltipContent>
                  </Tooltip>
                )}
              </div>
            )}
            {message.requestId && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => {
                        if (!message.requestId) return;
                        navigator.clipboard
                          .writeText(message.requestId)
                          .then(() => {
                            setCopiedRequestId(true);
                            if (copiedRequestIdTimeoutRef.current) {
                              clearTimeout(copiedRequestIdTimeoutRef.current);
                            }
                            copiedRequestIdTimeoutRef.current = setTimeout(
                              () => setCopiedRequestId(false),
                              2000,
                            );
                          })
                          .catch(() => {
                            // noop
                          });
                      }}
                      className="flex items-center space-x-1 px-1 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors duration-200 cursor-pointer"
                    >
                      {copiedRequestId ? (
                        <Check className="h-3 w-3 text-green-500" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      <span className="text-xs">
                        {copiedRequestId ? "Copied" : "Request ID"}
                      </span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {copiedRequestId
                      ? "Copied!"
                      : `Copy Request ID: ${message.requestId.slice(0, 8)}...`}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {isLastMessage && message.totalTokens && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center space-x-1 px-1 py-0.5">
                      <Info className="h-3 w-3" />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    Max tokens used: {message.totalTokens.toLocaleString()}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ChatMessage;
