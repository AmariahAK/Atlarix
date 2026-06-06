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

export const isStreamingByIdAtom = atom<Map<number, boolean>>(new Map());
export const chatInputValueAtom = atom<string>("");


// Used for scrolling to the bottom of the chat messages (per chat)
export const chatStreamCountByIdAtom = atom<Map<number, number>>(new Map());
export const recentStreamChatIdsAtom = atom<Set<number>>(new Set<number>());

export const attachmentsAtom = atom<FileAttachment[]>([]);

/** One-shot: next send uses Auto thinking tier when configured (`forceThinkingTier` in stream). */
export const forceDeepThinkNextAtom = atom(false);

/** Per-chat: whether the last completed turn had tool runs or a permission request. Used to show "No actions this turn" when false in agent mode. */
export const lastTurnHadToolCallsByChatIdAtom = atom<Record<number, boolean>>({});

/** Per-chat: last reported reasoning / thinking token count from stream end (thinking-tier turns). */
export const lastReasoningTokensByChatIdAtom = atom<Record<number, number>>({});

/** v10: per-chat auxiliary LLM tokens (sub-agents, compaction) from the last completed turn. */
export const lastAuxTokensByChatIdAtom = atom<Record<number, number>>({});

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

/** Fix: Finding 4 — last chunk time for slow-stream warning (Build) */
export const streamLastActivityAtByChatIdAtom = atom<Map<number, number>>(new Map());
export const streamSlowWarningByChatIdAtom = atom<Map<number, boolean>>(new Map());

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

