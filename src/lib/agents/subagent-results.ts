/**
 * Background sub-agent results (mirrors background-commands.ts).
 *
 * `task({ background: true })` returns to the model immediately; the sub-agent
 * keeps running. When it finishes, the result lands here and is delivered back
 * to the model the same way background commands are:
 *  - mid-turn via the engine's prepareStep injection (results fold in as each
 *    sub-agent finishes, even one at a time), or
 *  - on the NEXT turn as a context section if the turn already ended.
 * No polling required — the model spawns sub-agents, keeps doing its own work,
 * and is fed each result automatically when it arrives.
 */

export type SubagentResult = {
  /** Short label the model gave the task. */
  description: string;
  /** Terminal state. */
  state: "completed" | "error";
  /** Result summary (or error text), capped. */
  body: string;
  taskId: string;
  durationMs: number;
  finishedAt: number;
};

const BODY_TAIL_CAP = 12_000;
const MAX_QUEUED_PER_CHAT = 10;

const resultsByChat = new Map<number, SubagentResult[]>();
/** Sub-agents still running per chat (for "is anything pending" checks). */
const runningByChat = new Map<number, Set<string>>();

export function recordSubagentStart(chatId: number, taskId: string): void {
  const set = runningByChat.get(chatId) ?? new Set<string>();
  set.add(taskId);
  runningByChat.set(chatId, set);
}

export function recordSubagentResult(
  chatId: number,
  taskId: string,
  result: { description: string; state: "completed" | "error"; body: string; durationMs: number },
): void {
  runningByChat.get(chatId)?.delete(taskId);
  const list = resultsByChat.get(chatId) ?? [];
  list.push({
    ...result,
    taskId,
    body:
      result.body.length > BODY_TAIL_CAP
        ? `…${result.body.slice(-BODY_TAIL_CAP)}`
        : result.body,
    finishedAt: Date.now(),
  });
  resultsByChat.set(chatId, list.slice(-MAX_QUEUED_PER_CHAT));
}

/** True when one or more background sub-agents are still running for this chat. */
export function hasRunningSubagents(chatId: number): boolean {
  return (runningByChat.get(chatId)?.size ?? 0) > 0;
}

export function runningSubagentCount(chatId: number): number {
  return runningByChat.get(chatId)?.size ?? 0;
}

/** Peek (without draining) whether finished results are queued for this chat. */
export function hasPendingSubagentResults(chatId: number): boolean {
  return (resultsByChat.get(chatId)?.length ?? 0) > 0;
}

/**
 * Take-once drain of finished sub-agent results, formatted as a model-facing
 * block. Returns null when nothing is pending.
 */
export function takePendingSubagentResults(chatId: number): string | null {
  const list = resultsByChat.get(chatId);
  if (!list?.length) return null;
  resultsByChat.delete(chatId);
  const blocks = list.map((r) => {
    const status = r.state === "completed" ? "completed" : "failed";
    const tag = r.state === "completed" ? "task_result" : "task_error";
    return [
      `Background sub-agent ${status} after ${(r.durationMs / 1000).toFixed(1)}s — ${r.description}:`,
      `<${tag} task_id="${r.taskId}">`,
      r.body || "(no output)",
      `</${tag}>`,
    ].join("\n");
  });
  return `[Background sub-agent results]\n\n${blocks.join("\n\n")}`;
}

export function clearSubagentsForChat(chatId: number): void {
  resultsByChat.delete(chatId);
  runningByChat.delete(chatId);
}
