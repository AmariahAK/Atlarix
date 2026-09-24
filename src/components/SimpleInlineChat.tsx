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
  messagesForChatAtom,
  chatStreamCountByIdAtom,
  isStreamingForChatAtom,
  pendingUserQuestionByChatIdAtom,
  chatErrorByIdAtom,
  turnSnapshotTurnIdByMessageIdAtom,
  streamThreadForChatAtom,
} from "../atoms/chatAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { isCompactionSummaryMessage } from "@/lib/chat/compaction-marker";
import { buildRevertSnapshotMap } from "@/lib/chat/revert-snapshot-rehydrate";
import { SimpleMessage } from "./SimpleMessage";
import { VirtualizedMessageList } from "./VirtualizedMessageList";
import { SimpleChatInput } from "./SimpleChatInput";
import { InlineUserQuestions } from "@/components/chat/InlineUserQuestions";
import { BackgroundJobsIndicator } from "@/components/chat/BackgroundJobsIndicator";
import { ArrowDown } from "lucide-react";
import { useStreamChat } from "@/hooks/useStreamChat";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import type { FileAttachment, Message } from "@/ipc/ipc_types";
import { ChatErrorBox } from "@/components/chat/ChatErrorBox";
import { Button } from "@/components/ui/button";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { chatIdToSessionIdAtom } from "@/atoms/sessionAtoms";
import { LoadedSessionBanner } from "@/components/chat/LoadedSessionBanner";
import { CoreSlotChangeBanner } from "@/components/chat/CoreSlotChangeBanner";
import { InlineStreamStatus } from "@/components/chat/InlineStreamStatus";
import { discardedTurnSnapshotIds } from "@/lib/chat/discarded-turn-snapshots";
import {
  CORE_EXHAUSTED_MARKER,
  FREE_LIMIT_MARKER,
} from "@/shared/billing_copy";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/hooks/useSettings";
import { useAccountKind } from "@/hooks/useAccountKind";
import { COMPASS_PROVIDER_ID, isCoreAutoTier } from "@/ipc/shared/compass_constants";
import { showError } from "@/lib/toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface SimpleInlineChatProps {
  chatId: number;
  onSendMessage: (prompt: string, attachments?: FileAttachment[]) => void;
  /** Override the virtualized-history kill-switch (defaults to USE_VIRTUALIZED_CHAT). */
  virtualizeHistory?: boolean;
}

/** Max messages mounted at once; older ones load on demand ("Show earlier"). */
const RENDER_CAP = 120;

/**
 * Kill-switch for the virtualized chat history (completed messages via
 * react-virtuoso, streaming tail live outside). Flip to `false` to fall back to
 * the render-all path with zero behavior change if a scroll/stick-to-bottom
 * regression surfaces. Default ON.
 */
const USE_VIRTUALIZED_CHAT = true;

export function SimpleInlineChat({
  chatId,
  onSendMessage,
  virtualizeHistory = USE_VIRTUALIZED_CHAT,
}: SimpleInlineChatProps) {
  // Scoped to THIS chat (perf: a stream in another chat no longer re-renders
  // this whole chat view every ~50ms). Writes still go through the whole-map
  // atom below.
  const messagesForChat = useAtomValue(messagesForChatAtom(chatId));
  const setMessagesById = useSetAtom(chatMessagesByIdAtom);
  const isStreamingThisChat = useAtomValue(isStreamingForChatAtom(chatId));
  const streamCountById = useAtomValue(chatStreamCountByIdAtom);
  const errorById = useAtomValue(chatErrorByIdAtom);
  const setErrorById = useSetAtom(chatErrorByIdAtom);
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const setPendingUserQuestionByChatId = useSetAtom(
    pendingUserQuestionByChatIdAtom,
  );
  const snapshotByMessageId = useAtomValue(turnSnapshotTurnIdByMessageIdAtom);
  const setSnapshotByMessageId = useSetAtom(turnSnapshotTurnIdByMessageIdAtom);
  const { streamMessage } = useStreamChat({ hasChatId: false });
  const { t } = useTranslation("chat");
  const { settings } = useSettings();
  const account = useAccountKind();
  const onPaidAuto =
    settings?.selectedModel?.provider === COMPASS_PROVIDER_ID &&
    isCoreAutoTier(settings.selectedModel.name) &&
    (account === "pro" || account === "payg");
  const [chatAppId, setChatAppId] = useState<number | null>(() =>
    selectedAppId != null ? selectedAppId : null,
  );
  // Edit-and-resend: when editing discards turns that changed files, confirm
  // whether to also revert those files before re-running.
  const [pendingEdit, setPendingEdit] = useState<{
    messageId: number;
    newContent: string;
    turnIds: string[];
    changed: number;
    created: number;
  } | null>(null);
  const [editReverting, setEditReverting] = useState(false);

  // Render-cap: only mount the last N messages so a long session doesn't grow
  // the DOM unbounded (the last/streaming message is always in the window, so
  // streaming + scroll-to-bottom are unaffected). "Show earlier" reveals more.
  const [renderLimit, setRenderLimit] = useState(RENDER_CAP);

  useEffect(() => {
    if (selectedAppId != null) {
      setChatAppId((prev) => prev ?? selectedAppId);
    }
  }, [selectedAppId, chatId]);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const messagesContentRef = useRef<HTMLDivElement | null>(null);

  const { isAtBottomRef, scrollToBottom, onContentChange, showJumpButton } =
    useStickToBottom(messagesContainerRef, messagesEndRef, messagesContentRef);

  const streamCount = streamCountById.get(chatId) ?? 0;
  // Live tool-card thread for this chat. Tool cards grow independently of
  // `messages` (text deltas), so the scroll-follow effect must also react to
  // them — otherwise a burst of tool cards mid-stream doesn't keep the
  // viewport pinned (and follow felt inconsistent). (Fix 5.)
  const liveThreadLen = useAtomValue(streamThreadForChatAtom(chatId)).length;

  // Switching chats: jump straight to the latest and re-pin to the bottom, and
  // reset the render-cap so each chat opens showing only its latest window.
  useEffect(() => {
    if (chatId) {
      isAtBottomRef.current = true;
      setRenderLimit(RENDER_CAP);
      scrollToBottom("auto");
    }
  }, [chatId, scrollToBottom, isAtBottomRef]);

  const fetchMessages = useCallback(async () => {
    // Bug 6: rehydrate the revert-turn affordance on ANY load path (relaunch /
    // openWorkspaceFolder), not just manual session-list selection. The
    // persisted per-assistant snapshot_turn_id (migration 0063) is fetched and
    // mapped into turnSnapshotTurnIdByMessageId so editing an earlier message
    // offers the "revert file changes as well" dialog after a restart.
    const rehydrateSnapshots = async (uiMsgs: Message[]) => {
      try {
        const ids = await IpcClient.getInstance().getSnapshotTurnIds(chatId);
        if (ids.length === 0) return;
        const restored = buildRevertSnapshotMap(
          ids.map((r) => ({
            id: r.rowId,
            role: "assistant",
            snapshotTurnId: r.snapshotTurnId,
          })),
          uiMsgs,
        );
        if (restored.size > 0) {
          setSnapshotByMessageId((prev) => {
            const next = new Map(prev);
            for (const [id, sid] of restored) next.set(id, sid);
            return next;
          });
        }
      } catch {
        // Non-fatal — the revert affordance just stays hidden for this load.
      }
    };

    const existing = getDefaultStore().get(chatMessagesByIdAtom).get(chatId);
    if (existing && existing.length > 0) {
      const { replaceDisplayHydrationForChat } = await import(
        "@/lib/chat/apply-stream-display-hydration"
      );
      replaceDisplayHydrationForChat(chatId, existing);
      void rehydrateSnapshots(existing);
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
      void rehydrateSnapshots(chat.messages);
    } catch (error) {
      console.error("Failed to fetch messages:", error);
    }
  }, [chatId, setMessagesById, setSnapshotByMessageId]);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  const messages = messagesForChat;
  // Render the FULL conversation (parity with Claude Code / opencode) — no
  // last-N-exchanges cutoff. System messages are excluded from the view; the
  // memoized SimpleMessage rows keep this cheap even for long sessions.
  // The compaction marker is excluded here and NOWHERE EARLIER. It stays in
  // `chatMessagesByIdAtom`, because `hydrateSessionIntoChat` builds the
  // transport's row refs from that same list — filtering it at `sessions:get`
  // or in `sessionMessagesToUiMessages` would drop it from the MODEL's history
  // too and silently disable the whole compaction slice. This is the view, and
  // only the view: a `[COMPACTION MARKER] gen=N … [END COMPACTION]` blob is
  // harness bookkeeping, not something the user typed or the model said.
  const visibleMessages = messages.filter(
    (m) =>
      m &&
      (m.role === "user" || m.role === "assistant") &&
      !isCompactionSummaryMessage(m),
  );
  // Anchor the settled "A" to the LAST assistant message, not the last array
  // element — a trailing synthetic/user message (compaction continuation,
  // self-correction) would otherwise flip it off and the indicator vanishes.
  const lastAssistantIndex = visibleMessages
    .map((m) => m.role)
    .lastIndexOf("assistant");
  // Render only the last `renderLimit` messages (the tail always includes the
  // streaming message). `renderOffset` maps a rendered index back to the full
  // array so the per-row index checks (streaming-last, latest-assistant) stay
  // correct.
  const renderOffset = Math.max(0, visibleMessages.length - renderLimit);
  const renderedMessages =
    renderOffset > 0 ? visibleMessages.slice(renderOffset) : visibleMessages;
  const isStreaming = isStreamingThisChat;
  const error = errorById.get(chatId) ?? null;
  const lastMessage =
    visibleMessages.length > 0
      ? visibleMessages[visibleMessages.length - 1]
      : null;

  // Render-all: full history in document order. Smoothness comes from
  // React.memo(SimpleMessage) + memoized markdown segments (completed rows /
  // segments skip re-render during streaming), not list virtualization —
  // which added measurement churn and broke overflow-anchor. Re-add a
  // streaming-safe virtualizer only if a 1000s-of-message session ever lags.

  // Follow streaming output (and any content growth) only when the user is
  // already pinned to the bottom; otherwise leave their scroll position alone.
  useEffect(() => {
    onContentChange();
  }, [messages, streamCount, liveThreadLen, onContentChange]);
  const performEdit = useCallback(
    async (
      messageId: number,
      newContent: string,
      discardedTurnIds?: string[],
    ) => {
      // Mid-stream edit: an edit truncates the turn being streamed below,
      // so stop the in-flight turn first (instant, stops spending tokens
      // and drops its chunks) before editing + resending the edited msg.
      IpcClient.getInstance().cancelChatStream(chatId);
      // Was this the FIRST user message? The session title is derived from
      // the first exchange, so editing it makes the title stale — every
      // other chat app re-titles here. Checked BEFORE the edit, while the
      // pre-edit ordering is still intact. A hand-typed title is still
      // protected downstream (titleSource === "user").
      const isFirstUserMessage =
        messagesForChat.find((m) => m.role === "user")?.id === messageId;
      await IpcClient.getInstance().editMessage(chatId, messageId, newContent);
      if (isFirstUserMessage) {
        const sessionId = getDefaultStore()
          .get(chatIdToSessionIdAtom)
          .get(chatId);
        if (sessionId) {
          const { regenerateSessionTitle } = await import(
            "@/lib/workspace-session-title"
          );
          void regenerateSessionTitle(sessionId);
        }
      }
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
      // Prune snapshot-map entries for the now-discarded turns so they
      // can't be revived by a later edit.
      if (discardedTurnIds && discardedTurnIds.length > 0) {
        const discarded = new Set(discardedTurnIds);
        setSnapshotByMessageId((prev) => {
          let mutated = false;
          const next = new Map(prev);
          for (const [mid, tid] of prev) {
            if (discarded.has(tid)) {
              next.delete(mid);
              mutated = true;
            }
          }
          return mutated ? next : prev;
        });
      }
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
    // `messagesForChat` is read to identify the first user message; without
    // it here the closure would test against a stale message list.
    [
      chatId,
      messagesForChat,
      setMessagesById,
      setSnapshotByMessageId,
      streamMessage,
    ],
  );

  const handleEditUserMessage = useCallback(
    async (messageId: number, newContent: string) => {
      // Identify the turns this edit would discard that captured file
      // snapshots — if any, confirm whether to also revert those files.
      const msgs = messagesForChat;
      const turnIds = discardedTurnSnapshotIds(
        msgs,
        messageId,
        snapshotByMessageId,
      );
      if (turnIds.length === 0) {
        await performEdit(messageId, newContent);
        return;
      }
      let changed = 0;
      let created = 0;
      let lookupFailed = false;
      try {
        const files = await IpcClient.getInstance().getSnapshotFilesRange(
          chatId,
          turnIds,
        );
        changed = files?.filesChanged.length ?? 0;
        created = files?.createdFiles.length ?? 0;
      } catch {
        // Counts unknown — fall through to the dialog (below) rather than
        // silently discarding the file-revert choice.
        lookupFailed = true;
      }
      if (!lookupFailed && changed === 0 && created === 0) {
        // Snapshots existed but recorded no file changes — nothing to
        // revert; just edit + resend.
        await performEdit(messageId, newContent, turnIds);
        return;
      }
      setPendingEdit({ messageId, newContent, turnIds, changed, created });
    },
    [chatId, messagesForChat, snapshotByMessageId, performEdit],
  );

  const resolveEditRevert = useCallback(
    async (revertFiles: boolean) => {
      const pe = pendingEdit;
      if (!pe) return;
      setEditReverting(true);
      try {
        if (revertFiles) {
          const res = await IpcClient.getInstance().revertSnapshotRange(
            chatId,
            pe.turnIds,
          );
          if (!res.success) {
            showError(res.error ?? "Reverting file changes failed");
          }
        }
        await performEdit(pe.messageId, pe.newContent, pe.turnIds);
      } catch (e) {
        showError(e);
      } finally {
        setEditReverting(false);
        setPendingEdit(null);
      }
    },
    [chatId, pendingEdit, performEdit],
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
      // Resume as an out-of-band system directive — NOT a user "continue"
      // message. The main-side handler injects the continuation as a
      // <system-reminder> so the transcript shows no fake user turn.
      streamMessage({
        prompt: "",
        continueInterrupted: true,
        chatId,
      });
    },
    [chatId, isStreaming, setMessagesById, streamMessage],
  );

  return (
    <div className="flex flex-col h-full min-h-0 w-full max-w-4xl mx-auto overflow-hidden relative">
      <LoadedSessionBanner />
      <CoreSlotChangeBanner />

      {virtualizeHistory && (visibleMessages.length > 0 || isStreaming) ? (
        <VirtualizedMessageList
          messages={visibleMessages}
          chatId={chatId}
          workspaceAppId={chatAppId}
          isStreaming={isStreaming}
          lastAssistantIndex={lastAssistantIndex}
          onEditUserMessage={handleEditUserMessage}
          onContinue={handleContinue}
        />
      ) : (
        <div className="relative flex-1 min-h-0 flex flex-col">
          <div
            ref={messagesContainerRef}
            className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
          >
            {/* Inner content wrapper: observed by useStickToBottom's
                    ResizeObserver so the bottom re-pins in the same frame when
                    content grows. The container itself never changes height, so
                    it can't be the resize target. */}
            <div ref={messagesContentRef} className="px-4 py-4 space-y-4">
              {visibleMessages.length === 0 && !isStreaming ? (
                <div className="flex flex-col items-center justify-center min-h-[8rem] text-center text-muted-foreground text-sm px-4 gap-2">
                  <span>What are we building?</span>
                  <span className="text-xs max-w-sm">
                    Workspace conversations save as sessions in the sidebar —
                    resume anytime.
                  </span>
                </div>
              ) : (
                <>
                  {renderOffset > 0 && (
                    <div className="flex justify-center pb-1">
                      <button
                        type="button"
                        onClick={() => setRenderLimit((n) => n + RENDER_CAP)}
                        className="px-3 py-1 text-xs font-medium text-muted-foreground bg-muted/40 hover:bg-muted/70 border border-border/60 rounded-full transition-colors"
                      >
                        Show earlier messages ({renderOffset} hidden)
                      </button>
                    </div>
                  )}
                  {renderedMessages.map((message, index) => {
                    const realIndex = renderOffset + index;
                    return (
                      <div
                        key={message.id ?? `idx-${realIndex}`}
                        className="contents"
                      >
                        <SimpleMessage
                          message={message}
                          chatId={chatId}
                          workspaceAppId={chatAppId}
                          isStreaming={
                            isStreaming &&
                            realIndex === visibleMessages.length - 1
                          }
                          isLatestAssistant={realIndex === lastAssistantIndex}
                          onEditUserMessage={handleEditUserMessage}
                          onContinue={handleContinue}
                        />
                      </div>
                    );
                  })}
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
      )}

      <div className="flex-shrink-0 px-4 pb-2 space-y-2">
        {/* Stream failure: pinned just above the input (never scrolled away),
                    aligned with the slow-stream warning — not at the top of the page. */}
        {error && (
          <div data-testid="chat-error-bottom">
            <ChatErrorBox
              error={error}
              onDismiss={() => {
                setErrorById((prev) => {
                  const next = new Map(prev);
                  next.delete(chatId);
                  return next;
                });
              }}
            />
            {/*
                          RETRY IS HIDDEN WHEN RETRYING CANNOT WORK.

                          This row used to render under EVERY error. On an empty wallet
                          that was two defects at once: the credit card above already
                          offers "Top up credit" and "Choose another model", so the hint
                          duplicated its own second button — and Retry re-sends the same
                          request against the same empty balance, so it is guaranteed to
                          fail identically. A button that cannot succeed invites a loop.

                          The condition is "retrying cannot help", NOT "the box has its
                          own actions" — deliberately narrower. A Core REACHABILITY error
                          also carries a button, and there Retry is exactly right, because
                          the failure is transient. Only an exhausted balance is a state
                          that a repeat request cannot change.
                        */}
            {!error.includes(CORE_EXHAUSTED_MARKER) &&
              !error.includes(FREE_LIMIT_MARKER) && (
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
                    streamMessage({
                      prompt: "",
                      chatId,
                      continueAfterQuestions: true,
                    });
                  }}
                >
                  Retry
                </Button>
                {/* Paid Auto only: the same turn, one level up. Never
                    automatic — a failure retries on the same model first. */}
                {onPaidAuto && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="try-stronger-model"
                    title={t("atlarixAuto.strongerModelTitle")}
                    onClick={() => {
                      setErrorById((prev) => {
                        const next = new Map(prev);
                        next.delete(chatId);
                        return next;
                      });
                      streamMessage({
                        prompt: "",
                        chatId,
                        continueAfterQuestions: true,
                        escalate: true,
                      });
                    }}
                  >
                    {t("atlarixAuto.strongerModel")}
                  </Button>
                )}
                <div className="text-xs text-muted-foreground flex items-center">
                  If this keeps happening, switch models using the selector
                  below.
                </div>
              </div>
            )}
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

      <AlertDialog
        open={pendingEdit != null}
        onOpenChange={(o) => {
          if (!o && !editReverting) setPendingEdit(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-run from this message?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-xs">
                <p>
                  Editing re-runs from here and discards the{" "}
                  {pendingEdit?.turnIds.length ?? 0} later turn(s). Those turns
                  changed {pendingEdit?.changed ?? 0} file(s)
                  {pendingEdit && pendingEdit.created > 0
                    ? ` and created ${pendingEdit.created}`
                    : ""}
                  . Revert those file changes too, or keep them on disk?
                </p>
                <p className="text-muted-foreground">
                  Reverting restores the files to their state before those turns
                  (created files are deleted). Keeping them re-runs on top of
                  the current files.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={editReverting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void resolveEditRevert(false);
              }}
              disabled={editReverting}
            >
              Keep files &amp; re-run
            </AlertDialogAction>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void resolveEditRevert(true);
              }}
              disabled={editReverting}
            >
              Revert files &amp; re-run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
