/**
 * SimpleInlineChat
 * ================
 * A self-contained chat component for the home page.
 * Does NOT use any router-dependent hooks.
 * Receives all state as props or from atoms directly.
 */

import { useRef, useEffect, useCallback } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
    chatMessagesByIdAtom,
    chatStreamCountByIdAtom,
    isStreamingByIdAtom,
    activeChatIdAtom,
    pendingUserQuestionByChatIdAtom,
    questionsByMessageIdAtom,
    chatErrorByIdAtom,
} from "../atoms/chatAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { SimpleMessage } from "./SimpleMessage";
import { SimpleChatInput } from "./SimpleChatInput";
import { ToolIndicator } from "@/components/chat/ToolIndicator";
import { UserQuestionBar } from "@/components/chat/UserQuestionBar";
import { QuestionsWidget } from "@/components/chat/QuestionsWidget";
import { showError } from "@/lib/toast";
import { Plus } from "lucide-react";
import { sliceLastExchanges } from "../lib/chat/lastExchanges";
import { useStreamChat } from "@/hooks/useStreamChat";
import type { FileAttachment } from "@/ipc/ipc_types";
import { ChatErrorBox } from "@/components/chat/ChatErrorBox";
import { Button } from "@/components/ui/button";

interface SimpleInlineChatProps {
    chatId: number;
    onSendMessage: (prompt: string, attachments?: FileAttachment[]) => void;
    /** Start continuation stream after `<questions>` submit (same as MessagesList). */
    onContinueAfterQuestions?: () => void;
}

export function SimpleInlineChat({
    chatId,
    onSendMessage,
    onContinueAfterQuestions,
}: SimpleInlineChatProps) {
    const messagesById = useAtomValue(chatMessagesByIdAtom);
    const setMessagesById = useSetAtom(chatMessagesByIdAtom);
    const streamCountById = useAtomValue(chatStreamCountByIdAtom);
    const isStreamingById = useAtomValue(isStreamingByIdAtom);
    const errorById = useAtomValue(chatErrorByIdAtom);
    const setErrorById = useSetAtom(chatErrorByIdAtom);
    const setActiveChatId = useSetAtom(activeChatIdAtom);
    const pendingUserQuestionByChatId = useAtomValue(pendingUserQuestionByChatIdAtom);
    const questionsByMessageId = useAtomValue(questionsByMessageIdAtom);
    const setQuestionsByMessageId = useSetAtom(questionsByMessageIdAtom);
    // IMPORTANT: This component renders on non-"/chat" routes; avoid route-scoped search hooks.
    const { streamMessage } = useStreamChat({ hasChatId: false });

    useEffect(() => {
        void chatId;
    }, [chatId]);

    const messagesEndRef = useRef<HTMLDivElement | null>(null);
    const messagesContainerRef = useRef<HTMLDivElement | null>(null);

    const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
        messagesEndRef.current?.scrollIntoView({ behavior });
    }, []);

    // Scroll on new messages
    useEffect(() => {
        if (chatId) {
            scrollToBottom("instant");
        }
    }, [chatId, streamCountById.get(chatId) ?? 0, scrollToBottom]);

    // Fetch initial messages
    const fetchMessages = useCallback(async () => {
        try {
            const chat = await IpcClient.getInstance().getChat(chatId);
            setMessagesById((prev) => {
                const next = new Map(prev);
                next.set(chatId, chat.messages);
                return next;
            });
        } catch (error) {
            console.error("Failed to fetch messages:", error);
        }
    }, [chatId, setMessagesById]);

    useEffect(() => {
        fetchMessages();
    }, [fetchMessages]);

    const messages = messagesById.get(chatId) ?? [];
    const visibleMessages = sliceLastExchanges(messages, 7);
    const isStreaming = isStreamingById.get(chatId) ?? false;
    const error = errorById.get(chatId) ?? null;

    // Handle new chat - reset to home state
    const handleNewChat = useCallback(() => {
        setActiveChatId(null);
    }, [setActiveChatId]);

    const handleEditUserMessage = useCallback(
        async (messageId: number, newContent: string) => {
            await IpcClient.getInstance().editMessage(chatId, messageId, newContent);
            const chat = await IpcClient.getInstance().getChat(chatId);
            setMessagesById((prev) => {
                const next = new Map(prev);
                next.set(chatId, chat.messages);
                return next;
            });
            // Re-stream continuing from the edited message (chat-only mode uses continueAfterQuestions to avoid inserting a new user row).
            streamMessage({ prompt: "", chatId, continueAfterQuestions: true });
        },
        [chatId, setMessagesById, streamMessage],
    );

    return (
        <div className="flex flex-col h-full w-full max-w-4xl mx-auto overflow-hidden relative">
            {/* Fix: Finding 2 — pinned New Chat (always visible) */}
            <div className="flex-shrink-0 z-10 flex items-center justify-between gap-2 px-4 pt-3 pb-2 border-b border-border/40 bg-background/95">
                <button
                    type="button"
                    onClick={handleNewChat}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground bg-muted/50 border border-border/50 rounded-lg hover:bg-accent transition-colors"
                >
                    <Plus size={14} />
                    <span>New chat</span>
                </button>
            </div>

            <div className="flex-shrink-0 px-4 pb-2">
                <ToolIndicator forChatId={chatId} />
            </div>

            {error && (
                <div className="px-4">
                    <ChatErrorBox
                        error={error}
                        isAtlarixProEnabled={false}
                        onDismiss={() => {
                            setErrorById((prev) => {
                                const next = new Map(prev);
                                next.delete(chatId);
                                return next;
                            });
                        }}
                    />
                    <div className="mt-2 flex flex-wrap gap-2">
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                                setErrorById((prev) => {
                                    const next = new Map(prev);
                                    next.delete(chatId);
                                    return next;
                                });
                                streamMessage({ prompt: "", chatId, continueAfterQuestions: true });
                            }}
                        >
                            Retry
                        </Button>
                        <div className="text-xs text-muted-foreground flex items-center">
                            If this keeps happening, switch models using the selector below.
                        </div>
                    </div>
                </div>
            )}

            {/* Messages area - ONLY this should scroll */}
            <div
                ref={messagesContainerRef}
                className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
            >
                {visibleMessages.length === 0 && !isStreaming ? (
                    <div className="flex flex-col items-center justify-center min-h-[8rem] text-center text-muted-foreground text-sm px-4 gap-2">
                        <span>Starting chat…</span>
                        <span className="text-xs max-w-sm">
                            Chats are not kept as a long-lived history. Continuity comes from your Blueprint and files under{" "}
                            <code className="text-[10px] bg-muted px-1 rounded">.atlarix</code> (including the plan file).
                        </span>
                    </div>
                ) : (
                    visibleMessages.map((message, index) => (
                        <div key={message.id || index} className="contents">
                            <SimpleMessage
                                message={message}
                                isStreaming={isStreaming && index === visibleMessages.length - 1}
                                onEditUserMessage={handleEditUserMessage}
                            />
                            {message.role === "assistant" &&
                                onContinueAfterQuestions &&
                                (questionsByMessageId[message.id]?.questions?.length ?? 0) > 0 && (
                                    <QuestionsWidget
                                        messageId={message.id}
                                        questions={questionsByMessageId[message.id]!.questions}
                                        title={questionsByMessageId[message.id]!.title}
                                        onSubmit={async (answers) => {
                                            try {
                                                const qs = questionsByMessageId[message.id]!.questions;
                                                await IpcClient.getInstance().submitQuestionAnswers(
                                                    chatId,
                                                    message.id,
                                                    answers,
                                                    qs.map((q) => ({ id: q.id, question: q.question })),
                                                );
                                                setQuestionsByMessageId((prev) => {
                                                    const next = { ...prev };
                                                    delete next[message.id];
                                                    return next;
                                                });
                                                onContinueAfterQuestions();
                                            } catch (err) {
                                                showError(err);
                                            }
                                        }}
                                    />
                                )}
                        </div>
                    ))
                )}

                {/* Typing indicator when streaming with no assistant response yet */}
                {isStreaming && visibleMessages.length > 0 &&
                    visibleMessages[visibleMessages.length - 1].role === "user" && (
                        <div className="flex justify-start">
                            <div className="bg-muted rounded-lg p-4">
                                <div className="flex space-x-2">
                                    <div className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                                    <div className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                                    <div className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                                </div>
                            </div>
                        </div>
                    )}

                <div ref={messagesEndRef} />
            </div>

            {/* ask_user: PersistentChatContainer uses this overlay; HomeChatInput is unmounted — bar must live here */}
            <div className="flex-shrink-0 px-4 pb-2">
                <UserQuestionBar chatId={chatId} />
            </div>

            {/* Rich input with model switcher */}
            <SimpleChatInput
                chatId={chatId}
                onSubmit={(prompt, attachments) => {
                    setErrorById((prev) => {
                        const next = new Map(prev);
                        next.delete(chatId);
                        return next;
                    });
                    onSendMessage(prompt, attachments);
                }}
                placeholder="Continue the conversation..."
            />
        </div>
    );
}
