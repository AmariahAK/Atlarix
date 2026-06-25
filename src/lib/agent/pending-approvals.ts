/**
 * Approval grace-then-park (Item 5). When a mutating tool needs user approval
 * and the user doesn't decide within a short grace window, the turn PARKS (clean
 * end) and AUTO-RESUMES when the user approves/rejects — mirroring background-
 * command parking (see background-commands.ts). This module holds the per-chat
 * pending-approval + resolved-result state shared by:
 *  - `pendingWorkBlocksEnd` in run-agent-turn.ts (the park trigger),
 *  - the renderer auto-wake (via the notifier) when an approval resolves,
 *  - the `prepareStep` injection that delivers the result on resume.
 * In-memory only (lost on app restart) — same as background commands.
 */

export type ApprovalOutcome = "approved" | "rejected";

export interface ResolvedApproval {
  operationId: string;
  outcome: ApprovalOutcome;
  /** Model-facing result text: the executed tool result, or a rejection notice. */
  resultText: string;
}

/** Ops awaiting a user decision (per chat). */
const pendingByChat = new Map<number, Set<string>>();
/** Decided approvals awaiting injection into the resumed turn (per chat). */
const resolvedByChat = new Map<number, ResolvedApproval[]>();

/** main-process notifier (set by the IPC host) → renderer auto-wake on resolve. */
let notifier: ((chatId: number) => void) | null = null;

export function setApprovalNotifier(fn: (chatId: number) => void): void {
  notifier = fn;
}

/** Register an approval the user hasn't decided within the grace window. */
export function addPendingApproval(chatId: number, operationId: string): void {
  const set = pendingByChat.get(chatId) ?? new Set<string>();
  set.add(operationId);
  pendingByChat.set(chatId, set);
}

/** Park trigger + turn-end wake race: are any approvals awaiting a decision? */
export function hasPendingApprovals(chatId: number): boolean {
  return (pendingByChat.get(chatId)?.size ?? 0) > 0;
}

/**
 * Resolve a pending approval (user decided). Removes it from pending and queues
 * the model-facing result for the resumed turn, then fires the notifier so an
 * idle (parked) chat auto-wakes. No-op if the op wasn't pending (e.g. it was
 * decided inside the grace window and handled inline).
 */
export function resolvePendingApproval(
  chatId: number,
  operationId: string,
  outcome: ApprovalOutcome,
  resultText: string,
): void {
  const set = pendingByChat.get(chatId);
  if (!set?.delete(operationId)) return;
  if (set.size === 0) pendingByChat.delete(chatId);
  const list = resolvedByChat.get(chatId) ?? [];
  list.push({ operationId, outcome, resultText });
  resolvedByChat.set(chatId, list);
  notifier?.(chatId);
}

/** Take-once drain of resolved approvals as a model-facing block (prepareStep). */
export function takePendingApprovalResults(chatId: number): string | null {
  const list = resolvedByChat.get(chatId);
  if (!list?.length) return null;
  resolvedByChat.delete(chatId);
  const blocks = list.map((r) =>
    r.outcome === "approved"
      ? `You approved the pending operation — its result:\n${r.resultText}`
      : `You rejected the pending operation. Do not retry it — continue without it, or ask the user how to proceed.`,
  );
  return `[Approval results]\n\n${blocks.join("\n\n")}`;
}

/** Turn-end wake race: are there resolved approvals not yet injected? */
export function hasPendingApprovalResults(chatId: number): boolean {
  return (resolvedByChat.get(chatId)?.length ?? 0) > 0;
}

export function clearPendingApprovalsForChat(chatId: number): void {
  pendingByChat.delete(chatId);
  resolvedByChat.delete(chatId);
}
