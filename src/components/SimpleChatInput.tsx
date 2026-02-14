/**
 * SimpleChatInput
 * ===============
 * A rich chat input component without router dependencies.
 * Supports model switcher and file attachments like the home input.
 */

import React, { useRef, useEffect } from "react";
import { SendIcon, Paperclip, StopCircle } from "lucide-react";
import { useSettings } from "@/hooks/useSettings";
import { useAtom, useAtomValue } from "jotai";
import { isStreamingByIdAtom, chatInputValueAtom } from "@/atoms/chatAtoms";
import { ChatInputControls } from "@/components/ChatInputControls";
import { Button } from "@/components/ui/button";
import type { FileAttachment } from "@/ipc/ipc_types";
import { useState } from "react";

interface SimpleChatInputProps {
    chatId: number;
    onSubmit: (prompt: string, attachments?: FileAttachment[]) => void;
    placeholder?: string;
}

export function SimpleChatInput({ chatId, onSubmit, placeholder = "Continue the conversation..." }: SimpleChatInputProps) {
    // Use global atom so "Fix with AI" button can pre-fill this input
    const [inputValue, setInputValue] = useAtom(chatInputValueAtom);
    const { settings } = useSettings();
    const isStreamingById = useAtomValue(isStreamingByIdAtom);
    const isStreaming = isStreamingById.get(chatId) ?? false;
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const [attachments, setAttachments] = useState<FileAttachment[]>([]);
    // Prevent double-submit when clicking rapidly or "Fix with AI" triggers re-renders
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Auto-resize textarea when value changes (e.g., pre-filled by "Fix with AI")
    useEffect(() => {
        if (inputRef.current) {
            inputRef.current.style.height = 'auto';
            inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 160)}px`;
        }
    }, [inputValue]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!inputValue.trim() || isStreaming || isSubmitting) return;

        // Set submitting guard immediately
        setIsSubmitting(true);

        // Check model is selected
        const hasModel = settings?.selectedModel ||
            ((settings?.providerSettings?.ollama as { models?: unknown[] } | undefined)?.models?.length ?? 0) > 0 ||
            ((settings?.providerSettings?.lmstudio as { models?: unknown[] } | undefined)?.models?.length ?? 0) > 0;

        if (!hasModel) {
            import("@/lib/toast").then(({ showError }) => {
                showError("Please select a model first");
            });
            setIsSubmitting(false); // Reset guard on early return
            return;
        }

        onSubmit(inputValue, attachments);
        setInputValue("");
        setAttachments([]);

        // Reset submitting guard after a short delay to prevent double-clicks
        setTimeout(() => setIsSubmitting(false), 100);
        inputRef.current?.focus();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit(e as any);
        }
    };

    if (!settings) return null;

    return (
        <div className="p-4 border-t border-border">
            <div className="flex flex-col space-y-2 border border-border rounded-lg bg-background/50 shadow-sm">
                <form onSubmit={handleSubmit} className="flex items-center">
                    <textarea
                        ref={inputRef as any}
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={placeholder}
                        disabled={isStreaming}
                        rows={1}
                        className="flex-1 px-4 py-3 bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-50 resize-none max-h-40 overflow-y-auto"
                        style={{
                            minHeight: '44px',
                            height: 'auto'
                        }}
                        onInput={(e) => {
                            const target = e.target as HTMLTextAreaElement;
                            target.style.height = 'auto';
                            target.style.height = `${Math.min(target.scrollHeight, 160)}px`;
                        }}
                    />

                    {/* File attachment button */}
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="mx-1"
                        disabled={isStreaming}
                        title="Attach file"
                    >
                        <Paperclip className="h-4 w-4" />
                    </Button>

                    {/* Send/Stop button */}
                    {isStreaming ? (
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="mx-1 hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => {
                                // Stop the chat stream
                                import("@/ipc/ipc_client").then(({ IpcClient }) => {
                                    IpcClient.getInstance().cancelChatStream(chatId);
                                });
                            }}
                            title="Stop generation"
                        >
                            <StopCircle className="h-4 w-4" />
                        </Button>
                    ) : (
                        <Button
                            type="submit"
                            variant="ghost"
                            size="icon"
                            className="mx-1"
                            disabled={!inputValue.trim()}
                        >
                            <SendIcon className="h-4 w-4" />
                        </Button>
                    )}
                </form>

                {/* Model switcher and controls */}
                <div className="px-2 pb-2">
                    <ChatInputControls />
                </div>
            </div>
        </div>
    );
}
