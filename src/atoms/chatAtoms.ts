import type {
  AutonomousSessionCompletePayload,
  FileAttachment,
  Message,
  PlanUpdatePayload,
} from "@/ipc/ipc_types";
import { atom } from "jotai";
import type { ChatSummary } from "@/lib/schemas";
import type { ActivityStreamItem, AgentBusExchange } from "@/atoms/sourceAtoms";
import type { CompletedTurnThinkingSnapshot } from "@/lib/thinking/extract-thinking-from-content";
import type { CounselTrigger } from "@/lib/counsel/counsel-session";

// Per-chat atoms implemented with maps keyed by chatId
export const chatMessagesByIdAtom = atom<Map<number, Message[]>>(new Map());
export const chatErrorByIdAtom = atom<Map<number, string | null>>(new Map());

/**
 * FIX 4: per-chat stream-disconnect state. Set when the backend emits
 * `chat:stream:disconnected` after silent retries fail; cleared on the next
 * `chat:response:chunk` (manual reconnect succeeded) or when the user starts
 * typing a new message.
 */
export interface StreamReconnectState {
  partialResponse: string;
  reason: "network" | "timeout" | "provider_error";
}
export const streamReconnectByChatIdAtom = atom<
  Map<number, StreamReconnectState>
>(new Map());

// Atom to hold the currently selected chat ID
export const selectedChatIdAtom = atom<number | null>(null);

// Active chat ID for seamless inline chat (persists across navigation)
// Only reset when "New Chat" is clicked or app restarts
export const activeChatIdAtom = atom<number | null>(null);

export const isStreamingByIdAtom = atom<Map<number, boolean>>(new Map());
export const chatInputValueAtom = atom<string>("");
export const homeChatInputValueAtom = atom<string>("");

// Atoms for chat list management
export const chatsAtom = atom<ChatSummary[]>([]);
export const chatsLoadingAtom = atom<boolean>(false);

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

/** Autonomous mode: post-turn review payload from main (cleared on accept or dismiss). */
export const autonomousSessionReviewAtom = atom<AutonomousSessionCompletePayload | null>(null);

/** Counsel session activity rows pinned to an assistant message (survives activity stream clear). */
export const counselPreviewByMessageIdAtom = atom<Record<number, ActivityStreamItem[]>>({});

/** Latest live plan IPC payload per assistant message (cleared for that chat when a new stream starts). */
export const livePlanUpdateByAssistantMessageIdAtom = atom<Map<number, PlanUpdatePayload>>(new Map());

/** Frozen plan card per assistant message id after stream completes. */
export const planSnapshotByAssistantMessageIdAtom = atom<Record<number, PlanUpdatePayload>>({});

/** ask_user tool: pending interactive question for a chat (cleared after submit). */
export type PendingUserQuestion = {
  questionId: string;
  question: string;
  options?: string[];
};
export const pendingUserQuestionByChatIdAtom = atom<Record<number, PendingUserQuestion | undefined>>({});

/** While ask_user is pending, renderer freezes assistant content at this snapshot (by chatId) to suppress speculative streaming. */
export const askUserStreamFreezeBaselineByChatIdAtom = atom<Record<number, string>>({});

/** v3.9: After edit or revert, show "conversation restarted from here" divider after this message id. Cleared on stream end. */
export const restartedAfterMessageIdAtom = atom<number | null>(null);

/** v3.5: Persistent "Working…" tool indicator. active when count > 0; toolName shows last started tool. */
export interface ToolIndicatorState {
  active: boolean;
  toolName: string | null;
  /** Registry tool id or MCP composite key — used for provider-agnostic strip labels. */
  toolId: string | null;
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
  /** counsel_start / counsel_end from main (ToolIndicator strip). */
  counselPhaseActive: boolean;
}

export function emptyToolIndicatorState(): ToolIndicatorState {
  return {
    active: false,
    toolName: null,
    toolId: null,
    count: 0,
    activeChatId: null,
    liveOutputLines: [],
    liveErrorLines: [],
    liveProgressLines: [],
    liveViewMode: "error_first",
    phaseLabel: null,
    counselPhaseActive: false,
  };
}

export const toolIndicatorAtom = atom<ToolIndicatorState>(emptyToolIndicatorState());

/** Frozen counsel + agent-bus cards for a completed assistant turn (collapsed by default in ChatMessage). */
export type CompletedTurnCounselSnapshot = {
  trigger: CounselTrigger | string;
  participantPreviews: { role: string; preview?: string }[];
  synthesisSnippet: string;
};

export type CompletedTurnArtifacts = {
  counsel: CompletedTurnCounselSnapshot | null;
  agentBus: AgentBusExchange[];
};

export const completedTurnArtifactsByAssistantMessageIdAtom = atom<
  Record<number, CompletedTurnArtifacts>
>({});

/** Frozen thinking card per completed assistant message (DB strips think blocks). */
export const completedTurnThinkingByAssistantMessageIdAtom = atom<
  Record<number, CompletedTurnThinkingSnapshot>
>({});

/** Fix: Finding 4 — last chunk time for slow-stream warning (Build) */
export const streamLastActivityAtByChatIdAtom = atom<Map<number, number>>(new Map());
export const streamSlowWarningByChatIdAtom = atom<Map<number, boolean>>(new Map());

/** v3.5: Show the "done" phase of the Atlarix animation until this timestamp (for the given chatId). */
export const responseDoneAnimationAtom = atom<{ chatId: number; until: number } | null>(null);

/** v3.5: Summarization in progress (show strip above input, left). */
export const summarizationProgressAtom = atom<{ active: boolean; chatId: number | null }>({
  active: false,
  chatId: null,
});

// PASS6: Blueprint per-chat injection override — restored.
export type BlueprintInjectionChatOverride = "ask" | "plan" | "build" | "debug";
export const blueprintInjectionChatOverrideAtom = atom<BlueprintInjectionChatOverride | null>(
  null,
);
