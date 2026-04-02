import type { FileAttachment, Message } from "@/ipc/ipc_types";
import { atom } from "jotai";
import type { ChatSummary } from "@/lib/schemas";

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
export const homeChatInputValueAtom = atom<string>("");

// Atoms for chat list management
export const chatsAtom = atom<ChatSummary[]>([]);
export const chatsLoadingAtom = atom<boolean>(false);

// Used for scrolling to the bottom of the chat messages (per chat)
export const chatStreamCountByIdAtom = atom<Map<number, number>>(new Map());
export const recentStreamChatIdsAtom = atom<Set<number>>(new Set<number>());

export const attachmentsAtom = atom<FileAttachment[]>([]);

/** Per-chat: whether the last completed turn had tool runs or a permission request. Used to show "No actions this turn" when false in agent mode. */
export const lastTurnHadToolCallsByChatIdAtom = atom<Record<number, boolean>>({});

/** v3.9: Pending clarifying questions per assistant message (messageId -> questions). Cleared when user submits answers. */
export const questionsByMessageIdAtom = atom<Record<number, import("@/ipc/ipc_types").Question[]>>({});

/** ask_user tool: pending interactive question for a chat (cleared after submit). */
export type PendingUserQuestion = {
  questionId: string;
  question: string;
  options?: string[];
};
export const pendingUserQuestionByChatIdAtom = atom<Record<number, PendingUserQuestion | undefined>>({});

/** v3.9: After edit or revert, show "conversation restarted from here" divider after this message id. Cleared on stream end. */
export const restartedAfterMessageIdAtom = atom<number | null>(null);

/** v3.5: Persistent "Working…" tool indicator. active when count > 0; toolName shows last started tool. */
export interface ToolIndicatorState {
  active: boolean;
  toolName: string | null;
  count: number;
  /** Chat id for the active tool run; used to associate terminal-output with this indicator. */
  activeChatId: number | null;
  /** Live terminal output for the current tool run (e.g. run_command). */
  liveOutput: string;
  /** Fix: Finding 4 — pre-tool "Thinking…" from main before first token */
  phaseLabel: string | null;
}
export const toolIndicatorAtom = atom<ToolIndicatorState>({
  active: false,
  toolName: null,
  count: 0,
  activeChatId: null,
  liveOutput: "",
  phaseLabel: null,
});

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

/** v5.0 S4: Per-session chat override for Blueprint system-prompt tier; null = follow Settings only. */
export type BlueprintInjectionChatOverride = "ask" | "plan" | "build" | "debug";
export const blueprintInjectionChatOverrideAtom = atom<BlueprintInjectionChatOverride | null>(
  null,
);
