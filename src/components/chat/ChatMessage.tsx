import type { Message } from "@/ipc/ipc_types";
import { resolvePasteAttachmentsForMessage } from "@/lib/chat/paste-attachment-meta";
import {
  CHAT_MESSAGE_MARKDOWN_PROSE,
  UserMessageMarkdownParser,
} from "./AtlarixMarkdownParser";
import { AssistantMessageBody } from "./AssistantMessageBody";
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
  FileText,
  Download,
  X,
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { useVersions } from "@/hooks/useVersions";
import { getDefaultStore, useAtomValue, useSetAtom } from "jotai";
import {
  currentAppAtom,
  selectedAppIdAtom,
  selectedWorkspaceInfoAtom,
} from "@/atoms/appAtoms";
import {
  workspacePlanPanelAtom,
  rightPanelVisibleAtom,
} from "@/atoms/sourceAtoms";
import { chatIdToSessionIdAtom } from "@/atoms/sessionAtoms";
import {
  activeChatIdAtom,
  chatMessagesByIdAtom,
  lastTurnHadToolCallsByChatIdAtom,
  livePlanUpdateByAssistantMessageIdAtom,
  planSnapshotByAssistantMessageIdAtom,
  responseDoneAnimationAtom,
  restartedAfterMessageIdAtom,
  selectedChatIdAtom,
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
import { IpcClient } from "@/ipc/ipc_client";
import { showError, showInfo } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import {
  extractPlanIdsFromContent,
  type PlanCardData,
} from "@/lib/plan-cards/plan-card-renderer";
import { TaskLedgerPlanCard } from "./TaskLedgerPlanCard";
import { AttachmentChip } from "./AttachmentChip";
import type { WorkMode } from "@/lib/schemas";
import { labelForWorkMode, settingsPatchForWorkMode } from "@/lib/work-mode";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RotateCcw } from "lucide-react";
import {
  resolveWorkspaceAppId,
  showWorkspaceModeControls as shouldShowWorkspaceModeControls,
} from "@/lib/chat/show-workspace-mode-controls";
import { resolveChatWorkspaceAppId } from "@/lib/chat-workspace-binding";

interface ChatMessageProps {
  message: Message;
  isLastMessage: boolean;
}

const ChatMessage = ({ message, isLastMessage }: ChatMessageProps) => {
  const { isStreaming, streamMessage } = useStreamChat();
  const { settings, updateSettings } = useSettings();
  const appId = useAtomValue(selectedAppIdAtom);
  const currentApp = useAtomValue(currentAppAtom);
  const workspaceInfo = useAtomValue(selectedWorkspaceInfoAtom);
  const activeChatId = useAtomValue(activeChatIdAtom);
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const setMessagesById = useSetAtom(chatMessagesByIdAtom);
  const setRestartedAfterMessageId = useSetAtom(restartedAfterMessageIdAtom);
  const currentChatId = activeChatId ?? selectedChatId;
  const livePlanByAssistantMessageId = useAtomValue(livePlanUpdateByAssistantMessageIdAtom);
  const planSnapshotsByMessageId = useAtomValue(planSnapshotByAssistantMessageIdAtom);

  const [isEditing, setIsEditing] = useState(false);
  const [resendMode, setResendMode] = useState<WorkMode>(
    () =>
      (message.workMode as WorkMode | null | undefined) ??
      settings?.workModePreference ??
      "ask",
  );
  const [editContent, setEditContent] = useState(message.content);
  const lastTurnHadToolCallsByChatId = useAtomValue(lastTurnHadToolCallsByChatIdAtom);
  const doneAnimationState = useAtomValue(responseDoneAnimationAtom);
  const setDoneAnimation = useSetAtom(responseDoneAnimationAtom);
  const isAgentAnimationMode = true;
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

  /** Task-ledger step card — only when there is no session plan artifact marker in content. */
  const ledgerPlanCardPayload = useMemo(() => {
    if (message.role !== "assistant") return null;
    const content = message.content ?? "";
    if (extractPlanIdsFromContent(content).length > 0) {
      return null;
    }
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
    message.content,
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
      if (showWorkspaceModeControls) {
        await updateSettings(settingsPatchForWorkMode(resendMode));
      }
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

  const handleResendInMode = async () => {
    if (currentChatId == null || message.role !== "user" || isStreaming) return;
    try {
      await updateSettings(settingsPatchForWorkMode(resendMode));
      await IpcClient.getInstance().editMessage(currentChatId, message.id, message.content);
      const chat = await IpcClient.getInstance().getChat(currentChatId);
      setMessagesById((prev) => {
        const next = new Map(prev);
        next.set(currentChatId, chat.messages);
        return next;
      });
      setRestartedAfterMessageId(message.id);
      streamMessage({
        prompt: "",
        chatId: currentChatId,
        continueAfterQuestions: true,
        workModeOverride: resendMode,
      });
    } catch (err) {
      showError(err);
    }
  };

  const WORK_MODES_RESEND: WorkMode[] = ["ask", "plan", "build", "debug", "review"];

  const handlePlanSwitchToBuild = async (autoMessage: string, _planData: PlanCardData) => {
    if (currentChatId == null || isStreaming) return;
    await updateSettings(settingsPatchForWorkMode("build"));
    const panel = getDefaultStore().get(workspacePlanPanelAtom);
    const planId = panel.planId;
    if (planId) {
      try {
        await IpcClient.getInstance().setPlanArtifactStatus(planId, "building");
      } catch {
        /* ignore */
      }
    }
    void streamMessage({
      prompt: autoMessage,
      chatId: currentChatId,
      workModeOverride: "build",
    });
  };

  const handlePlanArtifactBuild = async (planId: string) => {
    if (currentChatId == null || isStreaming) return;
    await updateSettings(settingsPatchForWorkMode("build"));
    try {
      const payload = await IpcClient.getInstance().getPlanArtifact(planId);
      if (payload) {
        await IpcClient.getInstance().setPlanArtifactStatus(planId, "building");
      }
    } catch {
      /* ignore */
    }
    void streamMessage({
      prompt:
        "Implement the plan in the Plan panel step by step. Follow the phases and items in order.",
      chatId: currentChatId,
      workModeOverride: "build",
    });
  };

  const isEphemeralChat =
    currentChatId != null && currentChatId < 0;
  const resolvedWorkspaceAppId = resolveWorkspaceAppId({
    chatBoundAppId: resolveChatWorkspaceAppId(currentChatId),
    selectedAppId: appId,
    currentAppId: currentApp?.id ?? null,
    workspaceInfoId: workspaceInfo?.id ?? null,
  });
  const showWorkspaceModeControls = shouldShowWorkspaceModeControls(
    message,
    resolvedWorkspaceAppId,
  );
  const canCheckSnapshot =
    message.role === "assistant" &&
    !isStreaming &&
    Boolean(message.content) &&
    Boolean(resolvedWorkspaceAppId) &&
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
                onClick={() => {
                  setEditContent(message.content);
                  setResendMode(
                    (message.workMode as WorkMode | null | undefined) ??
                      settings?.workModePreference ??
                      "ask",
                  );
                  setIsEditing(true);
                }}
                disabled={isStreaming}
                className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-background/70 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-background transition-colors disabled:opacity-40"
                title={isStreaming ? "Wait for the current response to finish" : "Edit"}
                aria-label="Edit message"
              >
                <Edit2 className="h-3 w-3" />
                <span>Edit</span>
              </button>
              {showWorkspaceModeControls ? (
                <button
                  type="button"
                  onClick={() => void handleResendInMode()}
                  disabled={isStreaming}
                  className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-background/70 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-background transition-colors disabled:opacity-40"
                  title={isStreaming ? "Wait for the current response to finish" : "Resend in current composer mode"}
                  aria-label="Resend message"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>Resend</span>
                </button>
              ) : null}
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
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="w-full min-h-[80px] p-2 rounded border border-border bg-background text-sm resize-y"
              autoFocus
            />
          ) : (
            <div
              className={CHAT_MESSAGE_MARKDOWN_PROSE}
              suppressHydrationWarning
            >
              {message.role === "assistant" ? (
                <>
                  {ledgerPlanCardPayload ? (
                    <div className="mb-2">
                      <TaskLedgerPlanCard
                        task={ledgerPlanCardPayload.data.task}
                        steps={ledgerPlanCardPayload.data.steps}
                        status={ledgerPlanCardPayload.data.status}
                        isLive={ledgerPlanCardPayload.isLive}
                        collapsed={ledgerPlanCardPayload.collapsed}
                      />
                    </div>
                  ) : null}
                  <AssistantMessageBody
                    content={message.content ?? ""}
                    assistantMessageId={message.id}
                    chatId={message.chatId}
                    isStreaming={isLastMessage && isStreaming}
                    onPlanSwitchToBuild={handlePlanSwitchToBuild}
                    onPlanArtifactBuild={(id) => void handlePlanArtifactBuild(id)}
                    planArtifactBuildDisabled={isStreaming}
                  />
                  {showNoActionsThisTurn ? (
                    <div className="mt-2 text-xs text-muted-foreground">No actions this turn.</div>
                  ) : null}
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
                  <UserMessageMarkdownParser
                    content={message.content}
                    pasteAttachments={(() => {
                      const pastes = resolvePasteAttachmentsForMessage(message);
                      return pastes.length > 0 ? pastes : undefined;
                    })()}
                  />
                </>
              )}
            </div>
          )}
          {message.role === "user" &&
            !message.isSynthetic &&
            isEditing &&
            !isStreaming && (
              <div className="flex justify-end mt-1 flex-wrap items-center gap-1">
                {showWorkspaceModeControls ? (
                  <>
                    <span className="text-[11px] text-muted-foreground px-1">Mode</span>
                    <Select
                      value={resendMode}
                      onValueChange={(v) => setResendMode(v as WorkMode)}
                      disabled={isStreaming}
                    >
                      <SelectTrigger className="h-7 w-[108px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WORK_MODES_RESEND.map((m) => (
                          <SelectItem key={m} value={m} className="text-xs">
                            {labelForWorkMode(m)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                ) : null}
                <Button size="sm" onClick={handleEditSend} disabled={isStreaming}>
                  {showWorkspaceModeControls ? "Send" : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isStreaming}
                  onClick={() => {
                    setIsEditing(false);
                    setEditContent(message.content);
                    setResendMode(
                      (message.workMode as WorkMode | null | undefined) ??
                        settings?.workModePreference ??
                        "ask",
                    );
                  }}
                >
                  Cancel
                </Button>
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
                            .replace(/^\[(?:atlarix|dyad)\]\s*/i, "")
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
