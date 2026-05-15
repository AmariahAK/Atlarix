/**
 * Sliding-window detection for inter-agent delegation (task_assign edges).
 * Structural only — does not read message payloads.
 */

/** Matches {@link AgentId} from agent-bus (avoid circular import). */
type BusAgentId =
  | "main"
  | "architect"
  | "builder"
  | "reviewer"
  | "research"
  | "researcher"
  | "explore"
  | "scout"
  | "debugger";

export const DELEGATION_EDGE_WINDOW_MS = 60_000;
/** Same from→to appears this many times in the window → inject corrective bus message once at exactly this count */
export const SAME_EDGE_WARNING_THRESHOLD = 3;
/** Same edge repeats at or beyond this count → abort flag */
export const SAME_EDGE_CRITICAL_THRESHOLD = 5;
/** Total task_assign events in window exceeds this → abort flag */
export const TOTAL_DELEGATION_CRITICAL_THRESHOLD = 20;

type EdgeEvt = { from: BusAgentId; to: BusAgentId; t: number };

const windows = new Map<number, EdgeEvt[]>();
const abortPending = new Map<number, boolean>();

export const DELEGATION_CORRECTION_BODY =
  "Delegation pattern: the same specialist is being reassigned repeatedly in a short window. Step back, consolidate the task, or change approach before delegating again.";

export function recordDelegationTaskAssign(params: {
  chatId: number;
  from: BusAgentId;
  to: BusAgentId;
  turnId?: string;
  timestamp?: number;
}): {
  correction?: { to: BusAgentId; turnId: string; chatId: number };
} {
  const t = params.timestamp ?? Date.now();
  let w = windows.get(params.chatId) ?? [];
  w.push({ from: params.from, to: params.to, t });
  const cutoff = t - DELEGATION_EDGE_WINDOW_MS;
  w = w.filter((e) => e.t >= cutoff);
  windows.set(params.chatId, w);

  const sameCount = w.filter((e) => e.from === params.from && e.to === params.to).length;
  const totalCount = w.length;

  let correction: { to: BusAgentId; turnId: string; chatId: number } | undefined;
  if (sameCount === SAME_EDGE_WARNING_THRESHOLD && params.turnId) {
    correction = { to: params.to, turnId: params.turnId, chatId: params.chatId };
  }

  if (
    sameCount >= SAME_EDGE_CRITICAL_THRESHOLD ||
    totalCount > TOTAL_DELEGATION_CRITICAL_THRESHOLD
  ) {
    abortPending.set(params.chatId, true);
  }

  return { correction };
}

/** One-shot: returns true once when delegation abort was requested for this chat */
export function consumeDelegationAbort(chatId: number): boolean {
  const b = abortPending.get(chatId);
  abortPending.delete(chatId);
  return b === true;
}
