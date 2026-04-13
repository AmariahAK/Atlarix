import type React from "react";
import type { Message } from "@/ipc/ipc_types";
import { forwardRef, useState } from "react";
import ChatMessage from "./ChatMessage";
import { SetupBanner } from "../SetupBanner";

import { useStreamChat } from "@/hooks/useStreamChat";
import { selectedChatIdAtom, chatMessagesByIdAtom, questionsByMessageIdAtom, restartedAfterMessageIdAtom } from "@/atoms/chatAtoms";
import { useAtomValue, useSetAtom } from "jotai";
import { Loader2, RefreshCw, Undo } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useVersions } from "@/hooks/useVersions";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { showError, showWarning } from "@/lib/toast";
import { IpcClient } from "@/ipc/ipc_client";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { useSettings } from "@/hooks/useSettings";
import { useUserBudgetInfo } from "@/hooks/useUserBudgetInfo";
import { PromoMessage } from "./PromoMessage";
import { ContextLimitBanner } from "./ContextLimitBanner";
import { useCountTokens } from "@/hooks/useCountTokens";
import { QuestionsWidget } from "./QuestionsWidget";

interface MessagesListProps {
  messages: Message[];
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

export const MessagesList = forwardRef<HTMLDivElement, MessagesListProps>(
  function MessagesList({ messages, messagesEndRef }, ref) {
    const appId = useAtomValue(selectedAppIdAtom);
    const { versions, revertVersion } = useVersions(appId);
    const { streamMessage, isStreaming } = useStreamChat();
    const { isAnyProviderSetup, isProviderSetup } = useLanguageModelProviders();
    const { settings } = useSettings();
    const setMessagesById = useSetAtom(chatMessagesByIdAtom);
    const questionsByMessageId = useAtomValue(questionsByMessageIdAtom);
    const setQuestionsByMessageId = useSetAtom(questionsByMessageIdAtom);
    const restartedAfterMessageId = useAtomValue(restartedAfterMessageIdAtom);
    const [isUndoLoading, setIsUndoLoading] = useState(false);
    const [isRetryLoading, setIsRetryLoading] = useState(false);
    const selectedChatId = useAtomValue(selectedChatIdAtom);
    const { userBudget } = useUserBudgetInfo();
    const { result: tokenCountResult } = useCountTokens(selectedChatId, "");

    const renderSetupBanner = () => {
      const selectedModel = settings?.selectedModel;
      if (
        selectedModel?.provider === "auto" &&
        !isProviderSetup("compass")
      ) {
        return (
          <div className="w-full">
            <SetupBanner />
          </div>
        );
      }
      if (!isAnyProviderSetup()) {
        return <SetupBanner />;
      }
      return null;
    };

    return (
      <div
        className="absolute inset-0 overflow-y-auto p-4"
        ref={ref}
        data-testid="messages-list"
      >
        {messages.length > 0
          ? messages.map((message, index) => (
              <div key={message.id ?? index} className="contents">
                <ChatMessage
                  message={message}
                  isLastMessage={index === messages.length - 1}
                />
                {message.role === "assistant" &&
                  questionsByMessageId[message.id]?.length > 0 && (
                    <QuestionsWidget
                      messageId={message.id}
                      questions={questionsByMessageId[message.id]}
                      onSubmit={async (answers) => {
                        if (!selectedChatId) return;
                        try {
                          await IpcClient.getInstance().submitQuestionAnswers(
                            selectedChatId,
                            message.id,
                            answers
                          );
                          setQuestionsByMessageId((prev) => {
                            const next = { ...prev };
                            delete next[message.id];
                            return next;
                          });
                          streamMessage({
                            prompt: "",
                            chatId: selectedChatId,
                            continueAfterQuestions: true,
                          });
                        } catch (err) {
                          showError(err);
                        }
                      }}
                    />
                  )}
                {restartedAfterMessageId === message.id && (
                  <div className="w-full max-w-3xl mx-auto py-2 flex items-center gap-2">
                    <span className="flex-1 border-t border-border" />
                    <span className="text-xs text-muted-foreground">conversation restarted from here</span>
                    <span className="flex-1 border-t border-border" />
                  </div>
                )}
              </div>
            ))
          : !renderSetupBanner() && (
              <div className="flex flex-col items-center justify-center h-full max-w-2xl mx-auto">
                <div className="flex flex-1 items-center justify-center text-gray-500">
                  No messages yet
                </div>
              </div>
            )}
        {/* Show context limit banner when close to token limit (stale estimate while streaming) */}
        {tokenCountResult && (
          <div className="max-w-3xl mx-auto w-full space-y-1">
            {isStreaming && (
              <p className="text-xs text-muted-foreground px-1">
                Estimate may update after this reply finishes.
              </p>
            )}
            <ContextLimitBanner
              totalTokens={tokenCountResult.actualMaxTokens}
              contextWindow={tokenCountResult.contextWindow}
            />
          </div>
        )}
        {!isStreaming && (
          <div className="flex max-w-3xl mx-auto gap-2">
            {!!messages.length &&
              messages[messages.length - 1].role === "assistant" &&
              messages[messages.length - 1].commitHash && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isUndoLoading}
                  onClick={async () => {
                    if (!selectedChatId || !appId) {
                      console.error("No chat selected or app ID not available");
                      return;
                    }

                    setIsUndoLoading(true);
                    try {
                      if (messages.length >= 3) {
                        const previousAssistantMessage =
                          messages[messages.length - 3];
                        if (
                          previousAssistantMessage?.role === "assistant" &&
                          previousAssistantMessage?.commitHash
                        ) {
                          await revertVersion({
                            versionId: previousAssistantMessage.commitHash,
                          });
                          const chat =
                            await IpcClient.getInstance().getChat(
                              selectedChatId,
                            );
                          setMessagesById((prev) => {
                            const next = new Map(prev);
                            next.set(selectedChatId, chat.messages);
                            return next;
                          });
                        }
                      } else {
                        const chat =
                          await IpcClient.getInstance().getChat(selectedChatId);
                        if (chat.initialCommitHash) {
                          await revertVersion({
                            versionId: chat.initialCommitHash,
                          });
                          try {
                            await IpcClient.getInstance().deleteMessages(
                              selectedChatId,
                            );
                            setMessagesById((prev) => {
                              const next = new Map(prev);
                              next.set(selectedChatId, []);
                              return next;
                            });
                          } catch (err) {
                            showError(err);
                          }
                        } else {
                          showWarning(
                            "No initial commit hash found for chat. Need to manually undo code changes",
                          );
                        }
                      }
                    } catch (error) {
                      console.error("Error during undo operation:", error);
                      showError("Failed to undo changes");
                    } finally {
                      setIsUndoLoading(false);
                    }
                  }}
                >
                  {isUndoLoading ? (
                    <Loader2 size={16} className="mr-1 animate-spin" />
                  ) : (
                    <Undo size={16} />
                  )}
                  Undo
                </Button>
              )}
            {!!messages.length && (
              <Button
                variant="outline"
                size="sm"
                disabled={isRetryLoading}
                onClick={async () => {
                  if (!selectedChatId) {
                    console.error("No chat selected");
                    return;
                  }

                  setIsRetryLoading(true);
                  try {
                    // The last message is usually an assistant, but it might not be.
                    const lastVersion = versions[0];
                    const lastMessage = messages[messages.length - 1];
                    let shouldRedo = true;
                    if (
                      lastVersion.oid === lastMessage.commitHash &&
                      lastMessage.role === "assistant"
                    ) {
                      const previousAssistantMessage =
                        messages[messages.length - 3];
                      if (
                        previousAssistantMessage?.role === "assistant" &&
                        previousAssistantMessage?.commitHash
                      ) {
                        await revertVersion({
                          versionId: previousAssistantMessage.commitHash,
                        });
                        shouldRedo = false;
                      } else {
                        const chat =
                          await IpcClient.getInstance().getChat(selectedChatId);
                        if (chat.initialCommitHash) {
                          await revertVersion({
                            versionId: chat.initialCommitHash,
                          });
                        } else {
                          showWarning(
                            "No initial commit hash found for chat. Need to manually undo code changes",
                          );
                        }
                      }
                    }

                    // Find the last user message
                    const lastUserMessage = [...messages]
                      .reverse()
                      .find((message) => message.role === "user");
                    if (!lastUserMessage) {
                      console.error("No user message found");
                      return;
                    }
                    // Need to do a redo, if we didn't delete the message from a revert.
                    const redo = shouldRedo;

                    streamMessage({
                      prompt: lastUserMessage.content,
                      chatId: selectedChatId,
                      redo,
                    });
                  } catch (error) {
                    console.error("Error during retry operation:", error);
                    showError("Failed to retry message");
                  } finally {
                    setIsRetryLoading(false);
                  }
                }}
              >
                {isRetryLoading ? (
                  <Loader2 size={16} className="mr-1 animate-spin" />
                ) : (
                  <RefreshCw size={16} />
                )}
                Retry
              </Button>
            )}
          </div>
        )}

        {isStreaming &&
          !settings?.enableAtlarixPro &&
          !userBudget &&
          messages.length > 0 && (
            <PromoMessage
              seed={messages.length * (appId ?? 1) * (selectedChatId ?? 1)}
            />
          )}
        <div ref={messagesEndRef} />
        {renderSetupBanner()}
      </div>
    );
  },
);
