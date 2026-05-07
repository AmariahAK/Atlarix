/**
 * SimpleChatInput
 * ===============
 * A rich chat input component without router dependencies.
 * Supports model switcher and file attachments like the home input.
 */

import React, { useRef, useEffect, useCallback } from "react";
import { SendIcon, Paperclip, StopCircle, ChartColumnIncreasing, X, ChevronDown, Upload } from "lucide-react";
import { useSettings } from "@/hooks/useSettings";
import { useAtom, useAtomValue } from "jotai";
import { isStreamingByIdAtom, chatInputValueAtom } from "@/atoms/chatAtoms";
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

interface SimpleChatInputProps {
    chatId: number;
    onSubmit: (prompt: string, attachments?: FileAttachment[]) => void;
    placeholder?: string;
}

export function SimpleChatInput({ chatId, onSubmit, placeholder = "Continue the conversation..." }: SimpleChatInputProps) {
    // Use global atom so "Fix with AI" button can pre-fill this input
    const [inputValue, setInputValue] = useAtom(chatInputValueAtom);
    const [tokenUsagePopoverOpen, setTokenUsagePopoverOpen] = useState(false);
    const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
    const { settings } = useSettings();
    const isStreamingById = useAtomValue(isStreamingByIdAtom);
    const isStreaming = isStreamingById.get(chatId) ?? false;
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const [attachments, setAttachments] = useState<FileAttachment[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const { isAuthenticated, loading: authLoading } = useAuth();
    const mustSignIn = !authLoading && !isAuthenticated;
    // Prevent double-submit when clicking rapidly or "Fix with AI" triggers re-renders
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isDragOver, setIsDragOver] = useState(false);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        if (!isStreaming && !mustSignIn) {
            setIsDragOver(true);
        }
    }, [isStreaming, mustSignIn]);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
        if (isStreaming || mustSignIn) return;

        const files = Array.from(e.dataTransfer.files);
        if (files.length === 0) return;

        const newAttachments: FileAttachment[] = files.map(file => ({
            file,
            type: "chat-context",
        }));
        // #region agent log
        fetch('http://127.0.0.1:7913/ingest/68e9ef74-ad12-4ebe-96ed-f3aaf700f18c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4330ef'},body:JSON.stringify({sessionId:'4330ef',runId:'pre-fix',hypothesisId:'U1',location:'SimpleChatInput.tsx:handleDrop',message:'Drop attachments',data:{chatId,newCount:newAttachments.length,names:newAttachments.slice(0,3).map(a=>a.file.name)},timestamp:Date.now()})}).catch(()=>{});
        // #endregion agent log
        setAttachments(prev => [...prev, ...newAttachments]);
    }, [isStreaming, mustSignIn]);

    // Auto-resize textarea when value changes (e.g., pre-filled by "Fix with AI")
    useEffect(() => {
        if (inputRef.current) {
            inputRef.current.style.height = 'auto';
            inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 160)}px`;
        }
    }, [inputValue]);

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []);
        if (files.length === 0) return;

        const newAttachments: FileAttachment[] = files.map(file => ({
            file,
            type: "chat-context",
        }));
        // #region agent log
        fetch('http://127.0.0.1:7913/ingest/68e9ef74-ad12-4ebe-96ed-f3aaf700f18c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4330ef'},body:JSON.stringify({sessionId:'4330ef',runId:'pre-fix',hypothesisId:'U1',location:'SimpleChatInput.tsx:handleFileSelect',message:'File select attachments',data:{chatId,newCount:newAttachments.length,names:newAttachments.slice(0,3).map(a=>a.file.name)},timestamp:Date.now()})}).catch(()=>{});
        // #endregion agent log
        setAttachments(prev => [...prev, ...newAttachments]);
        e.target.value = '';
    };

    const removeAttachment = (index: number) => {
        setAttachments(prev => prev.filter((_, i) => i !== index));
    };

    useEffect(() => {
        // #region agent log
        fetch('http://127.0.0.1:7913/ingest/68e9ef74-ad12-4ebe-96ed-f3aaf700f18c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4330ef'},body:JSON.stringify({sessionId:'4330ef',runId:'pre-fix',hypothesisId:'U3',location:'SimpleChatInput.tsx:attachmentsEffect',message:'Attachments state changed',data:{chatId,count:attachments.length,names:attachments.slice(0,3).map(a=>a.file.name)},timestamp:Date.now()})}).catch(()=>{});
        // #endregion agent log
    }, [attachments, chatId]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if ((!inputValue.trim() && attachments.length === 0) || isStreaming || isSubmitting) return;

        if (mustSignIn) {
            import("@/lib/toast").then(({ showError }) => {
                showError("Please sign in to use chat.");
            });
            return;
        }

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
        // #region agent log
        fetch('http://127.0.0.1:7913/ingest/68e9ef74-ad12-4ebe-96ed-f3aaf700f18c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4330ef'},body:JSON.stringify({sessionId:'4330ef',runId:'pre-fix',hypothesisId:'U2',location:'SimpleChatInput.tsx:handleSubmit',message:'Submitted message (cleared attachments)',data:{chatId,submitAttachmentCount:attachments.length,inputLen:inputValue.length},timestamp:Date.now()})}).catch(()=>{});
        // #endregion agent log

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

    const effectivePlaceholder = mustSignIn ? "Sign in to continue…" : placeholder;

    return (
        <div
            className={cn(
                "p-4 border-t border-border transition-colors",
                isDragOver && "bg-purple-500/10"
            )}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            {/* Attachment preview chips */}
            {attachments.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                    {attachments.map((att, idx) => (
                        <div
                            key={idx}
                            className="flex items-center gap-1.5 px-2.5 py-1 bg-muted rounded-full text-xs text-foreground"
                        >
                            <Upload className="w-3 h-3 text-purple-500" />
                            <span className="max-w-[100px] truncate">{att.file.name}</span>
                            <button
                                onClick={() => removeAttachment(idx)}
                                className="ml-1 hover:text-destructive"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {mustSignIn ? (
                <div className="mb-2">
                    <SignInToChatNotice />
                </div>
            ) : null}

            {/* Drag-drop overlay */}
            {isDragOver && (
                <div className="mb-3 p-4 border-2 border-dashed border-purple-500/50 rounded-lg text-center text-sm text-purple-400">
                    Drop files to attach
                </div>
            )}

            <div className="flex flex-col space-y-2 border border-border rounded-lg bg-background/50 shadow-sm">
                <form onSubmit={handleSubmit} className="flex items-center">
                    <textarea
                        ref={inputRef as any}
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={effectivePlaceholder}
                        disabled={isStreaming || mustSignIn}
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

                    {/* File attachment button with menu */}
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
                                            disabled={isStreaming || mustSignIn}
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
                                    setAttachmentMenuOpen(false);
                                }}
                            >
                                <Upload className="w-4 h-4" />
                                Upload from computer
                            </Button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                multiple
                                className="hidden"
                                onChange={handleFileSelect}
                            />
                        </PopoverContent>
                    </Popover>

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
                            disabled={(!inputValue.trim() && attachments.length === 0) || mustSignIn}
                        >
                            <SendIcon className="h-4 w-4" />
                        </Button>
                    )}
                </form>

                {/* Model switcher and controls */}
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
