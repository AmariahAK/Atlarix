/**
 * SimpleInlineChat
 * ================
 * A self-contained chat component for the home page.
 * Does NOT use any router-dependent hooks.
 * Receives all state as props or from atoms directly.
 */

import { useRef, useEffect, useCallback, useState } from "react";
import { useAtomValue, useSetAtom, getDefaultStore } from "jotai";
import {
    chatMessagesByIdAtom,
    chatStreamCountByIdAtom,
    isStreamingByIdAtom,
    activeChatIdAtom,
    pendingUserQuestionByChatIdAtom,
    chatErrorByIdAtom,
} from "../atoms/chatAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { SimpleMessage } from "./SimpleMessage";
import { SimpleChatInput } from "./SimpleChatInput";
import { InlineUserQuestions } from "@/components/chat/InlineUserQuestions";
import { BackgroundJobsIndicator } from "@/components/chat/BackgroundJobsIndicator";
import { Plus, ArrowDown } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStreamChat } from "@/hooks/useStreamChat";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import type { FileAttachment, Message } from "@/ipc/ipc_types";
import { ChatErrorBox } from "@/components/chat/ChatErrorBox";
import { Button } from "@/components/ui/button";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { LoadedSessionBanner } from "@/components/chat/LoadedSessionBanner";
import { startNewWorkspaceConversation } from "@/lib/open-workspace-session";
import { InlineStreamStatus } from "@/components/chat/InlineStreamStatus";

interface SimpleInlineChatProps {
    chatId: number;
    onSendMessage: (prompt: string, attachments?: FileAttachment[]) => void;
}

export function SimpleInlineChat({
    chatId,
    onSendMessage,
}: SimpleInlineChatProps) {
    const messagesById = useAtomValue(chatMessagesByIdAtom);
    const setMessagesById = useSetAtom(chatMessagesByIdAtom);
    const isStreamingById = useAtomValue(isStreamingByIdAtom);
    const streamCountById = useAtomValue(chatStreamCountByIdAtom);
    const errorById = useAtomValue(chatErrorByIdAtom);
    const setErrorById = useSetAtom(chatErrorByIdAtom);
    const setActiveChatId = useSetAtom(activeChatIdAtom);
    const selectedAppId = useAtomValue(selectedAppIdAtom);
    const setPendingUserQuestionByChatId = useSetAtom(pendingUserQuestionByChatIdAtom);
    const { streamMessage } = useStreamChat({ hasChatId: false });
    const [chatAppId, setChatAppId] = useState<number | null>(() =>
        selectedAppId != null ? selectedAppId : null,
    );

    useEffect(() => {
        if (selectedAppId != null) {
            setChatAppId((prev) => prev ?? selectedAppId);
        }
    }, [selectedAppId, chatId]);

    const messagesEndRef = useRef<HTMLDivElement | null>(null);
    const messagesContainerRef = useRef<HTMLDivElement | null>(null);

    const { isAtBottomRef, scrollToBottom, onContentChange, showJumpButton } =
        useStickToBottom(messagesContainerRef, messagesEndRef);

    const streamCount = streamCountById.get(chatId) ?? 0;

    // Switching chats: jump straight to the latest and re-pin to the bottom.
    useEffect(() => {
        if (chatId) {
            isAtBottomRef.current = true;
            scrollToBottom("auto");
        }
    }, [chatId, scrollToBottom, isAtBottomRef]);

    const fetchMessages = useCallback(async () => {
        const existing = getDefaultStore().get(chatMessagesByIdAtom).get(chatId);
        if (existing && existing.length > 0) {
            const { replaceDisplayHydrationForChat } = await import(
                "@/lib/chat/apply-stream-display-hydration"
            );
            replaceDisplayHydrationForChat(chatId, existing);
            return;
        }
        try {
            const chat = await IpcClient.getInstance().getChat(chatId);
            setChatAppId(chat.appId ?? null);
            setMessagesById((prev) => {
                const next = new Map(prev);
                next.set(chatId, chat.messages);
                return next;
            });
            const { applyStreamDisplayHydration } = await import(
                "@/lib/chat/apply-stream-display-hydration"
            );
            applyStreamDisplayHydration(chat.messages);
        } catch (error) {
            console.error("Failed to fetch messages:", error);
        }
    }, [chatId, setMessagesById]);

    useEffect(() => {
        fetchMessages();
    }, [fetchMessages]);

    const messages = messagesById.get(chatId) ?? [];
    // Render the FULL conversation (parity with Claude Code / opencode) — no
    // last-N-exchanges cutoff. System messages are excluded from the view; the
    // memoized SimpleMessage rows keep this cheap even for long sessions.
    const visibleMessages = messages.filter(
        (m) => m && (m.role === "user" || m.role === "assistant"),
    );
    // Anchor the settled "A" to the LAST assistant message, not the last array
    // element — a trailing synthetic/user message (compaction continuation,
    // self-correction) would otherwise flip it off and the indicator vanishes.
    const lastAssistantIndex = visibleMessages
        .map((m) => m.role)
        .lastIndexOf("assistant");
    const isStreaming = isStreamingById.get(chatId) ?? false;
    const error = errorById.get(chatId) ?? null;

    // Virtualize the SETTLED messages (everything but the most recent) so long
    // sessions stay smooth; the last row is the one that streams/grows, so it's
    // rendered in normal DOM (outside the virtualizer) to avoid measure thrash,
    // alongside the trailing live region (status / questions / bg jobs / anchor).
    const settledMessages =
        visibleMessages.length > 0 ? visibleMessages.slice(0, -1) : [];
    const lastMessage =
        visibleMessages.length > 0
            ? visibleMessages[visibleMessages.length - 1]
            : null;
    const lastMessageIsLatestAssistant =
        lastAssistantIndex === visibleMessages.length - 1;

    const rowVirtualizer = useVirtualizer({
        count: settledMessages.length,
        getScrollElement: () => messagesContainerRef.current,
        estimateSize: () => 220,
        overscan: 6,
    });

    // Follow streaming output (and any content growth) only when the user is
    // already pinned to the bottom; otherwise leave their scroll position alone.
    useEffect(() => {
        onContentChange();
    }, [messages, streamCount, onContentChange]);
    const handleNewChat = useCallback(async () => {
        const workspaceId = selectedAppId ?? chatAppId;
        if (workspaceId != null) {
            await startNewWorkspaceConversation({ workspaceId });
            return;
        }
        setActiveChatId(null);
    }, [selectedAppId, chatAppId, setActiveChatId]);

    const handleEditUserMessage = useCallback(
        async (messageId: number, newContent: string) => {
            await IpcClient.getInstance().editMessage(chatId, messageId, newContent);
            const chat = await IpcClient.getInstance().getChat(chatId);
            setChatAppId(chat.appId ?? null);
            setMessagesById((prev) => {
                const next = new Map(prev);
                next.set(chatId, chat.messages);
                return next;
            });
            const { applyStreamDisplayHydration } = await import(
                "@/lib/chat/apply-stream-display-hydration"
            );
            applyStreamDisplayHydration(chat.messages);
            // Reproduce the edited message's own work mode on resend so the turn
            // is deterministic instead of drifting to whatever global settings
            // happen to be. Fall back to undefined (global) when unset.
            const edited = chat.messages.find((m) => m.id === messageId);
            const workModeOverride = edited?.workMode ?? undefined;
            streamMessage({
                prompt: "",
                chatId,
                continueAfterQuestions: true,
                workModeOverride,
            });
        },
        [chatId, setMessagesById, streamMessage],
    );

    const handleContinue = useCallback(
        async (message: Message) => {
            if (isStreaming) return;
            // Promote the interrupted draft to a normal history message so its
            // partial content is preserved, then resume with a fresh turn.
            if (message.sessionRowId) {
                try {
                    await IpcClient.getInstance().markSessionMessageComplete(
                        message.sessionRowId,
                    );
                } catch (e) {
                    console.error("Failed to mark interrupted message complete:", e);
                }
            }
            setMessagesById((prev) => {
                const next = new Map(prev);
                const list = next.get(chatId);
                if (list) {
                    next.set(
                        chatId,
                        list.map((m) =>
                            m.id === message.id ? { ...m, interrupted: false } : m,
                        ),
                    );
                }
                return next;
            });
            streamMessage({
                prompt: "Continue from where you left off, without repeating what you already wrote.",
                chatId,
            });
        },
        [chatId, isStreaming, setMessagesById, streamMessage],
    );

    return (
        <div className="flex flex-col h-full min-h-0 w-full max-w-4xl mx-auto overflow-hidden relative">
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

            <LoadedSessionBanner />

            <div className="relative flex-1 min-h-0 flex flex-col">
            <div
                ref={messagesContainerRef}
                className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4 [overflow-anchor:auto]"
            >
                {visibleMessages.length === 0 && !isStreaming ? (
                    <div className="flex flex-col items-center justify-center min-h-[8rem] text-center text-muted-foreground text-sm px-4 gap-2">
                        <span>Starting chat…</span>
                        <span className="text-xs max-w-sm">
                            Workspace conversations save as sessions in the sidebar — resume anytime.
                        </span>
                    </div>
                ) : (
                    <>
                        {/* Virtualized settled history — only on-screen rows mount.
                            Rows are absolutely positioned (so per-row pb-4 carries
                            the inter-message gap, not the container's space-y). */}
                        <div
                            style={{
                                height: rowVirtualizer.getTotalSize(),
                                position: "relative",
                                width: "100%",
                            }}
                        >
                            {rowVirtualizer.getVirtualItems().map((vi) => {
                                const message = settledMessages[vi.index];
                                return (
                                    <div
                                        key={message.id ?? `idx-${vi.index}`}
                                        data-index={vi.index}
                                        ref={rowVirtualizer.measureElement}
                                        className="pb-4"
                                        style={{
                                            position: "absolute",
                                            top: 0,
                                            left: 0,
                                            width: "100%",
                                            transform: `translateY(${vi.start}px)`,
                                        }}
                                    >
                                        <SimpleMessage
                                            message={message}
                                            chatId={chatId}
                                            workspaceAppId={chatAppId}
                                            isStreaming={false}
                                            isLatestAssistant={vi.index === lastAssistantIndex}
                                            onEditUserMessage={handleEditUserMessage}
                                            onContinue={handleContinue}
                                        />
                                    </div>
                                );
                            })}
                        </div>

                        {/* The most-recent row streams/grows — keep it in normal
                            DOM so the virtualizer never re-measures a moving target. */}
                        {lastMessage && (
                            <div className="pb-4">
                                <SimpleMessage
                                    message={lastMessage}
                                    chatId={chatId}
                                    workspaceAppId={chatAppId}
                                    isStreaming={isStreaming}
                                    isLatestAssistant={lastMessageIsLatestAssistant}
                                    onEditUserMessage={handleEditUserMessage}
                                    onContinue={handleContinue}
                                />
                            </div>
                        )}
                    </>
                )}

                {isStreaming && lastMessage?.role === "user" && (
                        <div className="flex justify-start">
                            <div className="bg-muted rounded-lg px-4 py-2">
                                <InlineStreamStatus chatId={chatId} active />
                            </div>
                        </div>
                    )}

                {/* ask_user: inline question card under the response that asked (turn has ended). */}
                <InlineUserQuestions chatId={chatId} />

                {/* v14: background commands running in the background (cancellable). */}
                <BackgroundJobsIndicator chatId={chatId} />

                <div ref={messagesEndRef} className="[overflow-anchor:none]" />
            </div>

                {showJumpButton && (
                    <button
                        type="button"
                        onClick={() => scrollToBottom("smooth")}
                        aria-label="Jump to latest"
                        className="absolute bottom-3 right-4 z-10 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground bg-background/95 backdrop-blur-sm border border-border/60 rounded-full shadow-md hover:bg-accent transition-colors"
                    >
                        <ArrowDown size={14} />
                        <span>Jump to latest</span>
                    </button>
                )}
            </div>

            <div className="flex-shrink-0 px-4 pb-2 space-y-2">
                {/* Stream failure: pinned just above the input (never scrolled away),
                    aligned with the slow-stream warning — not at the top of the page. */}
                {error && (
                    <div data-testid="chat-error-bottom">
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
            </div>

            <SimpleChatInput
                chatId={chatId}
                onSubmit={(prompt, attachments) => {
                    setErrorById((prev) => {
                        const next = new Map(prev);
                        next.delete(chatId);
                        return next;
                    });
                    // v11.1: typing a fresh message supersedes any pending
                    // ask_user card (the turn already ended — answering is
                    // optional, like Claude Code).
                    setPendingUserQuestionByChatId((prev) => {
                        if (!prev[chatId]) return prev;
                        const next = { ...prev };
                        delete next[chatId];
                        return next;
                    });
                    onSendMessage(prompt, attachments);
                }}
                disabled={isStreaming}
            />
        </div>
    );
}
