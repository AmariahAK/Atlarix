/**
 * SimpleInlineChat
 * ================
 * A self-contained chat component for the home page.
 * Does NOT use any router-dependent hooks.
 * Receives all state as props or from atoms directly.
 */

import { useRef, useEffect, useCallback, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
    chatMessagesByIdAtom,
    chatStreamCountByIdAtom,
    isStreamingByIdAtom,
    activeChatIdAtom,
} from "../atoms/chatAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { SimpleMessage } from "./SimpleMessage";
import { SimpleChatInput } from "./SimpleChatInput";
import { Plus } from "lucide-react";

interface SimpleInlineChatProps {
    chatId: number;
    onSendMessage: (prompt: string) => void;
}

export function SimpleInlineChat({ chatId, onSendMessage }: SimpleInlineChatProps) {
    const messagesById = useAtomValue(chatMessagesByIdAtom);
    const setMessagesById = useSetAtom(chatMessagesByIdAtom);
    const streamCountById = useAtomValue(chatStreamCountByIdAtom);
    const isStreamingById = useAtomValue(isStreamingByIdAtom);
    const setActiveChatId = useSetAtom(activeChatIdAtom);
    const [isHoveringTop, setIsHoveringTop] = useState(false);

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
    const isStreaming = isStreamingById.get(chatId) ?? false;

    // Handle new chat - reset to home state
    const handleNewChat = useCallback(() => {
        setActiveChatId(null);
    }, [setActiveChatId]);

    return (
        <div className="flex flex-col h-full w-full max-w-4xl mx-auto overflow-hidden relative">
            {/* Hover-reveal New Chat button at top-left */}
            <div
                className="absolute top-0 left-0 right-0 h-16 z-10"
                onMouseEnter={() => setIsHoveringTop(true)}
                onMouseLeave={() => setIsHoveringTop(false)}
            >
                <div
                    className={`absolute top-3 left-4 transition-all duration-200 ${isHoveringTop ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2"
                        }`}
                >
                    <button
                        onClick={handleNewChat}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground bg-background/80 backdrop-blur-sm border border-border/50 rounded-lg hover:bg-accent transition-colors"
                    >
                        <Plus size={14} />
                        <span>New Chat</span>
                    </button>
                </div>
            </div>

            {/* Messages area - ONLY this should scroll */}
            <div
                ref={messagesContainerRef}
                className="flex-1 overflow-y-auto px-4 py-6 space-y-4 pt-10"
            >
                {messages.length === 0 && !isStreaming ? (
                    <div className="flex items-center justify-center h-32 text-muted-foreground">
                        Starting chat...
                    </div>
                ) : (
                    messages.map((message, index) => (
                        <SimpleMessage
                            key={message.id || index}
                            message={message}
                            isStreaming={isStreaming && index === messages.length - 1}
                        />
                    ))
                )}

                {/* Typing indicator when streaming with no assistant response yet */}
                {isStreaming && messages.length > 0 &&
                    messages[messages.length - 1].role === "user" && (
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

            {/* Rich input with model switcher */}
            <SimpleChatInput
                chatId={chatId}
                onSubmit={(prompt) => onSendMessage(prompt)}
                placeholder="Continue the conversation..."
            />
        </div>
    );
}
