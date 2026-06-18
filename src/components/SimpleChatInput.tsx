/**
 * SimpleChatInput
 * ===============
 * A rich chat input component without router dependencies.
 * Supports model switcher and file attachments like the home input.
 */

import React, { useRef, useEffect } from "react";
import { SendIcon, Paperclip, StopCircle, ChartColumnIncreasing, Upload } from "lucide-react";
import { useSettings } from "@/hooks/useSettings";
import { useAtom, useAtomValue } from "jotai";
import {
    isStreamingByIdAtom,
    chatInputValueAtom,
    queuedMessageByChatIdAtom,
} from "@/atoms/chatAtoms";
import { ChatInputControls } from "@/components/ChatInputControls";
import { Button } from "@/components/ui/button";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { TokenBar } from "@/components/chat/TokenBar";
import type { FileAttachment } from "@/ipc/ipc_types";
import { useState } from "react";
import { useAuth } from "@/lib/auth/useAuth";
import { SignInToChatNotice } from "@/components/chat/SignInToChatNotice";
import { cn } from "@/lib/utils";
import { useAttachments } from "@/hooks/useAttachments";
import { AttachmentsList } from "@/components/chat/AttachmentsList";
import { DragDropOverlay } from "@/components/chat/DragDropOverlay";
import { useComposerAutocomplete } from "@/components/chat/ComposerAutocomplete";

interface SimpleChatInputProps {
    chatId: number;
    onSubmit: (prompt: string, attachments?: FileAttachment[]) => void;
    placeholder?: string;
    disabled?: boolean;
}

export function SimpleChatInput({ chatId, onSubmit, placeholder = "Continue the conversation..." }: SimpleChatInputProps) {
    const [inputValue, setInputValue] = useAtom(chatInputValueAtom);
    const [tokenUsagePopoverOpen, setTokenUsagePopoverOpen] = useState(false);
    const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
    const { settings } = useSettings();
    const isStreamingById = useAtomValue(isStreamingByIdAtom);
    const isStreaming = isStreamingById.get(chatId) ?? false;
    // v13.1: while ANY turn is streaming, the user can type and queue ONE
    // follow-up message that is sent automatically when the turn ends (the
    // stop square stays visible; Enter/Send queues). Generalizes the v13 7B
    // waiting-on-command queue to every streaming state.
    const [queuedByChatId, setQueuedByChatId] = useAtom(queuedMessageByChatIdAtom);
    const queuedMessage = queuedByChatId.get(chatId);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const { menu: autocompleteMenu, onKeyDown: autocompleteKeyDown } =
        useComposerAutocomplete({
            value: inputValue,
            setValue: setInputValue,
            textareaRef: inputRef,
            mentionChips: true,
        });
    const { isAuthenticated, loading: authLoading } = useAuth();
    const mustSignIn = !authLoading && !isAuthenticated;
    const [isSubmitting, setIsSubmitting] = useState(false);

    const {
        attachments,
        fileInputRef,
        isDraggingOver,
        handleFileSelect,
        removeAttachment,
        handleDragOver,
        handleDragLeave,
        handleDrop,
        clearAttachments,
        handlePaste,
        handlePasteCapture,
    } = useAttachments();

    const attachDisabled = isStreaming || mustSignIn;
    const sendDisabled =
        isSubmitting ||
        mustSignIn ||
        (!inputValue.trim() && attachments.length === 0) ||
        // While streaming, the send button queues a message — disabled only
        // once the single queue slot is full.
        (isStreaming && queuedMessage != null);

    useEffect(() => {
        if (inputRef.current) {
            inputRef.current.style.height = 'auto';
            inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 160)}px`;
        }
    }, [inputValue]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if ((!inputValue.trim() && attachments.length === 0) || isSubmitting) return;

        // Streaming: queue ONE text message; useStreamChat flushes it when the
        // turn ends. Attachments stay disabled mid-stream, so this is text-only.
        if (isStreaming) {
            if (queuedMessage != null || !inputValue.trim()) return;
            const toQueue = inputValue;
            setQueuedByChatId((prev) => {
                const n = new Map(prev);
                n.set(chatId, toQueue);
                return n;
            });
            setInputValue("");
            inputRef.current?.focus();
            return;
        }

        if (mustSignIn) {
            import("@/lib/toast").then(({ showError }) => {
                showError("Please sign in to use chat.");
            });
            return;
        }

        setIsSubmitting(true);

        const hasModel = settings?.selectedModel ||
            ((settings?.providerSettings?.ollama as { models?: unknown[] } | undefined)?.models?.length ?? 0) > 0 ||
            ((settings?.providerSettings?.lmstudio as { models?: unknown[] } | undefined)?.models?.length ?? 0) > 0;

        if (!hasModel) {
            import("@/lib/toast").then(({ showError }) => {
                showError("Please select a model first");
            });
            setIsSubmitting(false);
            return;
        }

        onSubmit(inputValue, attachments);
        setInputValue("");
        clearAttachments();

        setTimeout(() => setIsSubmitting(false), 100);
        inputRef.current?.focus();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // The `/` `@` autocomplete menu gets first crack at nav/select/esc keys.
        if (autocompleteKeyDown(e)) return;
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit(e as unknown as React.FormEvent);
        }
    };

    if (!settings) return null;

    // v13.2: while streaming the action slot shows Stop (not Send), so the
    // placeholder carries the queue affordance instead of a second button.
    const effectivePlaceholder = mustSignIn
        ? "Sign in to continue…"
        : isStreaming
            ? queuedMessage != null
                ? "One message already queued…"
                : "Type a follow-up — Enter queues it for when the turn ends…"
            : placeholder;

    return (
        <div
            className={cn(
                "p-4 border-t border-border transition-colors",
                isDraggingOver && "bg-purple-500/10"
            )}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            {mustSignIn ? (
                <div className="mb-2">
                    <SignInToChatNotice />
                </div>
            ) : null}

            <div
                className={cn(
                    "relative flex flex-col space-y-2 border border-border rounded-lg bg-background/50 shadow-sm",
                    isDraggingOver && "ring-2 ring-blue-500 border-blue-500",
                )}
            >
                {autocompleteMenu}
                <AttachmentsList
                    attachments={attachments}
                    onRemove={removeAttachment}
                />

                <DragDropOverlay isDraggingOver={isDraggingOver} />

                <form onSubmit={handleSubmit} className="flex items-center" onPasteCapture={handlePasteCapture}>
                    <textarea
                        ref={inputRef}
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onPaste={handlePaste}
                        placeholder={effectivePlaceholder}
                        disabled={mustSignIn}
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

                    <Popover open={attachmentMenuOpen} onOpenChange={setAttachmentMenuOpen}>
                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <PopoverTrigger asChild>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="mx-1"
                                            disabled={attachDisabled}
                                            title="Attach file"
                                        >
                                            <Paperclip className="h-4 w-4" />
                                        </Button>
                                    </PopoverTrigger>
                                </TooltipTrigger>
                                <TooltipContent>Attach file</TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                        <PopoverContent align="start" side="top" className="w-56 p-2">
                            <Button
                                variant="ghost"
                                className="w-full justify-start text-sm gap-2"
                                onClick={() => {
                                    fileInputRef.current?.click();
                                }}
                            >
                                <Upload className="w-4 h-4" />
                                Upload from computer
                            </Button>
                        </PopoverContent>
                    </Popover>
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                            if (e.target.files?.length) {
                                handleFileSelect(e.target.files, "chat-context");
                            }
                            setAttachmentMenuOpen(false);
                            e.target.value = "";
                        }}
                    />

                    {/* v13.2: ONE action slot — Stop replaces Send while
                        streaming (and vice versa). Enter still queues a
                        follow-up mid-stream (handleSubmit); the queued chip
                        below carries that state. */}
                    {isStreaming ? (
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="mx-1 hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => {
                                import("@/ipc/ipc_client").then(({ IpcClient }) => {
                                    IpcClient.getInstance().cancelChatStream(chatId);
                                });
                            }}
                            title="Stop generation (Enter queues your typed message)"
                        >
                            <StopCircle className="h-4 w-4" />
                        </Button>
                    ) : (
                        <Button
                            type="submit"
                            variant="ghost"
                            size="icon"
                            className="mx-1"
                            disabled={sendDisabled}
                            title="Send"
                        >
                            <SendIcon className="h-4 w-4" />
                        </Button>
                    )}
                </form>

                {queuedMessage != null ? (
                    <div className="mx-3 mb-1 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
                        <span className="shrink-0 font-medium">Queued — sends when the turn ends:</span>
                        <span className="truncate flex-1">{queuedMessage}</span>
                        <button
                            type="button"
                            className="shrink-0 hover:text-foreground"
                            title="Cancel queued message"
                            onClick={() =>
                                setQueuedByChatId((prev) => {
                                    const n = new Map(prev);
                                    n.delete(chatId);
                                    return n;
                                })
                            }
                        >
                            ×
                        </button>
                    </div>
                ) : null}

                <div className="px-2 pb-2 flex items-center justify-between gap-2">
                    <ChatInputControls chatId={chatId} />
                    <Popover open={tokenUsagePopoverOpen} onOpenChange={setTokenUsagePopoverOpen}>
                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <PopoverTrigger asChild>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            className={`has-[>svg]:px-2 shrink-0 ${tokenUsagePopoverOpen ? "text-purple-500 bg-purple-100 dark:bg-purple-950/40" : ""}`}
                                            size="sm"
                                            data-testid="simple-chat-token-bar-toggle"
                                            aria-expanded={tokenUsagePopoverOpen}
                                        >
                                            <ChartColumnIncreasing size={14} />
                                        </Button>
                                    </PopoverTrigger>
                                </TooltipTrigger>
                                <TooltipContent>
                                    {tokenUsagePopoverOpen ? "Close token usage" : "Show token usage"}
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                        <PopoverContent
                            align="end"
                            side="top"
                            className="w-auto max-w-[min(100vw,22rem)] p-0"
                            sideOffset={8}
                        >
                            <TokenBar chatId={chatId} includeCompassMonthlyStrip={false} />
                        </PopoverContent>
                    </Popover>
                </div>
            </div>
        </div>
    );
}
