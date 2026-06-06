import type { TaskLedger, TaskStep } from "./task-ledger";

/**
 * Agentic loop completion: explicit model tag only (no inferred prose).
 * Distinct from the ledger `isTaskComplete` below — this is the
 * `<task_complete>` text marker the loop honors in build mode.
 */
export function responseHasTaskCompleteTag(response: string): boolean {
  return response.includes("<task_complete>");
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
