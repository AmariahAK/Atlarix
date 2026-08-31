import type {
  AutonomousSessionCompletePayload,
  FileAttachment,
  Message,
  PlanUpdatePayload,
} from "@/ipc/ipc_types";
import { atom } from "jotai";
import { atomFamily, selectAtom } from "jotai/utils";
import type { CompletedTurnThinkingSnapshot } from "@/lib/thinking/extract-thinking-from-content";
import type { InlineTimelineItem } from "@/lib/chat/inline-timeline";
import type { SourceItem, ActivityStreamItem } from "@/atoms/sourceAtoms";
import { activityStreamItemsAtom } from "@/atoms/sourceAtoms";
import type { StreamThreadItem } from "@/lib/chat/stream-thread";

// Per-chat atoms implemented with maps keyed by chatId
export const chatMessagesByIdAtom = atom<Map<number, Message[]>>(new Map());
export const chatErrorByIdAtom = atom<Map<number, string | null>>(new Map());

// Atom to hold the currently selected chat ID
export const selectedChatIdAtom = atom<number | null>(null);

// Active chat ID for seamless inline chat (persists across navigation)
// Only reset when "New Chat" is clicked or app restarts
export const activeChatIdAtom = atom<number | null>(null);

/**
 * Concurrent sessions: every workspace conversation the user has opened this
 * run, in open order. Switching the active chat must NOT drop the others — a
 * tab strip renders these so a session that is still streaming in the
 * background stays reachable (its per-chat state lives in the maps above).
 */
export interface OpenChatTab {
  chatId: number;
  appId: number | null;
  title: string;
}
export const openChatTabsAtom = atom<OpenChatTab[]>([]);

/**
 * Chats whose renderer state was EVICTED while they were cold, and which have not
 * been reloaded since.
 *
 * Needed because a background stream repopulates `chatMessagesByIdAtom` on its
 * own (main sends the whole message list on every chunk, not a delta) — but it
 * does NOT rebuild the per-message display atoms that hold frozen tool cards and
 * inline timelines, because only the full session load runs
 * `replaceDisplayHydrationForChat`. So "are the messages there?" is not a
 * sufficient test for "is this chat whole": a background-streamed evicted chat
 * would come back looking complete and render its earlier turns stripped of
 * their tool UI. Membership here is the honest signal, and it is cleared when a
 * chat is genuinely reloaded.
 */
export const evictedChatIdsAtom = atom<Set<number>>(new Set<number>());

export const isStreamingByIdAtom = atom<Map<number, boolean>>(new Map());

/**
 * The work mode each chat's RUNNING turn was dispatched with.
 *
 * A turn's mode is fixed at dispatch and cannot change mid-flight — deliberately, so
 * a picker click in one window can never revoke a live turn's write permission (the
 * v14.36.0 defect). That makes the picker and the running turn two different facts,
 * and the composer needs both: it shows what the turn IS running as while offering
 * the mode your next message will use.
 *
 * Written at dispatch and NOT cleared at stream end. Consumers pair it with
 * `isStreamingForChatAtom` and ignore it when no turn is live, so a leftover entry
 * can never be shown as if it were current — and the next dispatch overwrites it.
 * That keeps the write to one site instead of every one of the five places a stream
 * can end, any one of which could be missed.
 */
export const turnWorkModeByChatIdAtom = atom<
  Map<number, import("@/lib/schemas").WorkMode>
>(new Map());
export const chatInputValueAtom = atom<string>("");


// Used for scrolling to the bottom of the chat messages (per chat)
export const chatStreamCountByIdAtom = atom<Map<number, number>>(new Map());
export const recentStreamChatIdsAtom = atom<Set<number>>(new Set<number>());

export const attachmentsAtom = atom<FileAttachment[]>([]);

/** Per-chat: whether the last completed turn had tool runs or a permission request. Used to show "No actions this turn" when false in agent mode. */
export const lastTurnHadToolCallsByChatIdAtom = atom<Record<number, boolean>>({});

/** Per-chat: last reported reasoning / thinking token count from stream end (thinking-tier turns). */
export const lastReasoningTokensByChatIdAtom = atom<Record<number, number>>({});

/** v10: per-chat auxiliary LLM tokens (sub-agents, compaction) from the last completed turn. */
export const lastAuxTokensByChatIdAtom = atom<Record<number, number>>({});

/**
 * Per-chat split of the last turn's auxiliary tokens by source. Sub-agents are work
 * the user asked for; compaction is the app spending on their behalf — the single
 * `lastAuxTokens` figure showed both under a "Sub-agents" label.
 */
export const lastAuxBySourceByChatIdAtom = atom<
  Record<
    number,
    Array<{
      source: "subagents" | "compaction" | "other";
      tokens: number;
      calls: number;
      /** Of `tokens`, the share ESTIMATED because a provider reported no usage. */
      estimatedTokens: number;
    }>
  >
>({});

/** v12 7D: per-chat estimated BYOK USD cost of the last completed turn. */
export const lastTurnCostUsdByChatIdAtom = atom<Record<number, number>>({});

/**
 * Cumulative session spend per chat (Fix 6): the running SUM of every turn's
 * cost / tokens, so the composer can show real burn — the per-turn figures
 * above are last-turn-only and the context meter is occupancy, not spend. A
 * loop that resends context many times bills the provider repeatedly; only this
 * running total reflects that. Cost is provider-agnostic (uses whatever the
 * per-turn pricing path resolved; stays at the running total when a provider
 * exposes no cost, with tokens still accumulating).
 */
export const sessionCostUsdByChatIdAtom = atom<Record<number, number>>({});
export const sessionTokensByChatIdAtom = atom<Record<number, number>>({});

/**
 * Live per-turn token usage for the composer meter, driven by the provider's
 * REAL usage while a turn streams (Claude-Code-style live occupancy). Real
 * per-step emits set `input` (context tokens); throttled stream ticks only grow
 * `output`. Cleared when a new stream starts and reconciled/cleared at
 * response:end. `undefined` for a chat = no active live usage (meter falls back
 * to the dispatch estimate).
 */
export const liveTurnUsageByChatIdAtom = atom<
  Record<number, { input: number | null; output: number } | undefined>
>({});

/**
 * Per-tool token attribution for the CURRENT turn, so the context-meter
 * breakdown climbs live instead of freezing until the turn ends.
 *
 * Deliberately a sibling of `liveTurnUsageByChatIdAtom` rather than a field on
 * it: that atom carries delicate reconciliation (real checkpoints vs throttled
 * estimates, and a rising-edge collapse of input+output so the meter never dips
 * between turns). These are a plain running total that resets at turn start and
 * is superseded by the settled count at turn end — mixing the two would tangle
 * both. Values are cumulative for the turn, NOT deltas.
 */
export const liveTurnToolBucketsByChatIdAtom = atom<
  Record<
    number,
    { filesRead: number; searchResults: number; otherToolOutput: number } | undefined
  >
>({});

/** Autonomous mode: post-turn review payload from main (cleared on accept or dismiss). */
export const autonomousSessionReviewAtom = atom<AutonomousSessionCompletePayload | null>(null);


/** Latest live plan IPC payload per assistant message (cleared for that chat when a new stream starts). */
export const livePlanUpdateByAssistantMessageIdAtom = atom<Map<number, PlanUpdatePayload>>(new Map());

/** Frozen plan card per assistant message id after stream completes. */
export const planSnapshotByAssistantMessageIdAtom = atom<Record<number, PlanUpdatePayload>>({});

/** ask_user tool: pending interactive question for a chat (cleared after submit). */
export type PendingUserQuestion = {
  questionId: string;
  question: string;
  options?: string[];
  /** v10.1: ask_user can batch several questions; all must be answered before the stream resumes. */
  questions?: Array<{ question: string; options?: string[] }>;
};
export const pendingUserQuestionByChatIdAtom = atom<Record<number, PendingUserQuestion | undefined>>({});

/** v3.9: After edit or revert, show "conversation restarted from here" divider after this message id. Cleared on stream end. */
export const restartedAfterMessageIdAtom = atom<number | null>(null);

/** v3.5: Persistent "Working…" tool indicator. active when count > 0; toolName shows last started tool. */
export interface ToolIndicatorState {
  active: boolean;
  toolName: string | null;
  /** Registry tool id or MCP composite key — used for provider-agnostic strip labels. */
  toolId: string | null;
  /** Args of the last started tool — lets the status line name the subject ("Writing src/auth.ts…"). */
  toolArgs: Record<string, unknown> | null;
  count: number;
  /** Chat id for the active tool run; used to associate terminal-output with this indicator. */
  activeChatId: number | null;
  /** Live terminal output for the current tool run (ring buffer; last N lines). */
  liveOutputLines: string[];
  /** Error-first filtered view (ring buffer). */
  liveErrorLines: string[];
  /** Progress-ish view (ring buffer). */
  liveProgressLines: string[];
  /** Which view to show by default. */
  liveViewMode: "error_first" | "progress_first" | "raw_capped";
  /** Fix: Finding 4 — pre-tool "Thinking…" from main before first token */
  phaseLabel: string | null;
}

export function emptyToolIndicatorState(): ToolIndicatorState {
  return {
    active: false,
    toolName: null,
    toolId: null,
    toolArgs: null,
    count: 0,
    activeChatId: null,
    liveOutputLines: [],
    liveErrorLines: [],
    liveProgressLines: [],
    liveViewMode: "error_first",
    phaseLabel: null,
  };
}

export const toolIndicatorAtom = atom<ToolIndicatorState>(emptyToolIndicatorState());

/** Frozen thinking card per completed assistant message (DB strips think blocks). */
export const completedTurnThinkingByAssistantMessageIdAtom = atom<
  Record<number, CompletedTurnThinkingSnapshot>
>({});

/** Active assistant turn while streaming (for scoping inline tool cards). */
export const activeTurnScopeAtom = atom<{
  chatId: number;
  assistantMessageId: number;
  startedAt: number;
} | null>(null);

/** Frozen inline tool/thought timeline per completed assistant message. */
export const inlineTimelineByMessageIdAtom = atom<
  Record<number, InlineTimelineItem[]>
>({});

/**
 * Display-only ordered raw string per completed assistant message (text +
 * inline `<think>`/`<atlarix-tool-*>` tags in arrival order). The persisted
 * `content` is `<think>`-stripped; this keeps the frozen view interleaved
 * exactly like streaming. Absent for legacy messages (falls back to `content`).
 */
export const interleavedDisplayContentByMessageIdAtom = atom<
  Record<number, string>
>({});

/** Live per-event thread cards while a chat is streaming (cleared on stream end). */
export const streamThreadByChatIdAtom = atom<Map<number, StreamThreadItem[]>>(
  new Map(),
);

/** Frozen stream-thread cards per completed assistant message (chat-only / IPC tools). */
export const completedStreamThreadByAssistantMessageIdAtom = atom<
  Record<number, StreamThreadItem[]>
>({});

// ── Per-chat SCOPED selectors (perf) ─────────────────────────────────────────
// The maps above are replaced (immutably) on every ~50ms stream flush, so any
// component reading a whole map re-renders on ANY chat's change. These
// atomFamily + selectAtom views let a component subscribe to just ONE chat's
// slice: selectAtom re-renders the consumer only when that slice's reference
// changes (Object.is). Because the writers clone the Map but keep sibling array
// references stable, a stream in chat A no longer re-renders chat B's consumers
// (or completed message bodies that read a different slice). READ-ONLY views —
// keep writing through the whole-map atoms.
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_THREAD: StreamThreadItem[] = [];

export const messagesForChatAtom = atomFamily((chatId: number) =>
  selectAtom(chatMessagesByIdAtom, (m) => m.get(chatId) ?? EMPTY_MESSAGES),
);

export const isStreamingForChatAtom = atomFamily((chatId: number) =>
  selectAtom(isStreamingByIdAtom, (m) => m.get(chatId) ?? false),
);

export const streamThreadForChatAtom = atomFamily((chatId: number) =>
  selectAtom(streamThreadByChatIdAtom, (m) => m.get(chatId) ?? EMPTY_THREAD),
);

/** Web search sources scoped to an assistant message (inline citations + reload). */
export const sourcesByAssistantMessageIdAtom = atom<
  Record<number, SourceItem[]>
>({});

// ── Per-MESSAGE scoped selectors (perf) ──────────────────────────────────────
// AssistantMessageBody previously read these whole `Record<number, …>` maps, so
// EVERY mounted body re-rendered on ANY message's change (e.g. a tool event mid-
// stream re-rendered all ≤120 bodies). These selectAtom views subscribe a body
// to just its own message's slice: the writers use `{...prev, [id]: v}`, keeping
// sibling slice references stable, so a body re-renders only when ITS slice's
// reference changes. READ-ONLY — keep writing through the whole-map atoms.
const EMPTY_TIMELINE: InlineTimelineItem[] = [];
const EMPTY_SOURCES: SourceItem[] = [];
const EMPTY_ACTIVITY: ActivityStreamItem[] = [];

function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const completedStreamThreadForMessageAtom = atomFamily((messageId: number) =>
  selectAtom(
    completedStreamThreadByAssistantMessageIdAtom,
    (r) => r[messageId] ?? EMPTY_THREAD,
  ),
);

export const inlineTimelineForMessageAtom = atomFamily((messageId: number) =>
  selectAtom(inlineTimelineByMessageIdAtom, (r) => r[messageId] ?? EMPTY_TIMELINE),
);

export const completedTurnThinkingForMessageAtom = atomFamily((messageId: number) =>
  selectAtom(completedTurnThinkingByAssistantMessageIdAtom, (r) => r[messageId]),
);

export const interleavedDisplayContentForMessageAtom = atomFamily((messageId: number) =>
  selectAtom(interleavedDisplayContentByMessageIdAtom, (r) => r[messageId]),
);

export const sourcesForMessageAtom = atomFamily((messageId: number) =>
  selectAtom(sourcesByAssistantMessageIdAtom, (r) => r[messageId] ?? EMPTY_SOURCES),
);

/**
 * Activity-stream items filtered to one chat. The base array is replaced on
 * every activity event; the shallow-array comparator re-renders a consumer only
 * when THIS chat's items actually change (item refs are stable across replaces).
 */
export const activityStreamItemsForChatAtom = atomFamily((chatId: number) =>
  selectAtom(
    activityStreamItemsAtom,
    (items) => {
      const scoped = items.filter((it) => it.chatId === chatId);
      return scoped.length ? scoped : EMPTY_ACTIVITY;
    },
    shallowArrayEqual,
  ),
);

/** Last chunk time per chat — feeds the "still working" elapsed note. */
export const streamLastActivityAtByChatIdAtom = atom<Map<number, number>>(new Map());

/** True only while the backend is actively retrying a dropped/stalled round
 * (genuine reconnect) — drives the honest "Reconnecting…" indicator. Set on
 * `chat:stream:reset-partial`, cleared on the next chunk/pulse and turn end. */
export const reconnectingByChatIdAtom = atom<Map<number, boolean>>(new Map());

/**
 * Live partial tool-call arguments per chat — the file path + content building up
 * while the model streams an `edit_file` write/replace, BEFORE the tool-call
 * completes and the approval card opens. Drives the streaming preview so a long
 * write feels instant (like opencode). Cleared when the real tool card / approval
 * arrives or the stream ends.
 */
export interface LiveToolInput {
  toolName: string;
  path?: string;
  content?: string;
  operation?: string;
}
export const liveToolInputByChatIdAtom = atom<Map<number, LiveToolInput>>(new Map());

/**
 * v13 Phase 7: the agent is blocked on a still-running foreground command.
 * Set/cleared by useStreamChat from `chat:stream:phase` waiting_on_command /
 * command_done events. Drives the waiting chip + the send/stop button flip.
 */
export const waitingOnCommandByChatIdAtom = atom<
  Map<number, { commandId: string; command?: string; startedAt: number }>
>(new Map());

/**
 * v13 Phase 7: one queued user message per chat while the agent is waiting on
 * a command — flushed by useStreamChat when the stream ends.
 */
export const queuedMessageByChatIdAtom = atom<Map<number, string>>(new Map());

/**
 * A2/A3: the turn ENDED cleanly (isStreaming=false, send button shown) with
 * background work still outstanding — a fresh turn auto-resumes when an item
 * reports. Distinct from `waitingOnCommandByChatIdAtom` (which means the turn is
 * still LIVE/held open). Set by useStreamChat on a `parked` chat:response:end;
 * cleared when a new turn dispatches or the user dismisses the chip. Drives the
 * calm "waiting … will resume automatically" chip near the composer.
 */
export const parkedWaitingByChatIdAtom = atom<
  Map<number, { commands: number; subagents: number; parkedAt: number }>
>(new Map());

/**
 * v13.1: assistant message id → the shadow-git snapshot turn id captured for
 * that turn (when its writes were snapshotted). Drives the "revert this turn's
 * file changes" affordance. Session-lifetime only — snapshotTurnId is not
 * persisted and renderer ids re-assign on reload, so the action only appears
 * for turns completed in the current app session.
 */
export const turnSnapshotTurnIdByMessageIdAtom = atom<Map<number, string>>(
  new Map(),
);

/** v3.5: Show the "done" phase of the Atlarix animation until this timestamp (for the given chatId). */
export const responseDoneAnimationAtom = atom<{ chatId: number; until: number } | null>(null);

/** v3.5: Summarization in progress (show strip above input, left). */
export const summarizationProgressAtom = atom<{
  active: boolean;
  chatId: number | null;
  label?: string;
}>({
  active: false,
  chatId: null,
  label: undefined,
});

