/**
 * SimpleChatInput
 * ===============
 * A rich chat input component without router dependencies.
 * Supports model switcher and file attachments like the home input.
 */

import React, { useRef, useEffect } from "react";
import {
  SendIcon,
  Paperclip,
  StopCircle,
  ChartColumnIncreasing,
  Upload,
} from "lucide-react";
import { useSettings } from "@/hooks/useSettings";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { IpcClient } from "@/ipc/ipc_client";
import {
  isStreamingByIdAtom,
  chatInputValueAtom,
  pendingInterjectionsByChatIdAtom,
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
import { VoiceInputButton } from "@/components/chat/VoiceInputButton";
import type { FileAttachment } from "@/ipc/ipc_types";
import { useState } from "react";
import { useChatInputDraft } from "@/hooks/useChatInputDraft";
import { useAuth } from "@/lib/auth/useAuth";
import { SignInToChatNotice } from "@/components/chat/SignInToChatNotice";
import { cn } from "@/lib/utils";
import { useAttachments } from "@/hooks/useAttachments";
import { AttachmentsList } from "@/components/chat/AttachmentsList";
import { ParkedWaitingChip } from "@/components/chat/ParkedWaitingChip";
import { PendingApprovalsBar } from "@/components/chat/PendingApprovalsBar";
import { ComposerTip } from "@/components/chat/ComposerTip";
import { DragDropOverlay } from "@/components/chat/DragDropOverlay";
import { useComposerAutocomplete } from "@/components/chat/ComposerAutocomplete";
import { useLiveTurnTokenUsage } from "@/hooks/useLiveTurnTokenUsage";

interface SimpleChatInputProps {
  chatId: number;
  onSubmit: (prompt: string, attachments?: FileAttachment[]) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function SimpleChatInput({
  chatId,
  onSubmit,
  placeholder = "Continue the conversation...",
}: SimpleChatInputProps) {
  const [inputValue, setInputValue] = useAtom(chatInputValueAtom);
  const [tokenUsagePopoverOpen, setTokenUsagePopoverOpen] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  // Dictation: live mode re-transcribes the whole clip, so each interim result
  // REPLACES the session's text on top of whatever was already typed; the base
  // is captured once per session and cleared on the final result.
  const dictationBaseRef = useRef<string | null>(null);
  const handleTranscript = (text: string, isFinal: boolean) => {
    if (dictationBaseRef.current === null) {
      dictationBaseRef.current = inputValue ? `${inputValue.trimEnd()} ` : "";
    }
    setInputValue(`${dictationBaseRef.current}${text}`);
    if (isFinal) dictationBaseRef.current = null;
  };
  const { settings } = useSettings();
  // Keep live per-turn token usage fresh here (always-mounted composer) so the
  // meter climbs live even when the usage popover is closed.
  useLiveTurnTokenUsage(chatId);
  // Unsent text survives a session switch and a quit. Both submit paths below
  // set the value to "", which the draft store treats as a delete.
  useChatInputDraft(chatId);
  const isStreamingById = useAtomValue(isStreamingByIdAtom);
  const isStreaming = isStreamingById.get(chatId) ?? false;
  const setIsStreamingById = useSetAtom(isStreamingByIdAtom);
  // Instant Stop: flip the UI out of the streaming state synchronously on
  // click and suppress further chunks (IpcClient.cancelChatStream) so the
  // composer swaps Stop→Send immediately — no waiting on the backend teardown
  // (the source of the mac beachball). response:end reconciles the rest.
  const stopStreamNow = () => {
    setIsStreamingById((prev) => {
      if (!prev.get(chatId)) return prev;
      const next = new Map(prev);
      next.set(chatId, false);
      return next;
    });
    IpcClient.getInstance().cancelChatStream(chatId);
  };
  /**
   * Mid-turn messages. Typing while a turn runs no longer parks ONE message
   * until the turn ends — each message is handed to main, which delivers it
   * into the RUNNING turn on its next step (and, if the turn ends first,
   * opens the next turn with it).
   *
   * MAIN OWNS THE LIST. This atom is a mirror repainted from
   * `chat:interjections`, so a second window, a reload, or a chat switch all
   * see the same queue. The old renderer-only single slot silently rejected a
   * second message (Enter bypasses the disabled Send button, so the user got
   * no feedback at all) and could be dropped outright by a chat switch.
   */
  const [pendingByChatId, setPendingByChatId] = useAtom(
    pendingInterjectionsByChatIdAtom,
  );
  const pendingInterjections = pendingByChatId.get(chatId) ?? [];
  const applyPending = (pending: { id: string; text: string; ts: number }[]) =>
    setPendingByChatId((prev) => {
      const n = new Map(prev);
      if (pending.length) n.set(chatId, pending);
      else n.delete(chatId);
      return n;
    });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { menu: autocompleteMenu, onKeyDown: autocompleteKeyDown } =
    useComposerAutocomplete({
      value: inputValue,
      setValue: setInputValue,
      textareaRef: inputRef,
      mentionChips: true,
    });
  const { isAuthenticated, loading: authLoading, authResolved } = useAuth();
  // `authLoading` only covers this hook's own round-trip, which returns null
  // while main is still restoring the session — so the composer briefly told a
  // signed-in user to sign in. Wait for main's answer too.
  const mustSignIn = !authLoading && authResolved && !isAuthenticated;
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
  } = useAttachments();

  const attachDisabled = isStreaming || mustSignIn;
  // No queue-full case any more: the list takes as many as you type, so the
  // only reason to disable Send is having nothing to send.
  const sendDisabled =
    isSubmitting ||
    mustSignIn ||
    (!inputValue.trim() && attachments.length === 0);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 160)}px`;
    }
  }, [inputValue]);

  /**
   * Keep the mirror honest.
   *
   * FETCH on chat change, because main is the owner: the queue outlives a
   * reload and a chat switch, and without this the chip would show nothing
   * for messages that are genuinely still pending. SUBSCRIBE because main
   * clears entries we did not ask it to — a delivered message leaves the
   * queue from `prepareStep`, not from a click here.
   */
  useEffect(() => {
    let alive = true;
    const client = IpcClient.getInstance();
    void client
      .listUserInterjections(chatId)
      .then((pending) => {
        if (alive) applyPending(pending);
      })
      .catch(() => {});
    const off = client.onUserInterjections(({ chatId: cid, pending }) => {
      // Every window hears every chat's queue; only ours is ours.
      if (cid !== chatId) return;
      applyPending(pending);
    });
    return () => {
      alive = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if ((!inputValue.trim() && attachments.length === 0) || isSubmitting)
      return;

    // Streaming: hand the text to main for mid-turn delivery. Attachments
    // stay disabled mid-stream (`attachDisabled`), so this is text-only —
    // worth noting because the queue is a bare-text list and would drop
    // them silently if they were ever allowed through here.
    if (isStreaming) {
      if (!inputValue.trim()) return;
      const text = inputValue;
      // Renderer-minted id, so the chip can offer cancel before main has
      // answered — and `recordUserInterjection` is idempotent on it, so a
      // retry cannot deliver the same words twice.
      const id = `ij-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setInputValue("");
      inputRef.current?.focus();
      void IpcClient.getInstance()
        .interjectUserMessage(chatId, id, text)
        .then(({ pending }) => applyPending(pending))
        .catch(() => {
          // Put the text back rather than losing it — the user typed it.
          setInputValue((cur) => (cur ? cur : text));
        });
      return;
    }

    if (mustSignIn) {
      import("@/lib/toast").then(({ showError }) => {
        showError("Please sign in to use chat.");
      });
      return;
    }

    setIsSubmitting(true);

    const hasModel =
      settings?.selectedModel ||
      ((
        settings?.providerSettings?.ollama as { models?: unknown[] } | undefined
      )?.models?.length ?? 0) > 0 ||
      ((
        settings?.providerSettings?.lmstudio as
          | { models?: unknown[] }
          | undefined
      )?.models?.length ?? 0) > 0;

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
    if (e.key === "Enter" && !e.shiftKey) {
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
      ? "Type a message — Enter sends it to the running turn…"
      : placeholder;

  return (
    <div
      className={cn(
        "p-4 border-t border-border transition-colors",
        isDraggingOver && "bg-purple-500/10",
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

      {/* A3: calm "parked — will resume automatically" chip (turn ended,
                background work outstanding). Self-hides when not parked. */}
      <ParkedWaitingChip chatId={chatId} />

      {/* Approvals are ACTIONABLE, so they belong where you are looking. The
                cards stay inline in the transcript as the record, but on a long
                turn they scroll away and a pending approval went unnoticed until
                you scrolled all the way back. Self-hides when nothing is pending. */}
      <PendingApprovalsBar chatId={chatId} />

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

        <form onSubmit={handleSubmit} className="flex items-center">
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
              minHeight: "44px",
              height: "auto",
            }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = "auto";
              target.style.height = `${Math.min(target.scrollHeight, 160)}px`;
            }}
          />

          <Popover
            open={attachmentMenuOpen}
            onOpenChange={setAttachmentMenuOpen}
          >
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

          <VoiceInputButton
            disabled={mustSignIn}
            onInsertText={handleTranscript}
            chatId={chatId}
          />

          {/* v13.2: ONE action slot — Stop replaces Send while
                        streaming (and vice versa). Enter mid-stream sends the
                        typed text INTO the running turn (handleSubmit); the chip
                        below shows what has not been picked up yet. */}
          {isStreaming ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="mx-1 hover:bg-destructive/10 hover:text-destructive"
              onClick={stopStreamNow}
              title="Stop generation (Enter sends your message to the running turn)"
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

        {pendingInterjections.length > 0 ? (
          <div className="mx-3 mb-1 space-y-1">
            {/* The label is the honest one now: these go to the turn
                            that is already RUNNING, on its next step — not "when
                            the turn ends". The count matters because several can
                            be pending, which the old single slot could not say. */}
            <div className="px-2 text-[11px] font-medium text-muted-foreground">
              {pendingInterjections.length === 1
                ? "Sending to the running turn:"
                : `Sending ${pendingInterjections.length} messages to the running turn:`}
            </div>
            {pendingInterjections.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground"
              >
                <span className="truncate flex-1">{m.text}</span>
                <button
                  type="button"
                  className="shrink-0 hover:text-foreground"
                  title="Cancel this message"
                  onClick={() => {
                    void IpcClient.getInstance()
                      .cancelUserInterjection(chatId, m.id)
                      // `ok:false` means it was ALREADY
                      // delivered — not a failure, just too
                      // late. Either way the returned queue
                      // is what we repaint from.
                      .then(({ pending }) => applyPending(pending))
                      .catch(() => {});
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div className="px-2 pb-2 flex items-center justify-between gap-2">
          <ChatInputControls chatId={chatId} />
          <Popover
            open={tokenUsagePopoverOpen}
            onOpenChange={setTokenUsagePopoverOpen}
          >
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
                  {tokenUsagePopoverOpen
                    ? "Close token usage"
                    : "Show token usage"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <PopoverContent
              align="end"
              side="top"
              className="w-auto max-w-[min(100vw,22rem)] p-0"
              sideOffset={8}
            >
              <TokenBar chatId={chatId} />
            </PopoverContent>
          </Popover>
        </div>
      </div>
      {/*
              Below the bordered box, which was the one genuinely empty slot in this
              component — nothing has ever rendered between the box and this wrapper.
              Not inside `ChatInputControls`, which already stacks a status row and a
              chip row and would start competing for the same line.

              Safe to grow: `app/layout.tsx` gives the column `min-h-0` precisely so the
              transcript yields as the composer gets taller.
            */}
      <ComposerTip
        chatId={chatId}
        composerIsEmpty={inputValue.trim().length === 0}
        isStreaming={isStreaming}
        mustSignIn={mustSignIn}
      />
    </div>
  );
}
