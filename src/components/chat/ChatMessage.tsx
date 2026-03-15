import type { Message } from "@/ipc/ipc_types";
import {
  AtlarixMarkdownParser,
  VanillaMarkdownParser,
} from "./AtlarixMarkdownParser";
import { motion } from "framer-motion";
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
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { useVersions } from "@/hooks/useVersions";
import { useAtomValue, useSetAtom } from "jotai";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { activeChatIdAtom, lastTurnHadToolCallsByChatIdAtom, responseDoneAnimationAtom, restartedAfterMessageIdAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";
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
import { chatMessagesByIdAtom } from "@/atoms/chatAtoms";
import { showError, showInfo } from "@/lib/toast";
import { Button } from "@/components/ui/button";

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
  const setRestartedAfterMessageId = useSetAtom(restartedAfterMessageIdAtom);
  const currentChatId = activeChatId ?? selectedChatId;
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);
  const lastTurnHadToolCallsByChatId = useAtomValue(lastTurnHadToolCallsByChatIdAtom);
  const doneAnimationState = useAtomValue(responseDoneAnimationAtom);
  const setDoneAnimation = useSetAtom(responseDoneAnimationAtom);
  const agentMode = settings?.agentMode ?? "guided";
  const isAgentAnimationMode = agentMode === "guided" || agentMode === "autonomous";
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

  const handleRevertClick = async () => {
    if (currentChatId == null || message.role !== "assistant" || !message.snapshotId) return;
    const filesNote =
      message.filesWritten && message.filesWritten.length > 0
        ? ` ${message.filesWritten.length} file(s) were written after this point — code revert coming in v3.10.`
        : "";
    const ok = window.confirm(
      `Revert conversation?\n\nThis will remove all messages after this one.${filesNote}`
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
      showInfo("Conversation reverted. Code changes from removed exchanges are still on disk — file revert coming in a future update.");
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
          }`}
        >
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
              {/* Content first, then compass beneath (Claude-style) */}
              {!message.content ? (
                <div className="h-4" />
              ) : (
                <div
                  className="prose dark:prose-invert prose-headings:mb-2 prose-p:my-1 prose-pre:my-0 max-w-none break-words"
                  suppressHydrationWarning
                >
                  <AtlarixMarkdownParser content={message.content} />
                  <div className="mt-4 ml-4 relative w-5 h-5 animate-spin">
                    <div className="absolute top-0 left-1/2 transform -translate-x-1/2 w-2 h-2 bg-(--primary) dark:bg-blue-500 rounded-full"></div>
                    <div className="absolute bottom-0 left-0 w-2 h-2 bg-(--primary) dark:bg-blue-500 rounded-full opacity-80"></div>
                    <div className="absolute bottom-0 right-0 w-2 h-2 bg-(--primary) dark:bg-blue-500 rounded-full opacity-60"></div>
                  </div>
                </div>
              )}
              <div className="mt-3 flex items-center gap-3">
                <div className="shrink-0">
                  <AtlarixAnimation size="sm" phase="thinking" />
                </div>
                <span className="text-sm font-medium text-muted-foreground">
                  {isAgentAnimationMode ? "Agent working…" : "Thinking…"}
                </span>
              </div>
            </>
          ) : (
            <div
              className="prose dark:prose-invert prose-headings:mb-2 prose-p:my-1 prose-pre:my-0 max-w-none break-words"
              suppressHydrationWarning
            >
              {message.role === "assistant" ? (
                <>
                  <AtlarixMarkdownParser content={message.content} />
                  {showNoActionsThisTurn && (
                    <div className="mt-2 text-xs text-muted-foreground">No actions this turn.</div>
                  )}
                </>
              ) : (
                <VanillaMarkdownParser content={message.content} />
              )}
            </div>
          )}
          {/* Done phase: show A beneath last assistant message for ~2s after response completes */}
          {message.role === "assistant" && isLastMessage && !isStreaming && showDoneBeneath && (
            <div className="mt-3 flex justify-start">
              <AtlarixAnimation size="sm" phase="done" />
            </div>
          )}
          {message.role === "user" && !isEditing && (
            <button
              type="button"
              onClick={() => { setEditContent(message.content); setIsEditing(true); }}
              className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 p-1.5 rounded hover:bg-muted transition-opacity"
              title="Edit message"
              aria-label="Edit message"
            >
              <Edit2 className="h-4 w-4 text-muted-foreground" />
            </button>
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
        {/* v3.9: Revert to here (assistant messages with snapshot) */}
        {message.role === "assistant" && message.snapshotId != null && !isStreaming && (
          <div className="mt-1">
            <button
              type="button"
              onClick={handleRevertClick}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              <Undo2 className="h-3 w-3" />
              Revert to here
            </button>
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
