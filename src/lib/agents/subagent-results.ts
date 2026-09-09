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

/** Status a sub-agent can transition through (mirrors background-commands). */
export type SubagentNotifyStatus = "running" | "finished" | "stalled";

/**
 * main-process notifier (set by the IPC host) → renderer indicator + auto-wake.
 * Mirrors `setBackgroundJobNotifier` in background-commands.ts so a finished
 * sub-agent drives the SAME auto-wake path as a finished background command.
 */
let notifier:
  | ((
      chatId: number,
      ev: { taskId: string; status: SubagentNotifyStatus; running: number },
    ) => void)
  | null = null;

export function setSubagentNotifier(
  fn: (
    chatId: number,
    ev: { taskId: string; status: SubagentNotifyStatus; running: number },
  ) => void,
): void {
  notifier = fn;
}

function notify(
  chatId: number,
  taskId: string,
  status: SubagentNotifyStatus,
): void {
  notifier?.(chatId, { taskId, status, running: runningSubagentCount(chatId) });
}

/**
 * A background sub-agent has produced no activity for a long time.
 *
 * This rides the SAME channel a finished sub-agent uses, and the renderer's
 * wake closure already treats "stalled" as a wake reason — so a genuinely stuck
 * sub-agent re-engages the main agent instead of silently holding the turn
 * open. It is only a nudge: the task keeps running, and its 10-minute timeout
 * is still the hard backstop.
 */
export function notifySubagentStalled(chatId: number, taskId: string): void {
  notify(chatId, taskId, "stalled");
}

export function recordSubagentStart(chatId: number, taskId: string): void {
  const set = runningByChat.get(chatId) ?? new Set<string>();
  set.add(taskId);
  runningByChat.set(chatId, set);
  notify(chatId, taskId, "running");
}

export function recordSubagentResult(
  chatId: number,
  taskId: string,
  result: {
    description: string;
    state: "completed" | "error";
    body: string;
    durationMs: number;
  },
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
  if (list.length > MAX_QUEUED_PER_CHAT) {
    console.warn(
      `[subagent-results] chat ${chatId}: >${MAX_QUEUED_PER_CHAT} undrained results — dropping ${list.length - MAX_QUEUED_PER_CHAT} oldest (never delivered to the model)`,
    );
  }
  resultsByChat.set(chatId, list.slice(-MAX_QUEUED_PER_CHAT));
  // "finished" covers both completed AND error — either is a result to deliver,
  // and either may auto-wake a parked turn (the error rides inside the body).
  notify(chatId, taskId, "finished");
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
  // Imperative framing (not a descriptive header): a finished sub-agent is a
  // real event the model MUST act on. Weak/open-weight models otherwise read a
  // bare result block as ambient and close the turn — so spell out the required
  // action rather than relying on the model to infer it.
  return [
    `[Background sub-agent results]`,
    blocks.join("\n\n"),
    `Incorporate these result(s) and continue the user's task now. If a sub-agent failed, decide how to recover — only end your turn once you have acted on every result above. If they COMPLETE the user's request, report the outcome and end your turn — never re-run work that already finished.`,
  ].join("\n\n");
}

export function clearSubagentsForChat(chatId: number): void {
  resultsByChat.delete(chatId);
  runningByChat.delete(chatId);
}
