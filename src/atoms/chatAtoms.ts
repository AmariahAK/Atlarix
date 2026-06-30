import type {
  AutonomousSessionCompletePayload,
  FileAttachment,
  Message,
  PlanUpdatePayload,
} from "@/ipc/ipc_types";
import { atom } from "jotai";
import type { CompletedTurnThinkingSnapshot } from "@/lib/thinking/extract-thinking-from-content";
import type { InlineTimelineItem } from "@/lib/chat/inline-timeline";
import type { SourceItem } from "@/atoms/sourceAtoms";
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

export const isStreamingByIdAtom = atom<Map<number, boolean>>(new Map());
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

/** Web search sources scoped to an assistant message (inline citations + reload). */
export const sourcesByAssistantMessageIdAtom = atom<
  Record<number, SourceItem[]>
>({});

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

