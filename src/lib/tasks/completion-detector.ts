import type { TaskLedger, TaskStep } from "./task-ledger";

/**
 * Agentic loop completion: explicit model tag only (no inferred prose).
 * Distinct from the ledger `isTaskComplete` below — this is the
 * `<task_complete>` text marker the loop honors in build mode.
 */
export function responseHasTaskCompleteTag(response: string): boolean {
  return response.includes("<task_complete>");
}

/**
 * `task_complete` TOOL completion (native FC) — the preferred signal, replacing
 * the XML tag. Set by `runToolExecute` (which owns the turnId) when the model
 * calls the tool; read by the agentic loop in `run-agent-turn.ts` exactly like
 * the tag. Per-turn flag + optional summary; cleared when the completion gate
 * blocks (so the model must re-signal once it has fixed/verified the work) and
 * at end of turn.
 */
const taskCompleteToolByTurn = new Map<string, string | null>();

export function markTaskCompleteToolCalled(
  turnId: string,
  summary?: string | null,
): void {
  taskCompleteToolByTurn.set(turnId, summary ?? null);
}

export function wasTaskCompleteToolCalled(turnId: string | undefined): boolean {
  return turnId != null && taskCompleteToolByTurn.has(turnId);
}

export function takeTaskCompleteToolSummary(
  turnId: string | undefined,
): string | null {
  return turnId != null ? (taskCompleteToolByTurn.get(turnId) ?? null) : null;
}

export function clearTaskCompleteToolCalled(turnId: string | undefined): void {
  if (turnId != null) taskCompleteToolByTurn.delete(turnId);
}

export function isTaskComplete(ledger: TaskLedger): boolean {
  if (!ledger.steps.length) return false;
  return ledger.steps.every(
    (s) => s.status === "done" || s.status === "failed",
  );
}

export function getRemainingSteps(ledger: TaskLedger): TaskStep[] {
  return ledger.steps.filter(
    (s) => s.status === "pending" || s.status === "in_progress",
  );
}

export function buildPendingStepsContinuationPrompt(steps: TaskStep[]): string {
  const lines = steps.map((s) => `- ${s.description}`).join("\n");
  return `The following steps are still pending:\n${lines}\n\nContinue and complete them in order.`;
}
