import { useCallback, useEffect, useRef } from "react";
import type { Message, FileAttachment } from "@/ipc/ipc_types";
import { useAtom, useAtomValue, useSetAtom, getDefaultStore } from "jotai";
import {
  normalizeChatActivityPayload,
  upsertActivityStreamItem,
} from "@/lib/chat-activity-normalize";
import { resolveEffectiveWorkMode } from "@/lib/work-mode";
import { findToolActivityResult } from "@/lib/chat/find-tool-activity-result";
import {
  chatErrorByIdAtom,
  chatMessagesByIdAtom,
  chatStreamCountByIdAtom,
  isStreamingByIdAtom,
  turnWorkModeByChatIdAtom,
  recentStreamChatIdsAtom,
  lastTurnHadToolCallsByChatIdAtom,
  lastReasoningTokensByChatIdAtom,
  lastAuxTokensByChatIdAtom,
  liveTurnUsageByChatIdAtom,
  lastAuxBySourceByChatIdAtom,
  lastTurnCostUsdByChatIdAtom,
  sessionCostUsdByChatIdAtom,
  sessionTokensByChatIdAtom,
  toolIndicatorAtom,
  streamLastActivityAtByChatIdAtom,
  reconnectingByChatIdAtom,
  liveToolInputByChatIdAtom,
  waitingOnCommandByChatIdAtom,
  parkedWaitingByChatIdAtom,
  pendingInterjectionsByChatIdAtom,
  turnSnapshotTurnIdByMessageIdAtom,
  turnModelByAssistantMessageIdAtom,
  responseDoneAnimationAtom,
  restartedAfterMessageIdAtom,
  pendingUserQuestionByChatIdAtom,
  livePlanUpdateByAssistantMessageIdAtom,
  planSnapshotByAssistantMessageIdAtom,
  completedTurnThinkingByAssistantMessageIdAtom,
  emptyToolIndicatorState,
  summarizationProgressAtom,
  activeTurnScopeAtom,
  inlineTimelineByMessageIdAtom,
  interleavedDisplayContentByMessageIdAtom,
  streamThreadByChatIdAtom,
  completedStreamThreadByAssistantMessageIdAtom,
  sourcesByAssistantMessageIdAtom,
} from "@/atoms/chatAtoms";
import {
  extractThoughtContentFromAssistantRaw,
  pickBestThoughtContent,
} from "@/lib/chat/frozen-turn-display";
import {
  streamThreadItemFromActivity,
  handleStreamToolEnd,
  freezeStreamThreadForAssistantMessage,
  mergePendingSubagentActivitiesIntoThread,
  streamThreadItemFromToolStart,
  upsertStreamThreadItem,
  mergeSubagentActivityIntoThread,
  mergeNestedToolActivityIntoSubagentRound,
  DISPLAY_PREVIEW_ARG,
  withDisplayPreviewExpand,
  type StreamThreadItem,
} from "@/lib/chat/stream-thread";
import { buildInlineTimelineFromActivity } from "@/lib/chat/inline-timeline";
import { extractPartialToolArgs } from "@/lib/chat/partial-tool-args";
import { markStoppedReply } from "@/lib/chat/stopped-reply";
import { buildDisplaySnapshotPayloadForMessage } from "@/lib/chat/apply-stream-display-hydration";
import { parseDisplaySnapshot } from "@/lib/chat/display-snapshot";
import {
  extractThinkingFromContent,
  hasThinkingSnapshotContent,
} from "@/lib/thinking/extract-thinking-from-content";
import {
  sourceListAtom,
  rightPanelVisibleAtom,
  rightPanelSuppressAutoOpenAtom,
  pendingProposalsAtom,
  previewTabAtom,
  workspacePlanPanelAtom,
  aiPanelIntentAtom,
  terminalOutputsAtom,
  activityStreamItemsAtom,
  backgroundJobsByChatIdAtom,
  subagentJobsByChatIdAtom,
  type SourceItem,
  type FileProposal,
  type TerminalOutput,
} from "@/atoms/sourceAtoms";
import {
  permissionQueueAtom,
  updateOperationStatus,
  type QueuedOperation,
} from "@/atoms/permissionQueueAtom";
import { IpcClient } from "@/ipc/ipc_client";
import { compassUsageBumpAtom } from "@/atoms/viewAtoms";
import type { ChatResponseEnd } from "@/ipc/ipc_types";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateAppQuery } from "./useLoadApp";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { resolveStreamAppId } from "@/lib/chat-workspace-binding";
import { ensureWorkspaceSessionForChat } from "@/lib/ensure-workspace-session";
import { collectPasteAttachmentsFromFileAttachments } from "@/lib/chat/paste-attachment-meta";
import { buildPromptWithTextPastes } from "@/lib/chat/text-paste-attachment";
import { withRevertedFilesNote } from "@/lib/chat/reverted-files-reminder";
import {
  activeSessionWorkModeAtom,
  activeWorkspaceSessionIdAtom,
  chatIdToSessionIdAtom,
  workspaceSessionsRefreshAtom,
} from "@/atoms/sessionAtoms";
import { useVersions } from "./useVersions";
import { useChats } from "./useChats";
import { showExtraFilesToast, showError } from "@/lib/toast";
import { useProposal } from "./useProposal";
import { useContextTokenCount } from "./useCountTokens";
import { useUserBudgetInfo } from "./useUserBudgetInfo";
import { usePostHog } from "posthog-js/react";
import * as Sentry from "@sentry/electron/renderer";
import { ATLARIX_AUTH_REQUIRED_PREFIX } from "@/shared/auth_ipc";
import { useSettings } from "./useSettings";
import { activeChatIdAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";
import {
  clearActivityForChatInStore,
  filterActivityForChat,
} from "@/lib/chat/activity-stream";
import { showInfo } from "@/lib/toast";
import { appendCapped, pushRing, stripAnsi } from "@/lib/chat/output-stream";

function isForegroundChatId(chatId: number): boolean {
  const store = getDefaultStore();
  const active = store.get(activeChatIdAtom);
  if (active === chatId) return true;
  return store.get(selectedChatIdAtom) === chatId;
}

function isSpammyProgressLine(line: string): boolean {
  const s = line.trim();
  if (!s) return true;
  if (/^\d+%$/.test(s)) return true;
  if (/^\[=+>\s*\]\s*\d+%/.test(s)) return true;
  if (/^(?:\u25A0|\u25A1|\u2591|\u2592|\u2593)+$/.test(s)) return true;
  return false;
}

function isErrorLikeLine(line: string): boolean {
  return /\b(error|failed|exception|traceback|fatal|warn(ing)?)\b/i.test(line);
}

import { playNotify, playRemaining } from "@/lib/sounds";

/** PASS6: cap renderer-held chat history to limit heap growth (SQLite still has full history). */
const MAX_RENDERER_MESSAGES = 100;

/**
 * Above this streamed-answer length (chars), the message-flush throttle drops to
 * every other 50ms tick (~100ms). Per-flush render cost scales with answer
 * length, so long answers get the cheaper cadence; short ones stay at 50ms.
 */
const ADAPTIVE_FLUSH_LEN_THRESHOLD = 20_000;

/**
 * Flush on every Nth 50 ms tick for a streamed answer this long. A long Build
 * turn holds every tool call and result in one message, so it reaches hundreds
 * of KB to MB; each flush re-parses all of it, and at 10–20 Hz that was the
 * renderer's CPU and garbage on exactly the turns that also ran out of memory.
 */
export function flushEveryNthTick(len: number): number {
  if (len > 1_000_000) return 10; // 500 ms
  if (len > 250_000) return 5; // 250 ms
  if (len > ADAPTIVE_FLUSH_LEN_THRESHOLD) return 2; // 100 ms
  return 1;
}

function trimRendererMessages(msgs: Message[]): Message[] {
  if (msgs.length <= MAX_RENDERER_MESSAGES) return msgs;
  return msgs.slice(-MAX_RENDERER_MESSAGES);
}

function resolveThoughtContentForPersist(
  _chatId: number,
  rawFromRef: string | undefined,
  assistantContent: string | undefined,
): string | null {
  const fromRaw = rawFromRef
    ? extractThoughtContentFromAssistantRaw(rawFromRef)
    : null;
  const fromMessage = assistantContent
    ? extractThoughtContentFromAssistantRaw(assistantContent)
    : null;
  return pickBestThoughtContent(undefined, fromRaw, fromMessage);
}

/** Reads the live activity list; the pairing rule itself lives in the pure module. */
function findLatestToolActivityResult(
  chatId: number,
  toolName: string,
  toolCallId?: string,
): { resultText?: string; detail?: string } {
  return findToolActivityResult(
    getDefaultStore().get(activityStreamItemsAtom),
    chatId,
    toolName,
    toolCallId,
  );
}

/**
 * Stash the diff content (old + new) onto the matching thread tool item's
 * toolArgs so the COMPLETED/persisted card renders an ACCURATE red/green diff —
 * including a full overwrite of an existing file — without echoing content into
 * the model transcript. The display snapshot (which persists toolArgs) is never
 * sent to the model, so this costs ZERO model tokens.
 *
 * Used by both the permission-preview path (manual approval) and the
 * write-preview channel (auto-approved writes, which skip the preview).
 */
export function mergeWritePreviewIntoThread(
  chatId: number,
  targetPath: string,
  operation: string,
  oldContent: string | null,
  content: string | null,
  /**
   * Hunks already computed in MAIN. Carried through so the card can render
   * without re-running a Myers diff on the UI thread — see permission-ui.ts.
   */
  diff?: { hunks: unknown[]; addedCount: number; removedCount: number },
): void {
  if (oldContent == null && content == null) return;
  getDefaultStore().set(streamThreadByChatIdAtom, (prevMap) => {
    const cur = prevMap.get(chatId);
    if (!cur) return prevMap;
    let idx = -1;
    for (let i = cur.length - 1; i >= 0; i--) {
      const it = cur[i];
      if (
        it.kind === "tool" &&
        (it.toolArgs as { path?: unknown } | undefined)?.path === targetPath
      ) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      for (let i = cur.length - 1; i >= 0; i--) {
        const it = cur[i];
        if (it.kind === "tool" && it.status === "running") {
          idx = i;
          break;
        }
      }
    }
    if (idx === -1) return prevMap;
    const item = cur[idx] as Extract<StreamThreadItem, { kind: "tool" }>;
    const mergedArgs: Record<string, unknown> = {
      ...item.toolArgs,
      [DISPLAY_PREVIEW_ARG]: true,
      path: targetPath,
      operation,
      ...(oldContent != null ? { old_content: oldContent } : {}),
      ...(content != null ? { content } : {}),
      ...(diff
        ? {
            precomputed_hunks: diff.hunks,
            added_count: diff.addedCount,
            removed_count: diff.removedCount,
          }
        : {}),
    };
    const next = [...cur];
    // A card that already finished rebuilds its diff from the whole file.
    next[idx] = withDisplayPreviewExpand({ ...item, toolArgs: mergedArgs });
    return new Map(prevMap).set(chatId, next);
  });
}

function persistAndClearLiveStreamThread(
  chatId: number,
  assistantMessageId: number | undefined,
  thoughtContent?: string | null,
  assistantContent?: string | null,
): void {
  const thought = thoughtContent?.trim() || null;
  const content = assistantContent?.trim() || null;
  const pendingActivities = getDefaultStore()
    .get(activityStreamItemsAtom)
    .filter((i) => i.chatId == null || i.chatId === chatId);

  getDefaultStore().set(streamThreadByChatIdAtom, (prev) => {
    const cur = mergePendingSubagentActivitiesIntoThread(
      prev.get(chatId) ?? [],
      pendingActivities,
      chatId,
    );
    if (assistantMessageId != null && (cur.length || thought || content)) {
      getDefaultStore().set(
        completedStreamThreadByAssistantMessageIdAtom,
        (frozen) => ({
          ...frozen,
          [assistantMessageId]: freezeStreamThreadForAssistantMessage(
            cur,
            thought,
            content,
          ),
        }),
      );
    }
    const n = new Map(prev);
    n.delete(chatId);
    return n;
  });
}

function captureThinkingSnapshotForChat(
  _chatId: number,
  messages: Message[],
): void {
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");
  if (!lastAssistant?.content) return;
  const snap = extractThinkingFromContent(lastAssistant.content);
  if (!hasThinkingSnapshotContent(snap)) return;
  getDefaultStore().set(
    completedTurnThinkingByAssistantMessageIdAtom,
    (prev) => ({
      ...prev,
      [lastAssistant.id]: snap,
    }),
  );
}

export function useStreamChat({
  hasChatId = true,
}: { hasChatId?: boolean } = {}) {
  const setMessagesById = useSetAtom(chatMessagesByIdAtom);
  const setToolIndicator = useSetAtom(toolIndicatorAtom);
  const setStreamLastActivityAtByChatId = useSetAtom(
    streamLastActivityAtByChatIdAtom,
  );
  const setReconnectingByChatId = useSetAtom(reconnectingByChatIdAtom);
  const setLiveToolInputByChatId = useSetAtom(liveToolInputByChatIdAtom);
  const setResponseDoneAnimation = useSetAtom(responseDoneAnimationAtom);
  const isStreamingById = useAtomValue(isStreamingByIdAtom);
  const setIsStreamingById = useSetAtom(isStreamingByIdAtom);
  const errorById = useAtomValue(chatErrorByIdAtom);
  const setErrorById = useSetAtom(chatErrorByIdAtom);
  const [selectedAppId] = useAtom(selectedAppIdAtom);
  const queryClient = useQueryClient();
  const { refreshChats } = useChats(selectedAppId);
  const refreshApp = useCallback(() => {
    if (selectedAppId != null) {
      void invalidateAppQuery(queryClient, { appId: selectedAppId });
    }
  }, [queryClient, selectedAppId]);

  const setStreamCountById = useSetAtom(chatStreamCountByIdAtom);
  const { refreshVersions } = useVersions(selectedAppId);
  const { refetchUserBudget } = useUserBudgetInfo();
  const { settings } = useSettings();
  const setRecentStreamChatIds = useSetAtom(recentStreamChatIdsAtom);
  const setSourceList = useSetAtom(sourceListAtom);
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const maybeAutoOpenRightPanel = () => {
    if (!getDefaultStore().get(rightPanelSuppressAutoOpenAtom)) {
      setRightPanelVisible(true);
    }
  };
  const setPendingProposals = useSetAtom(pendingProposalsAtom);
  const setPreviewTab = useSetAtom(previewTabAtom);
  const setTerminalOutputs = useSetAtom(terminalOutputsAtom);
  const setPermissionQueue = useSetAtom(permissionQueueAtom);
  const setLastTurnHadToolCallsByChatId = useSetAtom(
    lastTurnHadToolCallsByChatIdAtom,
  );
  const posthog = usePostHog();
  let chatId: number | undefined;

  if (hasChatId) {
    const activeChatId = useAtomValue(activeChatIdAtom);
    const selectedChatId = useAtomValue(selectedChatIdAtom);
    // The trailing `?? undefined` was dead: the inner chain already yields
    // `number | undefined`, so the outer operator could never change the result.
    // TypeScript 7 rejects it (TS2871); 5.x accepted it silently.
    chatId = activeChatId ?? selectedChatId ?? undefined;
  }
  let { refreshProposal } = hasChatId ? useProposal(chatId) : useProposal();
  // PASS8 E3: Shared context-only token count (dedup'd via React Query key).
  const { invalidateTokenCount } = useContextTokenCount(chatId ?? null);

  const setRestartedAfterMessageId = useSetAtom(restartedAfterMessageIdAtom);
  const setPendingUserQuestionByChatId = useSetAtom(
    pendingUserQuestionByChatIdAtom,
  );

  // PASS6: throttle setMessagesById during streaming (max ~20/s) to avoid renderer OOM.
  /** AI workspace session title runs once per chat after the first assistant turn is persisted. */

  const messageStreamThrottleRef = useRef<{
    timer: ReturnType<typeof setInterval> | null;
    pending: Map<number, Message[]>;
    lastAssistantRawByChatId: Map<number, string>;
    /** Monotonic tick counter for the adaptive-cadence flush skip. */
    tick: number;
    /** Last-flushed source count per chat — skips the per-chunk sources rebuild. */
    sourcesCountByChatId: Map<number, number>;
  }>({
    timer: null,
    pending: new Map(),
    lastAssistantRawByChatId: new Map(),
    tick: 0,
    sourcesCountByChatId: new Map(),
  });

  /** Pairs with IPC tool:start / tool:end (end often omits toolId). */
  const toolEndStackRef = useRef<
    Map<number, { toolId: string; toolName: string; toolCallId?: string }[]>
  >(new Map());

  useEffect(() => {
    return () => {
      const t = messageStreamThrottleRef.current.timer;
      if (t != null) clearInterval(t);
      messageStreamThrottleRef.current.timer = null;
      messageStreamThrottleRef.current.pending.clear();
    };
  }, []);

  /**
   * Main refused a dispatch outright — a system wake at a chat that is already
   * streaming, or one the user stopped.
   *
   * `setIsStreamingById(chatId, true)` happens BEFORE the invoke, so without this
   * the refusing window would sit at `isStreaming: true` for that chat forever:
   * a phantom spinner if it ever opened the chat, and a guard permanently stuck
   * in the "don't wake" position.
   *
   * Deliberately NOT routed through the `chat:response:end` handler — that one is
   * the auto-wake race-closer, so a synthesised end for a refused wake would fire
   * another wake immediately and rebuild the loop in IPC instead of streams.
   */
  useEffect(() => {
    const unsub = IpcClient.getInstance().onStreamDropped(
      ({ chatId: evChatId }) => {
        setIsStreamingById((prev) => {
          if (prev.get(evChatId) !== true) return prev;
          const next = new Map(prev);
          next.set(evChatId, false);
          return next;
        });
      },
    );
    return unsub;
  }, [setIsStreamingById]);

  // v13 7B: waiting-on-command phase events → waiting chip + send/stop flip.
  useEffect(() => {
    const unsub = IpcClient.getInstance().onStreamPhase(
      ({ chatId: evChatId, phase, commandId, command, startedAt }) => {
        if (phase === "waiting_on_command" && commandId) {
          getDefaultStore().set(waitingOnCommandByChatIdAtom, (prev) => {
            const n = new Map(prev);
            n.set(evChatId, {
              commandId,
              command,
              startedAt: startedAt ?? Date.now(),
            });
            return n;
          });
          return;
        }
        if (phase === "command_done" || phase === "done") {
          getDefaultStore().set(waitingOnCommandByChatIdAtom, (prev) => {
            if (!prev.has(evChatId)) return prev;
            const n = new Map(prev);
            n.delete(evChatId);
            return n;
          });
        }
      },
    );
    return unsub;
  }, []);

  // Late-bound handle so the stream-end queue flush (registered above the
  // definition) can call streamMessage without a dependency cycle.
  const streamMessageRef = useRef<
    | ((args: {
        prompt: string;
        chatId: number;
        continueAfterQuestions?: boolean;
        systemWake?: boolean;
      }) => Promise<unknown>)
    | null
  >(null);
  /** Chats with an in-flight background-completion wake (avoid double-starting). */
  const bgWakeInFlightRef = useRef<Set<number>>(new Set());
  /**
   * Chats the user has STOPPED, until they send something new.
   *
   * There are two wake sites (the `response:end` race-closer and the background
   * job/task status listener), and both start a fresh turn when work reports in while
   * the chat is idle. Right after a Stop that is the normal state — cancel kills only
   * foreground commands — so both would resurrect the turn the user had just stopped.
   * The revived turn knew nothing about the stop: it re-read the file it had edited,
   * mistook its own change for the user's, and kept going (observed: to `git push`).
   *
   * A latch rather than a time window: it is set by the `userCancelled` end and cleared
   * only when the user actually sends a message, so there is no interval to tune and no
   * race to lose. Results are not dropped — they stay pending and drain into that next
   * turn's context.
   */
  const userStoppedChatsRef = useRef<Set<number>>(new Set());

  // Bug A (renderer side): each streamMessage dispatch gets a unique id; only the
  // LATEST dispatch per chat may act on terminal callbacks. A superseded leg's
  // late onEnd/onError (it shares the chatId-keyed IPC callbacks) is dropped so
  // it can't clear isStreaming or flush the queued message for the live turn.
  const streamDispatchCounterRef = useRef(0);
  const latestDispatchByChatRef = useRef<Map<number, number>>(new Map());

  /**
   * Settle a sub-agent card that finished AFTER its turn ended.
   *
   * PERSISTENT (mount-level) on purpose. The stream's own `chat:activity`
   * listener is unsubscribed in its cleanup, so every `subagent_complete`
   * arriving after the turn had nowhere to land: the card froze into the display
   * snapshot with whatever state it held at stream end and span forever.
   *
   * OBSERVED 2026-09-03: a card stuck on "Sub-agents · 4/5 running" while all
   * five had in fact completed (11:20:42 → 11:25:16). The background-tasks pill
   * was correct throughout, because it reads main-process state rather than a
   * transient event — which is the tell that the card was listening, not
   * deriving.
   *
   * `onBackgroundSettled` in register-delegation-tools already emits this event
   * post-turn, deliberately ("this closure outlives the tool call"). The only
   * missing half was a receiver, and the ids line up exactly: both the start and
   * the completion carry the DELEGATION id, which is what the card is keyed on
   * (the task store's `taskId` is a separate randomUUID and is not usable here).
   *
   * Only completion/progress are handled. Anything else post-turn belongs to the
   * stream listener and would double-apply.
   */
  useEffect(() => {
    const unsub = IpcClient.getInstance().onChatActivity((payload: unknown) => {
      const item = normalizeChatActivityPayload(payload);
      if (!item) return;
      if (
        item.type !== "subagent_complete" &&
        item.type !== "subagent_progress"
      ) {
        return;
      }
      // A LIVE turn already routes these through its own listener; applying them
      // twice would fight over the same row.
      if (item.chatId != null) {
        const live = getDefaultStore()
          .get(isStreamingByIdAtom)
          .get(item.chatId);
        if (live === true) return;
      }
      getDefaultStore().set(
        completedStreamThreadByAssistantMessageIdAtom,
        (frozen) => {
          let changed = false;
          const next: Record<number, StreamThreadItem[]> = {};
          for (const [key, thread] of Object.entries(frozen)) {
            // Only the message that actually owns this sub-agent row is touched;
            // `mergeSubagentActivityIntoThread` is keyed on the delegation id, so
            // a thread without it comes back referentially identical.
            const merged = mergeSubagentActivityIntoThread(thread, item);
            next[Number(key)] = merged;
            if (merged !== thread) changed = true;
          }
          return changed ? next : frozen;
        },
      );
    });
    return unsub;
  }, []);

  // v14: background jobs — keep the indicator atom fresh and AUTO-WAKE the agent
  // when a job finishes while the chat is idle. Persistent (mount-level) so it
  // fires even after the turn that started the job has ended.
  useEffect(() => {
    const ipc = IpcClient.getInstance();
    const unsub = ipc.onBackgroundJobUpdate(
      ({ chatId: evChatId, status, source }) => {
        // Another Atlarix session messaged this chat while it was idle (lib/peers):
        // open a turn with what it queued. Take-once in main, so with several
        // windows open only one of them gets the text. A busy chat reads it at
        // its next step and needs nothing from here.
        if (status === "peer_message") {
          const busy =
            getDefaultStore().get(isStreamingByIdAtom).get(evChatId) === true;
          if (busy || bgWakeInFlightRef.current.has(evChatId)) return;
          bgWakeInFlightRef.current.add(evChatId);
          void ipc
            .flushUserInterjections(evChatId)
            .then(({ text }) =>
              text?.trim()
                ? streamMessageRef.current?.({ prompt: text, chatId: evChatId })
                : undefined,
            )
            .catch(() => {})
            .finally(() => bgWakeInFlightRef.current.delete(evChatId));
          return;
        }
        // Indicator refresh is source-specific: the background-jobs list is for
        // COMMANDS, and sub-agents have their own list (v14.21 — before that,
        // sub-agent events refreshed nothing, so a running sub-agent was
        // invisible and uncancellable from the UI).
        if (source === "subagent") {
          void ipc.subagentJobsList(evChatId).then((subs) => {
            getDefaultStore().set(subagentJobsByChatIdAtom, (prev) => ({
              ...prev,
              [evChatId]: subs.map((s) => ({
                taskId: s.taskId,
                description: s.description,
                elapsedMs: s.elapsedMs,
                lastOutput: s.lastOutput,
                stalled: s.stalled,
              })),
            }));
          });
        } else {
          void ipc.backgroundJobsList(evChatId).then((jobs) => {
            getDefaultStore().set(backgroundJobsByChatIdAtom, (prev) => ({
              ...prev,
              [evChatId]: jobs.map((j) => ({
                operationId: j.operationId,
                command: j.command,
                startedAt: j.startedAt,
                elapsedMs: j.elapsedMs,
                stalled: j.stalled,
                wakeMatched: j.wakeMatched,
              })),
            }));
          });
        }
        // Auto-wake on a finished (not cancelled) job/task, a "stalled" advisory
        // (A4: a quiet still-running job → "this looks stuck, decide"), or a
        // "scheduled" self-wake firing (R1). Only when idle and no wake is already
        // in flight; a live turn already drains via prepareStep. The wake path is
        // shared by all sources and guarded by the one bgWakeInFlightRef.
        if (
          status !== "finished" &&
          status !== "stalled" &&
          status !== "scheduled" &&
          status !== "condition_met"
        )
          return;
        // These three checks are a cheap LOCAL filter, not the decision.
        //
        // This listener keys on the chat id in the EVENT, not the chat this window
        // is showing, while all three guards read per-window state — a jotai store
        // and two hook refs. A second window therefore looked up a chat it had never
        // seen, found nothing, concluded "not streaming", and woke a chat the first
        // window was mid-turn on. Main now refuses that (`shouldDropSystemWake`);
        // `systemWake: true` below is what marks the request as refusable.
        const streaming =
          getDefaultStore().get(isStreamingByIdAtom).get(evChatId) === true;
        if (
          streaming ||
          bgWakeInFlightRef.current.has(evChatId) ||
          // The user stopped this chat — a job reporting in must not restart the agent.
          userStoppedChatsRef.current.has(evChatId)
        )
          return;
        bgWakeInFlightRef.current.add(evChatId);
        void Promise.resolve(
          streamMessageRef.current?.({
            prompt: "",
            chatId: evChatId,
            continueAfterQuestions: true,
            systemWake: true,
          }),
        ).finally(() => bgWakeInFlightRef.current.delete(evChatId));
      },
    );
    return unsub;
  }, []);

  const streamMessage = useCallback(
    async ({
      prompt,
      chatId,
      redo,
      attachments,
      modelOverride,
      onSettled,
      continueAfterQuestions,
      continueInterrupted,
      systemWake,
      prefillTaskLedger,
      workModeOverride,
      escalate,
    }: {
      prompt: string;
      chatId: number;
      redo?: boolean;
      attachments?: FileAttachment[];
      modelOverride?: { provider: string; name: string };
      onSettled?: () => void;
      /** v3.9: Continue after clarifying questions (no new user message). */
      continueAfterQuestions?: boolean;
      /** Resume an interrupted turn: no new user message; system-reminder directive to the model. */
      continueInterrupted?: boolean;
      /** The HARNESS started this turn, not the user — main may refuse it. */
      systemWake?: boolean;
      prefillTaskLedger?: {
        steps: { description: string }[];
        sourcePlanMessageId?: number;
      };
      /** Resend/edit: work mode for this stream turn only. */
      workModeOverride?: import("@/lib/schemas").WorkMode;
      /** "Try with a stronger model": paid Atlarix Auto answers one level up. */
      escalate?: boolean;
      /** Persisted workspace session id for this stream turn. */
      workspaceSessionId?: string | null;
    }) => {
      if (!chatId) return;
      const hasAttachments =
        attachments?.some(
          (a) =>
            a.file != null || a.textPaste?.content || a.terminalPaste?.content,
        ) ?? false;
      if (
        !continueAfterQuestions &&
        !continueInterrupted &&
        !prompt.trim() &&
        !hasAttachments
      ) {
        return;
      }

      // Bug A: claim the latest-dispatch slot for this chat. A prior in-flight
      // leg's terminal callbacks will see a newer id and no-op.
      const dispatchId = ++streamDispatchCounterRef.current;
      latestDispatchByChatRef.current.set(chatId, dispatchId);

      setRecentStreamChatIds((prev) => {
        const next = new Set(prev);
        next.add(chatId);
        return next;
      });

      setErrorById((prev) => {
        const next = new Map(prev);
        next.set(chatId, null);
        return next;
      });
      setIsStreamingById((prev) => {
        const next = new Map(prev);
        next.set(chatId, true);
        return next;
      });
      // Release the stop latch only for a turn the USER started. A wake dispatches with
      // an empty prompt, so keying on real content means a queued background result can
      // never clear its own suppression — the user has to ask for something first.
      if (prompt.trim().length > 0) {
        userStoppedChatsRef.current.delete(chatId);
      }
      // A3: a new turn is starting (a user message OR the auto-resume) — clear
      // the parked chip; the turn is live again.
      getDefaultStore().set(parkedWaitingByChatIdAtom, (prev) => {
        if (!prev.has(chatId)) return prev;
        const n = new Map(prev);
        n.delete(chatId);
        return n;
      });
      getDefaultStore().set(activeTurnScopeAtom, {
        chatId,
        assistantMessageId: -1,
        startedAt: Date.now(),
      });

      const th = messageStreamThrottleRef.current;
      if (th.timer != null) {
        clearInterval(th.timer);
        th.timer = null;
      }
      th.pending.clear();

      // Fix: Finding 4 — instant "Thinking…" before main round-trip
      setToolIndicator({
        ...emptyToolIndicatorState(),
        activeChatId: chatId,
        phaseLabel: "Thinking…",
      });
      setStreamLastActivityAtByChatId((prev) => {
        const n = new Map(prev);
        n.set(chatId, Date.now());
        return n;
      });

      let hasIncrementedStreamCount = false;
      // The user rows this turn started with; one that appears later, in front
      // of the reply, was sent while it ran (a steer) — see onUpdate (QA #4).
      let userIdsAtTurnStart: Set<number> | null = null;
      // The model this turn runs on, for its reply's header (QA #49).
      const turnModel =
        modelOverride ??
        (settings?.selectedModel
          ? {
              provider: settings.selectedModel.provider,
              name: settings.selectedModel.name,
            }
          : null);
      let cleanupStreamListeners: (() => void) | null = null;
      try {
        clearActivityForChatInStore(chatId);
        getDefaultStore().set(streamThreadByChatIdAtom, (prev) => {
          const n = new Map(prev);
          n.set(chatId, []);
          return n;
        });
        toolEndStackRef.current.delete(chatId);
        getDefaultStore().set(
          livePlanUpdateByAssistantMessageIdAtom,
          (prev) => {
            const n = new Map(prev);
            for (const [messageId, payload] of n) {
              if (payload.chatId === chatId) {
                n.delete(messageId);
              }
            }
            return n;
          },
        );

        // Register permission handler for this chat
        const unsubscribeUserQuestion =
          IpcClient.getInstance().onUserQuestionRequest(chatId, (payload) => {
            queueMicrotask(() => {
              // v11.1: the asking turn ENDS at the question — no freeze
              // baseline needed; there is no live stream to suppress.
              setPendingUserQuestionByChatId((prev) => ({
                ...prev,
                [chatId]: {
                  questionId: payload.questionId,
                  question: payload.question,
                  options: payload.options,
                  questions: payload.questions,
                },
              }));
            });
          });

        const unsubscribePermission =
          IpcClient.getInstance().onPermissionRequest(chatId, (payload) => {
            // Convert permission request to FileProposal format
            const request = payload.request;
            const previews = Array.isArray(request.preview)
              ? request.preview
              : [request.preview];

            // Handle file operations
            const fileProposals: FileProposal[] = previews
              .filter((p: any) => p.path) // File operations have a path
              .map((p: any) => ({
                id: payload.operationId,
                chatId, // Include the chat session ID for approval
                path: p.path,
                operation:
                  p.type === "delete"
                    ? "delete"
                    : p.type === "rename"
                      ? "rename"
                      : p.type === "update"
                        ? "modify"
                        : "create",
                newContent: p.content,
                description: p.description,
                approved: false,
              }));

            // Handle command operations (check operation type, not preview fields)
            const commandProposals: FileProposal[] =
              request.operation === "run_command"
                ? [
                    {
                      id: payload.operationId,
                      chatId,
                      path: "", // Commands don't have a path
                      operation: "command" as const,
                      command: (request.preview as any).command,
                      workingDir:
                        (request.preview as any).workingDirectory || ".",
                      description:
                        (request.preview as any).description ||
                        `Run: ${(request.preview as any).command}`,
                      approved: false,
                    },
                  ]
                : [];

            // Stash the diff content (old + new, uncapped) from the permission
            // preview onto the matching thread tool item's toolArgs, so the
            // COMPLETED/persisted card renders an ACCURATE diff — including a full
            // overwrite of an existing file — without echoing content into the
            // model transcript. The display snapshot (which persists toolArgs) is
            // never sent to the model, so this costs ZERO model tokens.
            for (const p of previews as Array<Record<string, unknown>>) {
              if (!p || typeof p.path !== "string") continue;
              if (p.content == null && p.oldContent == null) continue;
              const op =
                p.type === "create"
                  ? "create"
                  : p.type === "delete"
                    ? "delete"
                    : "update";
              mergeWritePreviewIntoThread(
                chatId,
                p.path,
                op,
                typeof p.oldContent === "string" ? p.oldContent : null,
                typeof p.content === "string" ? p.content : null,
              );
            }

            const allProposals = [...fileProposals, ...commandProposals];

            // Add to pending proposals (with deduplication).
            //
            // The updater is now PURE. The sound used to live inside it, along
            // with a toast, and a React state updater may be invoked more than
            // once for the same update — so both could fire twice for one
            // approval. Effects belong out here, where they run once.
            let added = 0;
            let hadPendingAlready = false;

            setPendingProposals((prev) => {
              // Deduplicate by operation ID - don't re-add if already exists
              const existingIds = new Set(prev.map((p) => p.id));
              const newProposals = allProposals.filter(
                (p) => !existingIds.has(p.id),
              );

              added = newProposals.length;
              hadPendingAlready = prev.length > 0;

              if (newProposals.length === 0) {
                return prev; // No new proposals to add
              }

              return [...prev, ...newProposals];
            });

            if (added > 0) {
              if (hadPendingAlready) playRemaining();
              else playNotify();
            }

            // NOTHING OPENS THE RIGHT PANEL HERE ANY MORE.
            //
            // This used to call `setRightPanelVisible(true)` unconditionally,
            // outside the updater — so it fired even when the updater had
            // early-returned with nothing added, which is every redelivered
            // permission and every operation the converter above yields no
            // proposals for (batch_plan, automation_write,
            // revert_project_snapshot: no `path`, and not `run_command`). The
            // panel reopened on each one, so closing it never stuck and it
            // showed an empty list when it did.
            //
            // And the panel could not have helped anyway: RightPanel filters
            // "permissions" out of its tab list entirely. Approvals moved INLINE
            // — `InlinePermissionApprovals` renders the cards, and
            // `PendingApprovalsBar` sits above the composer, self-hides when
            // nothing is pending, and jumps you to the card. A toast here was a
            // fourth notification for the same event whose "Review" button
            // switched to a tab that no longer renders.
            //
            // `pendingProposalsAtom` is still populated above: it has a live
            // reader in `useWorkspacePlanPanel`. This removes an unreachable
            // surface, not a data path.
          });

        // Register terminal output handler for this chat
        const pendingToolLiveRef = {
          rawLines: [] as string[],
          errLines: [] as string[],
          progLines: [] as string[],
          lastIncomingLine: null as string | null,
        };
        /**
         * Deltas waiting to be written into `terminalOutputs`, keyed by command.
         *
         * Deltas removed the per-chunk COST (218 ms → 6 ms of parsing per 4.9 MB
         * command); this removes the per-chunk RE-RENDER. A command emitting 75
         * chunks used to drive 75 React state updates, each copying the Map — so
         * the right panel re-rendered 75 times for one command.
         *
         * Coalesced on the same 250 ms timer as the live output lines, so the two
         * land together. A terminating event bypasses it entirely: `duration` is
         * recomputed from the last event received, so deferring the final one
         * would record a time up to a full window wrong.
         */
        const pendingTerminalDeltas = new Map<string, string>();
        /**
         * Commands whose entry already exists in `terminalOutputs`.
         *
         * Tracked here rather than read from state: this handler is a closure over
         * a stale `terminalOutputs`, and the first event for a command is the one
         * that creates its entry — coalescing before that would drop output into a
         * Map slot that does not exist yet.
         */
        const seenTerminalCommands = new Set<string>();
        let toolLiveFlushTimer: ReturnType<typeof setTimeout> | null = null;
        const flushTerminalDeltas = () => {
          if (pendingTerminalDeltas.size === 0) return;
          const batch = new Map(pendingTerminalDeltas);
          pendingTerminalDeltas.clear();
          setTerminalOutputs((prev) => {
            const next = new Map(prev);
            for (const [commandId, delta] of batch) {
              const existing = next.get(commandId);
              if (!existing) continue;
              next.set(commandId, {
                ...existing,
                output: appendCapped(existing.output, delta),
              });
            }
            return next;
          });
        };

        const flushToolLive = () => {
          toolLiveFlushTimer = null;
          flushTerminalDeltas();
          const rawLines = pendingToolLiveRef.rawLines;
          const errLines = pendingToolLiveRef.errLines;
          const progLines = pendingToolLiveRef.progLines;
          if (
            rawLines.length === 0 &&
            errLines.length === 0 &&
            progLines.length === 0
          )
            return;

          pendingToolLiveRef.rawLines = [];
          pendingToolLiveRef.errLines = [];
          pendingToolLiveRef.progLines = [];

          setToolIndicator((prev) => {
            if (!prev.active || prev.activeChatId !== chatId) return prev;
            const maxRaw = 300;
            const maxErr = 120;
            const maxProg = 120;
            return {
              ...prev,
              liveOutputLines: pushRing(prev.liveOutputLines, rawLines, maxRaw),
              liveErrorLines: pushRing(prev.liveErrorLines, errLines, maxErr),
              liveProgressLines: pushRing(
                prev.liveProgressLines,
                progLines,
                maxProg,
              ),
            };
          });
        };

        const unsubscribeTerminal = IpcClient.getInstance().onTerminalOutput(
          chatId,
          (payload) => {
            // THE DELTA, not the accumulated buffer.
            //
            // This block used to parse `payload.output` — the whole command's
            // output so far — on EVERY chunk: stripAnsi over N bytes, a split
            // into ~70,000 strings, then a map and a filter over all of them,
            // then pushing every line again. Measured on a 4.9 MB build log in
            // 75 chunks: 218 ms of blocked renderer main thread and 2.66 M line
            // strings, against 6 ms and 70 K for the deltas.
            //
            // The dedupe that used to guard this only fired when the payload was
            // a SINGLE line, which for any multi-line command never happens — so
            // it never did anything, and each chunk re-appended the whole output.
            // It is gone rather than adapted: with deltas it would silently drop
            // a legitimately repeated line (progress dots, a repeated "waiting…").
            //
            // Falls back to `output` so a consumer still on the old shape — the
            // synthesised completed/error events, which carry final text and no
            // delta — is not silently dropped.
            const chunk = payload.delta ?? payload.output ?? "";
            const raw = stripAnsi(chunk);
            const incomingLines = raw
              .split(/\r?\n/)
              .map((l) => l.trimEnd())
              .filter(Boolean);
            if (incomingLines.length > 0) {
              {
                pendingToolLiveRef.lastIncomingLine =
                  incomingLines[incomingLines.length - 1] ??
                  pendingToolLiveRef.lastIncomingLine;
                for (const ln of incomingLines) {
                  pendingToolLiveRef.rawLines.push(ln);
                  if (isErrorLikeLine(ln)) pendingToolLiveRef.errLines.push(ln);
                  if (!isSpammyProgressLine(ln))
                    pendingToolLiveRef.progLines.push(ln);
                }
              }

              // Throttle UI updates to avoid render storms.
              if (!toolLiveFlushTimer) {
                toolLiveFlushTimer = setTimeout(flushToolLive, 250);
              }
            }

            // APPEND the delta; never replace with the accumulated buffer.
            //
            // This read `payload.output` and replaced the stored value on every
            // chunk — the single largest cost on this path, because that string
            // is the whole command's output and the Map was copied around it each
            // time. It is also the site that would break silently if the wire
            // format switched to deltas without this change: the card would show
            // only the last chunk.
            //
            // Capped, per the owner's call: the card keeps a tail, so renderer
            // memory is bounded by the cap rather than by command size (a 50 MB
            // build log used to mean 50 MB retained in React state, per command).
            // Nothing is lost — the full output stays in the model's tool result,
            // the Terminal tab's own store, and background_jobs.
            //
            // The terminating completed/error event carries final full text and
            // no delta, so it replaces rather than appends — which is what makes
            // the finished card show the whole (capped) run.
            const isFinal =
              payload.status === "completed" || payload.status === "error";

            // A mid-run delta for a command we have already seen is BUFFERED and
            // written on the shared 250 ms flush, so 75 chunks cost one render
            // rather than 75. Anything else — the first event for a command,
            // which has to create the entry, a terminating event, or a payload
            // with no delta (the user path before it was converted, or a legacy
            // sender) — is written straight through.
            const canCoalesce =
              !isFinal &&
              payload.delta != null &&
              seenTerminalCommands.has(payload.commandId);
            if (canCoalesce) {
              pendingTerminalDeltas.set(
                payload.commandId,
                (pendingTerminalDeltas.get(payload.commandId) ?? "") +
                  payload.delta,
              );
              if (!toolLiveFlushTimer) {
                toolLiveFlushTimer = setTimeout(flushToolLive, 250);
              }
              return;
            }

            // Anything written straight through must not be overtaken by a
            // buffered delta that arrived earlier for the same command.
            flushTerminalDeltas();
            seenTerminalCommands.add(payload.commandId);

            setTerminalOutputs((prev) => {
              const next = new Map(prev);
              const existing = next.get(payload.commandId);
              const nextOutput = isFinal
                ? appendCapped("", payload.output || "")
                : payload.delta != null
                  ? appendCapped(existing?.output ?? "", payload.delta)
                  : payload.output || "";

              const output: TerminalOutput = {
                operationId: payload.commandId,
                command: payload.command,
                output: nextOutput,
                status: payload.status,
                exitCode: payload.exitCode,
                background: payload.background === true,
                startTime: existing?.startTime || Date.now(),
                duration: existing?.startTime
                  ? Date.now() - existing.startTime
                  : undefined,
              };

              next.set(payload.commandId, output);
              return next;
            });

            // Show terminal panel when commands are running
            // BUT: Don't force-switch if this is a permission-based command
            // (The AI intent system handles panel switching for those)
            if (payload.status === "running" && !payload.isPermissionBased) {
              maybeAutoOpenRightPanel();
              setPreviewTab("terminal");
            }

            // Clear completed/error commands from map after a delay
            if (payload.status === "completed" || payload.status === "error") {
              // Show error toast to inform user when command fails — but ONLY for
              // user-initiated commands. Agent/LLM-run command failures are normal
              // agentic flow (the model reacts to them itself) and already surface
              // as in-chat tool cards, so a popup would just be
              // noise. Legacy/undefined source still pops (treated as user-facing).
              if (payload.status === "error" && payload.source !== "agent") {
                const shortCmd =
                  payload.command.length > 50
                    ? payload.command.substring(0, 50) + "..."
                    : payload.command;
                showError(
                  `Command failed: ${shortCmd}\n\n${payload.output || `Exit code: ${payload.exitCode ?? "unknown"}`}`,
                );
              }

              setTimeout(() => {
                setTerminalOutputs((prev) => {
                  const next = new Map(prev);
                  next.delete(payload.commandId);
                  return next;
                });
              }, 5000); // Keep visible for 5 seconds after completion
            }
          },
        );

        // Register operation status listener for permission queue UI
        const unsubscribeOperationStatus =
          IpcClient.getInstance().onOperationStatus((payload) => {
            // Update permission queue state based on operation status
            setPermissionQueue((prev) => {
              return updateOperationStatus(prev, payload.operationId, {
                status: payload.status as QueuedOperation["status"],
                progress: payload.progress,
                duration: payload.duration,
                error: payload.error,
              });
            });
          });

        const unsubPlanArtifact = IpcClient.getInstance().onPlanArtifactUpdated(
          (payload) => {
            // v13.1: plan is a coexisting tab. Only steer the panel to the Plan
            // tab on FIRST activation of a given plan — repeated content updates
            // must not yank a user who switched to Terminal mid-build.
            const isNewPlan =
              getDefaultStore().get(workspacePlanPanelAtom).planId !==
              payload.planId;
            getDefaultStore().set(workspacePlanPanelAtom, (prev) => ({
              ...prev,
              planId: payload.planId,
              content: payload.content,
              planStatus: payload.planStatus,
              sessionId: payload.sessionId,
            }));
            if (isNewPlan) {
              getDefaultStore().set(aiPanelIntentAtom, {
                intent: "show-plan",
                timestamp: Date.now(),
                source: "system",
              });
              getDefaultStore().set(previewTabAtom, "plan");
              if (!getDefaultStore().get(rightPanelSuppressAutoOpenAtom)) {
                getDefaultStore().set(rightPanelVisibleAtom, true);
              }
            }
          },
        );

        const unsubscribeChatActivity = IpcClient.getInstance().onChatActivity(
          (payload: unknown) => {
            if (!payload || typeof payload !== "object") return;
            const p = payload as {
              chatId?: number;
              type?: string;
              id?: unknown;
              label?: unknown;
              timestamp?: number;
              fromAgent?: unknown;
              toAgent?: unknown;
              modelId?: unknown;
              responseMs?: unknown;
            };
            if (typeof p.chatId !== "number" || p.chatId !== chatId) return;

            const item = normalizeChatActivityPayload(payload);
            if (item) {
              getDefaultStore().set(activityStreamItemsAtom, (prev) =>
                upsertActivityStreamItem(prev, item),
              );
              const isSubagent =
                item.type === "subagent_start" ||
                item.type === "subagent_progress" ||
                item.type === "subagent_thought" ||
                item.type === "subagent_tokens" ||
                item.type === "subagent_complete";
              if (isSubagent) {
                getDefaultStore().set(streamThreadByChatIdAtom, (prev) => {
                  const n = new Map(prev);
                  const cur = n.get(chatId) ?? [];
                  n.set(chatId, mergeSubagentActivityIntoThread(cur, item));
                  return n;
                });
              } else {
                const parentDelegationId =
                  item.parentDelegationId?.trim() || undefined;
                const isNestedTool =
                  parentDelegationId && item.type === "tool_use";
                if (isNestedTool) {
                  getDefaultStore().set(streamThreadByChatIdAtom, (prev) => {
                    const n = new Map(prev);
                    const cur = n.get(chatId) ?? [];
                    n.set(
                      chatId,
                      mergeNestedToolActivityIntoSubagentRound(
                        cur,
                        parentDelegationId,
                        item,
                      ),
                    );
                    return n;
                  });
                } else {
                  const threadItem = streamThreadItemFromActivity(item);
                  if (threadItem) {
                    getDefaultStore().set(streamThreadByChatIdAtom, (prev) => {
                      const n = new Map(prev);
                      const cur = n.get(chatId) ?? [];
                      let next = cur;
                      if (
                        threadItem.kind === "tool" &&
                        threadItem.status !== "running"
                      ) {
                        next = handleStreamToolEnd(cur, {
                          // Display name stays the tool name; matching prefers the
                          // per-call id (Fix 2) so the right card of two same-named
                          // calls is finalized, with name/last-running fallback.
                          toolId: item.toolName ?? threadItem.id,
                          toolCallId: item.toolCallId ?? threadItem.id,
                          toolName: item.toolName,
                          status: threadItem.status,
                          detail: item.detail,
                          resultText: item.resultText ?? threadItem.resultText,
                          expand: threadItem.expand,
                        });
                      } else {
                        next = upsertStreamThreadItem(cur, threadItem);
                      }
                      n.set(chatId, next);
                      return n;
                    });
                  }
                }
              }
            }

            if (p.type === "plan_created") {
              getDefaultStore().set(aiPanelIntentAtom, {
                intent: "show-plan",
                timestamp: Date.now(),
                source: "system",
              });
              getDefaultStore().set(previewTabAtom, "plan");
              if (!getDefaultStore().get(rightPanelSuppressAutoOpenAtom)) {
                getDefaultStore().set(rightPanelVisibleAtom, true);
              }
            }
          },
        );

        const unsubscribeToolIndicator =
          IpcClient.getInstance().onToolIndicator(
            (start) => {
              if (start.chatId !== chatId) return;
              const registryName =
                start.toolId?.trim() || start.toolName?.trim() || "tool";
              // `task` sub-agents render in the sub-agent round panel — no
              // generic tool card for the wrapping tool itself.
              if (registryName === "task") {
                return;
              }
              const stack = toolEndStackRef.current.get(chatId) ?? [];
              // Keep the per-call id on the LIFO entry so the end leg can match it
              // precisely (the stack remains the fallback when no callId is sent).
              stack.push({
                toolId: registryName,
                toolName: registryName,
                toolCallId: start.toolCallId,
              });
              toolEndStackRef.current.set(chatId, stack);
              const threadItem = streamThreadItemFromToolStart({
                toolId: registryName,
                toolCallId: start.toolCallId,
                // Carry the tool-call args (incl. write content) onto the thread
                // item so the completed/persisted card renders its diff from the
                // model's OWN args — never re-sent to the model (display-only).
                toolArgs: start.toolArgs ?? undefined,
              });
              getDefaultStore().set(streamThreadByChatIdAtom, (prev) => {
                const n = new Map(prev);
                const cur = n.get(chatId) ?? [];
                n.set(chatId, upsertStreamThreadItem(cur, threadItem));
                return n;
              });
              // The authoritative tool card is now open — drop the streaming
              // partial-args preview for this chat.
              setLiveToolInputByChatId((prev) => {
                if (!prev.has(chatId)) return prev;
                const n = new Map(prev);
                n.delete(chatId);
                return n;
              });
              setToolIndicator((prev) => ({
                ...prev,
                active: true,
                toolName: start.toolName,
                toolId: start.toolId ?? null,
                toolArgs: start.toolArgs ?? null,
                phaseLabel: null,
                count: prev.count + 1,
                activeChatId: chatId,
                liveOutputLines: [],
                liveErrorLines: [],
                liveProgressLines: [],
                liveViewMode: "error_first",
              }));
            },
            (end) => {
              if (end.chatId !== chatId) return;
              const endName = end.toolId?.trim() || end.toolName?.trim() || "";
              if (endName === "task") {
                return;
              }
              const stack = toolEndStackRef.current.get(chatId) ?? [];
              // Prefer the stack entry matching this call id (Fix 2 — handles
              // tools that complete out of order); LIFO pop is the no-callId
              // fallback for legacy/text-tool ends.
              let popped:
                | { toolId: string; toolName: string; toolCallId?: string }
                | undefined;
              if (end.toolCallId) {
                const matchIdx = stack.findIndex(
                  (e) => e.toolCallId === end.toolCallId,
                );
                popped =
                  matchIdx >= 0 ? stack.splice(matchIdx, 1)[0] : stack.pop();
              } else {
                popped = stack.pop();
              }
              const toolName =
                popped?.toolName ?? end.toolName ?? end.toolId ?? "";
              if (
                end.status !== "error" &&
                (toolName === "edit_file" ||
                  toolName === "write_file" ||
                  toolName === "write_multiple_files" ||
                  toolName === "run_command")
              ) {
                refreshApp();
              }
              if (stack.length === 0) {
                toolEndStackRef.current.delete(chatId);
              } else {
                toolEndStackRef.current.set(chatId, stack);
              }
              const registryName =
                popped?.toolName?.trim() ||
                end.toolName?.trim() ||
                end.toolId?.trim() ||
                "";
              // The call id first: `chat:tool:end` carries it, and it is the only thing
              // that tells two concurrent calls of one tool apart.
              const endCallId = (end.toolCallId ?? popped?.toolCallId)?.trim();
              const activityResult =
                registryName || endCallId
                  ? findLatestToolActivityResult(
                      chatId,
                      registryName,
                      endCallId,
                    )
                  : {};
              getDefaultStore().set(streamThreadByChatIdAtom, (prev) => {
                const n = new Map(prev);
                const cur = n.get(chatId) ?? [];
                n.set(
                  chatId,
                  handleStreamToolEnd(cur, {
                    toolId: end.toolId ?? popped?.toolId,
                    toolCallId: end.toolCallId ?? popped?.toolCallId,
                    toolName: popped?.toolName,
                    status: end.status === "error" ? "error" : "done",
                    detail: activityResult.detail,
                    resultText: activityResult.resultText,
                  }),
                );
                return n;
              });
              setToolIndicator((prev) => {
                const newCount = Math.max(0, prev.count - 1);
                return {
                  ...prev,
                  active: newCount > 0,
                  count: newCount,
                  phaseLabel: newCount === 0 ? null : prev.phaseLabel,
                  toolArgs: newCount === 0 ? null : prev.toolArgs,
                };
              });
            },
          );

        // Keep the activity clock fresh during silent stream phases (e.g. a
        // long `edit_file` whole-file write streams its content as one
        // tool-input-delta and produces no renderable chunk). The backend
        // already emits `chat:stream:pulse` ~every 2s; without this subscriber
        // `streamLastActivityAtByChatIdAtom` would go stale and the UI would
        // falsely flip to "Reconnecting…" after 10s even though nothing dropped.
        const clearReconnecting = (evChatId: number) =>
          setReconnectingByChatId((prev) => {
            if (!prev.get(evChatId)) return prev;
            const n = new Map(prev);
            n.set(evChatId, false);
            return n;
          });
        const unsubscribePulse = IpcClient.getInstance().onStreamPulse(
          ({ chatId: evChatId }) => {
            setStreamLastActivityAtByChatId((prev) => {
              const n = new Map(prev);
              n.set(evChatId, Date.now());
              return n;
            });
            // A chunk/pulse arrived → the connection is alive again.
            clearReconnecting(evChatId);
          },
        );
        // Genuine reconnect: the backend emits reset-partial ONLY when it
        // actually retries a dropped/stalled round. Surface "Reconnecting…" then
        // (cleared by the next pulse above and on turn end).
        const unsubscribeResetPartial =
          IpcClient.getInstance().onStreamResetPartial(
            ({ chatId: evChatId }) => {
              setReconnectingByChatId((prev) => {
                const n = new Map(prev);
                n.set(evChatId, true);
                return n;
              });
            },
          );

        // Live partial tool-call args → streaming preview (e.g. an edit_file
        // write's content building up) before the approval card opens. Best-
        // effort: a tolerant extractor; on no usable data we leave today's
        // skeleton untouched. Cleared when the real tool card / stream end lands.
        const unsubscribeToolInput = IpcClient.getInstance().onStreamToolInput(
          ({ chatId: evChatId, toolName, argsTextSoFar }) => {
            const partial = extractPartialToolArgs(toolName, argsTextSoFar);
            if (!partial) return;
            setLiveToolInputByChatId((prev) => {
              const n = new Map(prev);
              n.set(evChatId, { toolName, ...partial });
              return n;
            });
          },
        );

        // Auto-approved write → no permission preview reached the renderer, so
        // merge its (display-only) old/new content into the matching tool card
        // the same way the manual-approval preview does. Accurate overwrite diff
        // at ZERO model tokens (the snapshot is never sent to the model).
        const unsubscribeWritePreview =
          IpcClient.getInstance().onStreamWritePreview(
            ({
              chatId: evChatId,
              path,
              operation,
              oldContent,
              content,
              hunks,
              addedCount,
              removedCount,
            }) => {
              mergeWritePreviewIntoThread(
                evChatId,
                path,
                operation,
                oldContent,
                content,
                hunks && addedCount != null && removedCount != null
                  ? { hunks, addedCount, removedCount }
                  : undefined,
              );
            },
          );

        cleanupStreamListeners = () => {
          if (toolLiveFlushTimer) {
            clearTimeout(toolLiveFlushTimer);
            toolLiveFlushTimer = null;
          }
          // Best-effort: flush anything pending once at the end.
          flushToolLive();

          // Tear down the pulse subscriber first so a late pulse can't re-add a
          // chat entry that onEnd/onError is about to delete.
          unsubscribePulse?.();
          unsubscribeResetPartial?.();
          unsubscribeToolInput?.();
          unsubscribeWritePreview?.();
          unsubscribeUserQuestion?.();
          unsubscribePermission?.();
          unsubscribeTerminal?.();
          // The 250 ms flush timer was never cleared here, so a pending flush
          // could fire after teardown and set state on an unmounted subscription.
          // Pre-existing; it matters more now that the timer also carries the
          // buffered terminal deltas.
          if (toolLiveFlushTimer) {
            clearTimeout(toolLiveFlushTimer);
            toolLiveFlushTimer = null;
          }
          unsubscribeOperationStatus?.();
          unsubscribeChatActivity?.();
          unsubPlanArtifact?.();
          unsubscribeToolIndicator?.();
          // Drop any leftover streaming preview for this chat.
          setLiveToolInputByChatId((prev) => {
            if (!prev.has(chatId)) return prev;
            const n = new Map(prev);
            n.delete(chatId);
            return n;
          });
        };

        // Pass 7: Blueprint injection-mode + debug-trace plumbing removed.

        const {
          modelPrompt: builtPrompt,
          displayPrompt,
          fileAttachments,
        } = buildPromptWithTextPastes(prompt, attachments);
        // A message the user typed carries any Revert since the last one.
        const promptForModel =
          continueAfterQuestions || continueInterrupted || redo || systemWake
            ? builtPrompt
            : await withRevertedFilesNote(chatId, builtPrompt);
        const pasteAttachments =
          collectPasteAttachmentsFromFileAttachments(attachments);

        const streamAppId = resolveStreamAppId(chatId);
        let workspaceSessionId: string | null = null;
        if (
          streamAppId != null &&
          !continueAfterQuestions &&
          !continueInterrupted &&
          !redo
        ) {
          const store = getDefaultStore();
          workspaceSessionId =
            store.get(chatIdToSessionIdAtom).get(chatId) ??
            (store.get(activeChatIdAtom) === chatId
              ? store.get(activeWorkspaceSessionIdAtom)
              : null);
          if (!workspaceSessionId) {
            workspaceSessionId = await ensureWorkspaceSessionForChat(
              streamAppId,
              chatId,
            );
          }
        }

        /**
         * The active session's stored mode — but ONLY when this turn belongs to
         * that session.
         *
         * A background chat streaming while you look at another session must not
         * inherit the mode of the one on screen; that would be the same
         * scope-confusion bug in a new place. When it does not match we send no
         * override and main resolves from the global preference, which is exactly
         * what happened before sessions owned a mode.
         */
        const modeStore = getDefaultStore();
        const sessionWorkMode =
          workspaceSessionId != null &&
          workspaceSessionId === modeStore.get(activeWorkspaceSessionIdAtom)
            ? modeStore.get(activeSessionWorkModeAtom)
            : null;

        // Remember what THIS turn dispatched with, so the composer can show the mode
        // the turn is actually running in while the picker offers the next one.
        // Mirrors the override sent below — the same expression, so the two cannot
        // drift apart and claim different modes for one turn.
        // Resolved to a CONCRETE mode, by the same precedence main uses
        // (`resolveEffectiveWorkMode`). Storing only the override would leave the
        // common case blank — a session with no stored mode dispatches with no
        // override — and the composer would then fall back to the global preference,
        // which is the very value a mid-turn switch has just changed. That is the
        // bug, not a gap in it.
        modeStore.set(turnWorkModeByChatIdAtom, (prev) => {
          const next = new Map(prev);
          next.set(
            chatId,
            resolveEffectiveWorkMode({
              workModeOverride:
                workModeOverride ?? sessionWorkMode ?? undefined,
              intentMode: settings?.intentMode,
              workModePreference: settings?.workModePreference,
              selectedChatMode: settings?.selectedChatMode ?? "ask",
            }),
          );
          return next;
        });

        IpcClient.getInstance().streamMessage(promptForModel, {
          displayPrompt,
          pasteAttachments:
            pasteAttachments.length > 0 ? pasteAttachments : undefined,
          chatId,
          redo,
          attachments: fileAttachments,
          modelOverride,
          appId: streamAppId,
          continueAfterQuestions,
          continueInterrupted,
          systemWake,
          workspaceSessionId: workspaceSessionId ?? undefined,
          prefillTaskLedger,
          // The SESSION's mode, unless the caller named one for this turn only
          // (edit/resend, the plan panel, an automation).
          //
          // Sending it every turn is the point: without an override main falls
          // back to the GLOBAL `workModePreference`, which is a per-session
          // decision made from app-wide state — the same shape as the v14.32.0
          // and v14.34.0 bugs. A session with no stored mode still sends nothing
          // and still resolves from the global, exactly as before.
          workModeOverride: workModeOverride ?? sessionWorkMode ?? undefined,
          escalate,
          onUpdate: (updatedMessages: Message[]) => {
            // v11.1: no freeze-baseline clamp — the turn ends at ask_user, so
            // there is no speculative streaming to suppress while pending.
            const messagesForUi = updatedMessages;

            // A message sent while this turn ran sits in front of the reply as
            // its own row; record WHERE the agent took it, so the finished
            // turn shows it there rather than above the whole answer (QA #4).
            if (userIdsAtTurnStart == null) {
              userIdsAtTurnStart = new Set(
                messagesForUi.filter((m) => m.role === "user").map((m) => m.id),
              );
            } else {
              let replyAt = -1;
              messagesForUi.forEach((m, i) => {
                if (m.role === "assistant") replyAt = i;
              });
              messagesForUi.forEach((m, i) => {
                if (m.role !== "user" || userIdsAtTurnStart!.has(m.id)) return;
                userIdsAtTurnStart!.add(m.id);
                if (replyAt < 0 || i > replyAt) return;
                const rowKey = m.sessionRowId ?? String(m.id);
                getDefaultStore().set(streamThreadByChatIdAtom, (prev) => {
                  const n = new Map(prev);
                  n.set(
                    chatId,
                    upsertStreamThreadItem(n.get(chatId) ?? [], {
                      kind: "interjection",
                      id: `interj-${rowKey}`,
                      text: m.content ?? "",
                      rowKey,
                      ts: Date.now(),
                    }),
                  );
                  return n;
                });
              });
            }

            if (!hasIncrementedStreamCount) {
              setStreamCountById((prev) => {
                const next = new Map(prev);
                next.set(chatId, (prev.get(chatId) ?? 0) + 1);
                return next;
              });
              hasIncrementedStreamCount = true;
            }

            setStreamLastActivityAtByChatId((prev) => {
              const n = new Map(prev);
              n.set(chatId, Date.now());
              return n;
            });

            // Extract and enrich sources from messages. This runs on EVERY raw
            // chunk; sources only ever grow, so skip the whole rebuild (favicon
            // string-building + sort + atom writes) when the total count is
            // unchanged since the last chunk for this chat.
            const th = messageStreamThrottleRef.current;
            const lastAsst = [...messagesForUi]
              .reverse()
              .find((m) => m.role === "assistant");
            let sourceCount = 0;
            for (const msg of messagesForUi) {
              if (Array.isArray(msg.sources)) sourceCount += msg.sources.length;
            }
            if (th.sourcesCountByChatId.get(chatId) !== sourceCount) {
              th.sourcesCountByChatId.set(chatId, sourceCount);
              // Extract and enrich sources from messages
              const allSources: SourceItem[] = [];
              const seenUrls = new Set<string>();

              for (const msg of messagesForUi) {
                if (msg.sources && Array.isArray(msg.sources)) {
                  for (const source of msg.sources) {
                    const src = source as any;
                    const url = src.url || "";

                    // Skip duplicates
                    if (seenUrls.has(url)) continue;
                    seenUrls.add(url);

                    // Filter spam GitHub Issues (score ≤ 1.0)
                    const isGitHubIssue =
                      url.includes("github.com") && url.includes("/issues/");
                    const score = src.score || 0;
                    if (isGitHubIssue && score <= 1.0) continue;

                    allSources.push({
                      id: src.id || `${url}-${allSources.length}`,
                      title: src.title || "Untitled",
                      url: url,
                      snippet: src.snippet || src.content || "",
                      // Use Perplexica's favicon method (full URL, not just domain)
                      favicon: `https://s2.googleusercontent.com/s2/favicons?domain_url=${encodeURIComponent(url)}&sz=32`,
                      source: src.source || "web",
                      score: score,
                    });
                  }
                }
              }

              // Sort by score descending (highest first)
              allSources.sort((a, b) => (b.score || 0) - (a.score || 0));

              if (allSources.length > 0 && isForegroundChatId(chatId)) {
                setSourceList(allSources);
                maybeAutoOpenRightPanel();
              }

              if (lastAsst?.id != null && allSources.length > 0) {
                getDefaultStore().set(
                  sourcesByAssistantMessageIdAtom,
                  (prev) => ({
                    ...prev,
                    [lastAsst.id]: allSources,
                  }),
                );
              }
            } // end sources rebuild (skipped when count unchanged)

            if (lastAsst?.content) {
              th.lastAssistantRawByChatId.set(chatId, lastAsst.content);
            }
            if (lastAsst) {
              getDefaultStore().set(activeTurnScopeAtom, (prev) =>
                prev?.chatId === chatId
                  ? {
                      chatId,
                      assistantMessageId: lastAsst.id,
                      startedAt: prev.startedAt,
                    }
                  : prev,
              );
            }
            th.pending.set(chatId, messagesForUi);
            if (th.timer == null) {
              th.timer = setInterval(() => {
                if (th.pending.size === 0) return;
                // Adaptive cadence: the per-flush render cost grows with answer
                // length, so once a long answer is streaming, drop to every other
                // 50ms tick (~100ms effective). The eye can't resolve faster than
                // that, and it halves the whole-tree reconcile rate on the exact
                // case that spikes. Short answers keep the full 50ms cadence.
                th.tick += 1;
                let maxLen = 0;
                for (const cid of th.pending.keys()) {
                  const len = th.lastAssistantRawByChatId.get(cid)?.length ?? 0;
                  if (len > maxLen) maxLen = len;
                }
                if (th.tick % flushEveryNthTick(maxLen) !== 0) {
                  return; // skip this tick; pending is retained for the next one
                }
                const snapshot = new Map(th.pending);
                th.pending.clear();
                setMessagesById((prev) => {
                  const next = new Map(prev);
                  for (const [cid, m] of snapshot) {
                    next.set(cid, m);
                  }
                  return next;
                });
              }, 50);
            }
          },
          onEnd: (response: ChatResponseEnd) => {
            // Bug A: drop a superseded leg's late end so it can't clear
            // isStreaming or flush the queued message for the live turn.
            if (latestDispatchByChatRef.current.get(chatId) !== dispatchId) {
              // A superseded leg still owns its subscriptions (activity,
              // terminal, permission, tool input, write preview…). Returning
              // without releasing them left them alive, each closure writing a
              // duplicate of every later update for as long as the app ran.
              cleanupStreamListeners?.();
              return;
            }
            const liveMap = getDefaultStore().get(
              livePlanUpdateByAssistantMessageIdAtom,
            );
            for (const [messageId, live] of liveMap) {
              if (live.chatId === response.chatId && live.steps.length > 0) {
                getDefaultStore().set(
                  planSnapshotByAssistantMessageIdAtom,
                  (prev) => ({
                    ...prev,
                    [messageId]: live,
                  }),
                );
              }
            }
            getDefaultStore().set(
              livePlanUpdateByAssistantMessageIdAtom,
              (prev) => {
                const n = new Map(prev);
                for (const [messageId, live] of n) {
                  if (live.chatId === response.chatId) {
                    n.delete(messageId);
                  }
                }
                return n;
              },
            );
            cleanupStreamListeners?.();

            const thEnd = messageStreamThrottleRef.current;
            if (thEnd.timer != null) {
              clearInterval(thEnd.timer);
              thEnd.timer = null;
            }
            if (thEnd.pending.size > 0) {
              setMessagesById((prev) => {
                const next = new Map(prev);
                for (const [cid, m] of thEnd.pending) {
                  next.set(cid, m);
                }
                return next;
              });
              thEnd.pending.clear();
            }

            if (response.extraFiles) {
              showExtraFilesToast({
                files: response.extraFiles,
                error: response.extraFilesError,
                posthog,
              });
            }
            refreshProposal(chatId);

            refetchUserBudget();

            if (response.usedCompass) {
              getDefaultStore().set(compassUsageBumpAtom, (n) => n + 1);
              posthog?.capture("core_turn_completed", {
                chat_id: response.chatId,
                surface: hasChatId ? "workspace_chat" : "floating_chat",
              });
            }

            if (
              typeof response.reasoningTokens === "number" &&
              response.reasoningTokens > 0
            ) {
              getDefaultStore().set(
                lastReasoningTokensByChatIdAtom,
                (prev) => ({
                  ...prev,
                  [response.chatId]: response.reasoningTokens!,
                }),
              );
            }

            // v10: sub-agent/compaction tokens from this turn (context meter).
            if (
              typeof response.auxTokens === "number" &&
              response.auxTokens > 0
            ) {
              getDefaultStore().set(lastAuxTokensByChatIdAtom, (prev) => ({
                ...prev,
                [response.chatId]: response.auxTokens!,
              }));
            }

            // Per-source split of those tokens, so the meter can name what spent them.
            if (
              Array.isArray(response.auxBySource) &&
              response.auxBySource.length > 0
            ) {
              getDefaultStore().set(lastAuxBySourceByChatIdAtom, (prev) => ({
                ...prev,
                [response.chatId]: response.auxBySource!,
              }));
            }

            // v12 7D: BYOK per-turn cost estimate (token-meter cost line).
            if (typeof response.turnCostUsd === "number") {
              getDefaultStore().set(lastTurnCostUsdByChatIdAtom, (prev) => ({
                ...prev,
                [response.chatId]: response.turnCostUsd!,
              }));
            }

            // Fix 6: accumulate cumulative SESSION spend/tokens (running sum,
            // not last-turn-only). A resend loop bills the provider per request,
            // which only this total reflects. Provider-agnostic: cost adds when
            // a price is known, tokens always accumulate.
            if (
              typeof response.turnCostUsd === "number" &&
              response.turnCostUsd > 0
            ) {
              getDefaultStore().set(sessionCostUsdByChatIdAtom, (prev) => ({
                ...prev,
                [response.chatId]:
                  (prev[response.chatId] ?? 0) + response.turnCostUsd!,
              }));
            }
            if (
              typeof response.turnTokens === "number" &&
              response.turnTokens > 0
            ) {
              getDefaultStore().set(sessionTokensByChatIdAtom, (prev) => ({
                ...prev,
                [response.chatId]:
                  (prev[response.chatId] ?? 0) + response.turnTokens!,
              }));
            }

            setIsStreamingById((prev) => {
              const next = new Map(prev);
              next.set(chatId, false);
              return next;
            });
            // A3: a parked turn ended cleanly with background work outstanding —
            // show the calm "waiting … will resume automatically" chip. Any
            // non-parked end clears it (a normal completion or a turn that
            // already resumed). The auto-wake below starts the resume turn.
            getDefaultStore().set(parkedWaitingByChatIdAtom, (prev) => {
              const n = new Map(prev);
              if (response.parked) {
                n.set(chatId, {
                  commands: response.parkedCommands ?? 0,
                  subagents: response.parkedSubagents ?? 0,
                  parkedAt: Date.now(),
                });
              } else {
                n.delete(chatId);
              }
              return n;
            });
            setReconnectingByChatId((prev) => {
              if (!prev.get(chatId)) return prev;
              const n = new Map(prev);
              n.set(chatId, false);
              return n;
            });
            // v13 7B: clear the waiting chip and flush the one queued message
            // the user typed while the agent was blocked on a command.
            getDefaultStore().set(waitingOnCommandByChatIdAtom, (prev) => {
              if (!prev.has(chatId)) return prev;
              const n = new Map(prev);
              n.delete(chatId);
              return n;
            });
            // Bug F: close the auto-wake race. If a background command OR a
            // sub-agent finished just as the turn ended (so no further
            // prepareStep drained it) and the user has nothing queued, wake a
            // fresh turn to deliver the result instead of letting it sit until
            // the next user message. One combined check → one guarded wake.
            //
            // NEVER after the user pressed Stop. Cancel kills only foreground
            // commands, so a pending background result is normal at that moment —
            // and waking here started a brand-new turn that had no idea it had been
            // stopped. It re-read the file it had just edited, read its own change as
            // the user's, and kept going (observed: as far as `git push`). Stop has to
            // mean the agent stops deciding things. The result is not lost: it stays
            // pending and drains into the user's next turn.
            if (response.userCancelled) {
              userStoppedChatsRef.current.add(chatId);
            }
            const maybeWakeForBackgroundResults = () => {
              if (
                response.userCancelled ||
                userStoppedChatsRef.current.has(chatId)
              ) {
                return;
              }
              const ipc = IpcClient.getInstance();
              void Promise.all([
                ipc.backgroundHasPendingResults(response.chatId),
                ipc.subagentHasPendingResults(response.chatId),
              ])
                .then(([cmdPending, subPending]) => {
                  if (!cmdPending && !subPending) return;
                  const stillStreaming =
                    getDefaultStore()
                      .get(isStreamingByIdAtom)
                      .get(response.chatId) === true;
                  if (
                    stillStreaming ||
                    bgWakeInFlightRef.current.has(response.chatId)
                  ) {
                    return;
                  }
                  bgWakeInFlightRef.current.add(response.chatId);
                  void Promise.resolve(
                    streamMessageRef.current?.({
                      prompt: "",
                      chatId: response.chatId,
                      continueAfterQuestions: true,
                      systemWake: true,
                    }),
                  ).finally(() =>
                    bgWakeInFlightRef.current.delete(response.chatId),
                  );
                })
                .catch(() => {});
            };
            {
              /**
               * FALLBACK for mid-turn user messages.
               *
               * The normal path is `prepareStep`: a message typed mid-turn is
               * delivered into the RUNNING turn on its next step. But when the
               * model stops, there is no next step and nothing drains — so
               * anything still pending opens a fresh turn here instead. Between
               * the two, a message is always delivered exactly once: the drain
               * is take-once and shared, so whichever gets there first wins.
               *
               * DO NOT FLUSH OVER A PENDING QUESTION. `ask_user` deliberately
               * ENDS the turn ("answers arrive as the next message"), so this
               * handler runs while the question card is on screen. Starting a
               * turn here pre-empted the card and left the user no way to answer
               * except pressing Stop — which was the first domino of three
               * (observed 2026-09-03): the forced Stop latched `user-stopped`,
               * the empty-prompt answer turn could not clear the latch, and five
               * sub-agent wakes were then refused.
               *
               * The messages stay QUEUED in main, not dropped — answering
               * delivers them into the continuation turn.
               */
              const awaitingAnswer = Boolean(
                getDefaultStore().get(pendingUserQuestionByChatIdAtom)[chatId],
              );
              // The mirror can be stale (main may have delivered mid-turn
              // between the last repaint and now), so it decides only whether to
              // ASK; `flushUserInterjections` is the authority, and a null answer
              // means everything was already delivered.
              const mirrorHasPending =
                (getDefaultStore()
                  .get(pendingInterjectionsByChatIdAtom)
                  .get(chatId)?.length ?? 0) > 0;
              if (!mirrorHasPending || awaitingAnswer) {
                maybeWakeForBackgroundResults();
              } else {
                void IpcClient.getInstance()
                  .flushUserInterjections(chatId)
                  .then(({ text }) => {
                    if (!text?.trim()) {
                      maybeWakeForBackgroundResults();
                      return;
                    }
                    setTimeout(() => {
                      void streamMessageRef.current?.({ prompt: text, chatId });
                    }, 50);
                  })
                  .catch(() => maybeWakeForBackgroundResults());
              }
            }
            refreshChats();
            refreshApp();
            refreshVersions();
            invalidateTokenCount();

            // Turn finished. When the app is UNFOCUSED, fire the OS "finished
            // responding" notification (also covers the waiting-on-ask_user case).
            // The OS notification is the SINGLE completion sound — we no longer
            // ALSO play the in-app chime here, which doubled up annoyingly. When
            // FOCUSED, keep the in-app chime on tool/permission turns only (the
            // user is watching, so no OS-notification spam).
            const appUnfocused =
              typeof document !== "undefined" && !document.hasFocus();
            if (appUnfocused) {
              IpcClient.getInstance().notifyTurnDone(
                response.endedWaitingOnUser === true,
              );
            } else if (response.hadToolCallsOrPermissions) {
              playNotify();
            }

            // Store for ChatMessage so we can show "No actions this turn" when false in agent mode
            setLastTurnHadToolCallsByChatId((prev) => ({
              ...prev,
              [response.chatId]: response.hadToolCallsOrPermissions === true,
            }));

            const msgs =
              getDefaultStore()
                .get(chatMessagesByIdAtom)
                .get(response.chatId) ?? [];
            // The stopped reply gets its "interrupted… Continue" marker now,
            // not only after a reopen (QA 15.7.1 #7).
            if (response.userCancelled) {
              const marked = markStoppedReply(msgs);
              if (marked !== msgs) {
                getDefaultStore().set(chatMessagesByIdAtom, (prev) => {
                  const n = new Map(prev);
                  n.set(response.chatId, marked);
                  return n;
                });
              }
            }
            const rawFromRef =
              messageStreamThrottleRef.current.lastAssistantRawByChatId.get(
                response.chatId,
              );
            // v13.1: if this turn captured a shadow-git snapshot, remember its turn id
            // (= the assistant message id) so SimpleMessage can offer "revert this
            // turn's file changes".
            //
            // Hoisted out of the `rawFromRef` branch below (v14.23.0). That branch is
            // the THINKING-snapshot rebuild and only runs when streamed text was
            // buffered for this chat — a dependency this has no reason to inherit. On a
            // user-stopped turn the id could go unrecorded, and Revert is gated on
            // having it, so the affordance vanished for exactly the turn the user
            // stopped because it made a bad edit.
            {
              const lastAssistantForSnapshot = [...msgs]
                .reverse()
                .find((m) => m.role === "assistant");
              const snapshotTurnId = response.snapshotTurnId;
              if (
                lastAssistantForSnapshot &&
                snapshotTurnId &&
                Number.isFinite(Number(snapshotTurnId)) &&
                Number(snapshotTurnId) === lastAssistantForSnapshot.id
              ) {
                getDefaultStore().set(
                  turnSnapshotTurnIdByMessageIdAtom,
                  (prev) => {
                    const n = new Map(prev);
                    n.set(lastAssistantForSnapshot.id, snapshotTurnId);
                    return n;
                  },
                );
              }
            }
            if (rawFromRef) {
              const lastAssistant = [...msgs]
                .reverse()
                .find((m) => m.role === "assistant");
              if (lastAssistant) {
                const snap = extractThinkingFromContent(rawFromRef);
                if (hasThinkingSnapshotContent(snap)) {
                  getDefaultStore().set(
                    completedTurnThinkingByAssistantMessageIdAtom,
                    (prev) => ({ ...prev, [lastAssistant.id]: snap }),
                  );
                }
              }
            } else {
              captureThinkingSnapshotForChat(response.chatId, msgs);
            }
            messageStreamThrottleRef.current.lastAssistantRawByChatId.delete(
              response.chatId,
            );
            const lastAssistant = [...msgs]
              .reverse()
              .find((m) => m.role === "assistant");
            if (lastAssistant) {
              const thinkingSnap =
                getDefaultStore().get(
                  completedTurnThinkingByAssistantMessageIdAtom,
                )[lastAssistant.id] ?? null;
              const activitySnap = getDefaultStore().get(
                activityStreamItemsAtom,
              );
              // v14.8.10 Fix S2: the rebuild is a PERSISTENCE fallback, not a
              // regrouper — never overwrite an already-attached timeline, and
              // scope the activity to THIS turn (items since dispatch) so an
              // earlier turn's tool cards can't regroup under the final message
              // (observed: old edit cards re-rendered below a later summary).
              const turnStartedAt =
                getDefaultStore().get(activeTurnScopeAtom)?.startedAt ?? 0;
              const hasExistingTimeline =
                (getDefaultStore().get(inlineTimelineByMessageIdAtom)[
                  lastAssistant.id
                ]?.length ?? 0) > 0;
              const timeline = buildInlineTimelineFromActivity(
                filterActivityForChat(activitySnap, response.chatId).filter(
                  (a) => a.timestamp >= turnStartedAt,
                ),
                thinkingSnap,
              );
              if (timeline.length > 0 && !hasExistingTimeline) {
                getDefaultStore().set(
                  inlineTimelineByMessageIdAtom,
                  (prev) => ({
                    ...prev,
                    [lastAssistant.id]: timeline,
                  }),
                );
              }
              // (snapshot turn id is recorded above, outside this branch)
            }
            getDefaultStore().set(activeTurnScopeAtom, null);

            setToolIndicator((prev) => {
              if (
                prev.activeChatId != null &&
                prev.activeChatId !== response.chatId
              ) {
                return prev;
              }
              return emptyToolIndicatorState();
            });
            const summarization = getDefaultStore().get(
              summarizationProgressAtom,
            );
            if (
              summarization.chatId == null ||
              summarization.chatId === response.chatId
            ) {
              getDefaultStore().set(summarizationProgressAtom, {
                active: false,
                chatId: null,
                label: undefined,
              });
            }
            const thoughtForFreeze = resolveThoughtContentForPersist(
              response.chatId,
              rawFromRef,
              lastAssistant?.content,
            );
            persistAndClearLiveStreamThread(
              response.chatId,
              lastAssistant?.id,
              thoughtForFreeze,
              lastAssistant?.content,
            );

            const frozenThread =
              lastAssistant?.id != null
                ? (getDefaultStore().get(
                    completedStreamThreadByAssistantMessageIdAtom,
                  )[lastAssistant.id] ?? [])
                : [];
            const inlineForSnap =
              lastAssistant?.id != null
                ? getDefaultStore().get(inlineTimelineByMessageIdAtom)[
                    lastAssistant.id
                  ]
                : undefined;
            const thinkingForSnap =
              lastAssistant?.id != null
                ? getDefaultStore().get(
                    completedTurnThinkingByAssistantMessageIdAtom,
                  )[lastAssistant.id]
                : null;
            // Persist the ordered unstripped raw ONLY when it carries `<think>`
            // (the one thing the saved content strips). Tool tags survive in
            // content, so tool order is already preserved there; this restores
            // thought positions so the frozen view interleaves like streaming.
            const interleavedForSnap =
              rawFromRef && /<think>/i.test(rawFromRef)
                ? rawFromRef
                : undefined;
            // Set the live atom so the just-finished turn renders interleaved
            // immediately (the snapshot below only takes effect on reload).
            if (interleavedForSnap && lastAssistant?.id != null) {
              getDefaultStore().set(
                interleavedDisplayContentByMessageIdAtom,
                (prev) => ({ ...prev, [lastAssistant.id]: interleavedForSnap }),
              );
            }
            const snapshotJson =
              lastAssistant?.id != null
                ? buildDisplaySnapshotPayloadForMessage(
                    lastAssistant.id,
                    frozenThread,
                    inlineForSnap,
                    thinkingForSnap,
                    interleavedForSnap,
                    turnModel,
                  )
                : null;
            if (turnModel && lastAssistant?.id != null) {
              const id = lastAssistant.id;
              getDefaultStore().set(turnModelByAssistantMessageIdAtom, (prev) => ({
                ...prev,
                [id]: turnModel,
              }));
            }

            if (snapshotJson && lastAssistant?.id != null) {
              void IpcClient.getInstance()
                .setChatDisplaySnapshot({
                  chatId: response.chatId,
                  messageId: lastAssistant.id,
                  displaySnapshot: snapshotJson,
                })
                .catch((e) => {
                  console.error("Failed to persist display snapshot:", e);
                });
              setMessagesById((prev) => {
                const next = new Map(prev);
                const cur = next.get(response.chatId);
                if (!cur) return next;
                next.set(
                  response.chatId,
                  cur.map((m) =>
                    m.id === lastAssistant.id
                      ? {
                          ...m,
                          displaySnapshot:
                            parseDisplaySnapshot(snapshotJson) ?? undefined,
                        }
                      : m,
                  ),
                );
                return next;
              });
            }

            const appIdForPersist = getDefaultStore().get(selectedAppIdAtom);
            void (async () => {
              const sessionIdForPersist =
                appIdForPersist != null
                  ? await ensureWorkspaceSessionForChat(
                      appIdForPersist,
                      response.chatId,
                    )
                  : null;
              if (!sessionIdForPersist || appIdForPersist == null) return;
              // A stopped turn is saved by main (its interrupted row, with the
              // stop note for the model). A copy saved here had neither, and
              // beside that row it showed the turn twice on reopen.
              if (response.userCancelled) return;
              const assistantContent = lastAssistant?.content?.trim();
              if (!assistantContent) return;
              try {
                // v12 0.2 (B2): native-history envelope round-trips into the
                // session store so reloads replay native tool parts. Also persist
                // the shadow-git revert-checkpoint id so revert-turn survives a
                // restart (the snapshots themselves already live on disk).
                const persistExtras: {
                  modelContent?: string | null;
                  snapshotTurnId?: string | null;
                  maxTokensUsed?: number | null;
                } = {};
                if (response.assistantModelContent) {
                  persistExtras.modelContent = response.assistantModelContent;
                }
                if (response.snapshotTurnId) {
                  persistExtras.snapshotTurnId = response.snapshotTurnId;
                }
                // Persist the PROVIDER's real total for this turn. Without it the
                // meter loses its ground truth on restart and silently falls back
                // to the client-side estimate, which counts only flat persisted
                // messages — no system prompt, no native tool history — and so
                // reads roughly half. Reopening the app looked like the context
                // had been summarised away when nothing had happened at all.
                {
                  const live = getDefaultStore().get(liveTurnUsageByChatIdAtom)[
                    response.chatId
                  ];
                  const total = live ? (live.input ?? 0) + live.output : 0;
                  if (total > 0) persistExtras.maxTokensUsed = total;
                }
                await IpcClient.getInstance().addSessionMessage(
                  sessionIdForPersist,
                  "assistant",
                  assistantContent,
                  snapshotJson ?? undefined,
                  Object.keys(persistExtras).length > 0
                    ? persistExtras
                    : undefined,
                );
                const activeSessionId = getDefaultStore().get(
                  activeWorkspaceSessionIdAtom,
                );
                if (
                  activeSessionId != null &&
                  activeSessionId !== sessionIdForPersist
                ) {
                  showInfo("Background session finished");
                }
              } catch (e) {
                console.error(
                  "Failed to persist assistant session message:",
                  e,
                );
              }
            })();

            if (appIdForPersist != null) {
              getDefaultStore().set(workspaceSessionsRefreshAtom, (n) => n + 1);
            }

            clearActivityForChatInStore(response.chatId);
            toolEndStackRef.current.delete(response.chatId);
            setStreamLastActivityAtByChatId((prev) => {
              const n = new Map(prev);
              n.delete(response.chatId);
              return n;
            });

            // v3.5: Brief "done" phase of Atlarix animation when response completes
            setResponseDoneAnimation({
              chatId: response.chatId,
              until: Date.now() + 2000,
            });

            // PASS6: trim renderer message window after a completed turn (not during streaming).
            setMessagesById((prev) => {
              const next = new Map(prev);
              const cur = next.get(response.chatId);
              if (cur) next.set(response.chatId, trimRendererMessages(cur));
              return next;
            });

            // v3.9: Clear "conversation restarted from here" divider when stream ends
            setRestartedAfterMessageId(null);

            onSettled?.();
          },
          onError: (errorMessage: string) => {
            // Bug A: ignore a superseded leg's late error.
            if (latestDispatchByChatRef.current.get(chatId) !== dispatchId) {
              // A superseded leg still owns its subscriptions (activity,
              // terminal, permission, tool input, write preview…). Returning
              // without releasing them left them alive, each closure writing a
              // duplicate of every later update for as long as the app ran.
              cleanupStreamListeners?.();
              return;
            }
            const liveMapErr = getDefaultStore().get(
              livePlanUpdateByAssistantMessageIdAtom,
            );
            for (const [messageId, liveErr] of liveMapErr) {
              if (liveErr.chatId === chatId && liveErr.steps.length > 0) {
                getDefaultStore().set(
                  planSnapshotByAssistantMessageIdAtom,
                  (prev) => ({
                    ...prev,
                    [messageId]: liveErr,
                  }),
                );
              }
            }
            getDefaultStore().set(
              livePlanUpdateByAssistantMessageIdAtom,
              (prev) => {
                const n = new Map(prev);
                for (const [messageId, live] of n) {
                  if (live.chatId === chatId) {
                    n.delete(messageId);
                  }
                }
                return n;
              },
            );
            cleanupStreamListeners?.();
            const thErr = messageStreamThrottleRef.current;
            if (thErr.timer != null) {
              clearInterval(thErr.timer);
              thErr.timer = null;
            }
            if (thErr.pending.size > 0) {
              setMessagesById((prev) => {
                const next = new Map(prev);
                for (const [cid, m] of thErr.pending) {
                  next.set(cid, m);
                }
                return next;
              });
              thErr.pending.clear();
            }
            console.error(`[CHAT] Stream error for ${chatId}:`, errorMessage);
            if (errorMessage.includes(ATLARIX_AUTH_REQUIRED_PREFIX)) {
              posthog?.capture("auth_chat_stream_blocked", { chat_id: chatId });
            } else if (/compass/i.test(errorMessage)) {
              posthog?.capture("core_turn_failed", {
                chat_id: chatId,
                error_snippet: errorMessage.slice(0, 240),
              });
              Sentry.captureException(new Error(errorMessage.slice(0, 500)), {
                tags: { feature: "compass", source: "renderer_stream" },
                extra: { chatId },
              });
            }
            setErrorById((prev) => {
              const next = new Map(prev);
              next.set(chatId, errorMessage);
              return next;
            });

            // Keep the same as above
            setIsStreamingById((prev) => {
              const next = new Map(prev);
              next.set(chatId, false);
              return next;
            });
            setReconnectingByChatId((prev) => {
              if (!prev.get(chatId)) return prev;
              const n = new Map(prev);
              n.set(chatId, false);
              return n;
            });
            const msgsErr =
              getDefaultStore().get(chatMessagesByIdAtom).get(chatId) ?? [];
            const rawErr =
              messageStreamThrottleRef.current.lastAssistantRawByChatId.get(
                chatId,
              );
            if (rawErr) {
              const lastAssistant = [...msgsErr]
                .reverse()
                .find((m) => m.role === "assistant");
              if (lastAssistant) {
                const snap = extractThinkingFromContent(rawErr);
                if (hasThinkingSnapshotContent(snap)) {
                  getDefaultStore().set(
                    completedTurnThinkingByAssistantMessageIdAtom,
                    (prev) => ({ ...prev, [lastAssistant.id]: snap }),
                  );
                }
              }
            } else {
              captureThinkingSnapshotForChat(chatId, msgsErr);
            }
            messageStreamThrottleRef.current.lastAssistantRawByChatId.delete(
              chatId,
            );
            const lastAssistantErr = [...msgsErr]
              .reverse()
              .find((m) => m.role === "assistant");
            if (lastAssistantErr) {
              const thinkingSnap =
                getDefaultStore().get(
                  completedTurnThinkingByAssistantMessageIdAtom,
                )[lastAssistantErr.id] ?? null;
              const activityErr = getDefaultStore().get(
                activityStreamItemsAtom,
              );
              // Fix S2: same scoping as the end path — persistence fallback
              // only, this turn's activity only.
              const turnStartedAtErr =
                getDefaultStore().get(activeTurnScopeAtom)?.startedAt ?? 0;
              const hasExistingTimelineErr =
                (getDefaultStore().get(inlineTimelineByMessageIdAtom)[
                  lastAssistantErr.id
                ]?.length ?? 0) > 0;
              const timeline = buildInlineTimelineFromActivity(
                filterActivityForChat(activityErr, chatId).filter(
                  (a) => a.timestamp >= turnStartedAtErr,
                ),
                thinkingSnap,
              );
              if (timeline.length > 0 && !hasExistingTimelineErr) {
                getDefaultStore().set(
                  inlineTimelineByMessageIdAtom,
                  (prev) => ({
                    ...prev,
                    [lastAssistantErr.id]: timeline,
                  }),
                );
              }
              // Interrupted turn: keep the partial reply interleaved in-session.
              if (rawErr && /<think>/i.test(rawErr)) {
                getDefaultStore().set(
                  interleavedDisplayContentByMessageIdAtom,
                  (prev) => ({ ...prev, [lastAssistantErr.id]: rawErr }),
                );
              }
            }
            getDefaultStore().set(activeTurnScopeAtom, null);

            setToolIndicator((prev) => {
              if (prev.activeChatId != null && prev.activeChatId !== chatId) {
                return prev;
              }
              return emptyToolIndicatorState();
            });
            const summarizationErr = getDefaultStore().get(
              summarizationProgressAtom,
            );
            if (
              summarizationErr.chatId == null ||
              summarizationErr.chatId === chatId
            ) {
              getDefaultStore().set(summarizationProgressAtom, {
                active: false,
                chatId: null,
                label: undefined,
              });
            }
            const thoughtErr = resolveThoughtContentForPersist(
              chatId,
              rawErr,
              lastAssistantErr?.content,
            );
            persistAndClearLiveStreamThread(
              chatId,
              lastAssistantErr?.id,
              thoughtErr,
              lastAssistantErr?.content,
            );
            clearActivityForChatInStore(chatId);
            toolEndStackRef.current.delete(chatId);
            setStreamLastActivityAtByChatId((prev) => {
              const n = new Map(prev);
              n.delete(chatId);
              return n;
            });
            refreshChats();
            refreshApp();
            refreshVersions();
            invalidateTokenCount();

            setMessagesById((prev) => {
              const next = new Map(prev);
              const cur = next.get(chatId);
              if (cur) next.set(chatId, trimRendererMessages(cur));
              return next;
            });

            onSettled?.();
          },
        });

        // Cleanup permission handler when this stream callback scope exits
        // Note: This happens in onEnd/onError callbacks, but we also need to handle
        // the case where the stream setup fails
      } catch (error) {
        console.error("[CHAT] Exception during streaming setup:", error);
        try {
          cleanupStreamListeners?.();
        } catch {
          // ignore
        }
        setToolIndicator(emptyToolIndicatorState());
        if (chatId) {
          setStreamLastActivityAtByChatId((prev) => {
            const n = new Map(prev);
            n.delete(chatId);
            return n;
          });
        }
        setIsStreamingById((prev) => {
          const next = new Map(prev);
          if (chatId) next.set(chatId, false);
          return next;
        });
        setErrorById((prev) => {
          const next = new Map(prev);
          if (chatId)
            next.set(
              chatId,
              error instanceof Error ? error.message : String(error),
            );
          return next;
        });
        onSettled?.();
      }
    },
    [
      setMessagesById,
      setToolIndicator,
      setStreamLastActivityAtByChatId,
      setLiveToolInputByChatId,
      setResponseDoneAnimation,
      setIsStreamingById,
      selectedAppId,
      refetchUserBudget,
      settings,
      setLastTurnHadToolCallsByChatId,
      setRestartedAfterMessageId,
      setPendingUserQuestionByChatId,
      posthog,
      hasChatId,
    ],
  );
  streamMessageRef.current = streamMessage;

  return {
    streamMessage,
    isStreaming:
      hasChatId && chatId !== undefined
        ? (isStreamingById.get(chatId) ?? false)
        : false,
    error:
      hasChatId && chatId !== undefined
        ? (errorById.get(chatId) ?? null)
        : null,
    setError: (value: string | null) =>
      setErrorById((prev) => {
        const next = new Map(prev);
        if (chatId !== undefined) next.set(chatId, value);
        return next;
      }),
    setIsStreaming: (value: boolean) =>
      setIsStreamingById((prev) => {
        const next = new Map(prev);
        if (chatId !== undefined) next.set(chatId, value);
        return next;
      }),
  };
}
