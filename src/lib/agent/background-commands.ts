/**
 * v13 Phase 7A + v14 — background command jobs.
 *
 * `run_command({ background: true })` returns to the model immediately; the
 * command keeps running in the interceptor. When it exits, the result lands
 * here and is delivered back to the model:
 *  - mid-turn via the engine's prepareStep injection (the same seam the
 *    repetition corrections use), or
 *  - on the NEXT turn as a context section — including a turn AUTO-STARTED by
 *    the renderer when a job finishes while the chat is idle (v14 auto-wake).
 *
 * v14 also lets the model (and the user via the UI) LIST running jobs, read
 * their new OUTPUT, and CANCEL them — backed by an in-memory per-chat registry
 * with the running ChildProcess handles. In-memory only (lost on app restart).
 */

import type { ChildProcess } from "node:child_process";

export type BackgroundJobStatus = "running" | "finished" | "cancelled";

export type BackgroundCommandResult = {
  command: string;
  exitCode: number;
  /** Tail of combined stdout/stderr (capped). */
  output: string;
  durationMs: number;
  finishedAt: number;
  /** True when the job was cancelled (don't auto-wake the agent on these). */
  cancelled?: boolean;
};

/** A still-running background command. */
interface RunningJob {
  operationId: string;
  command: string;
  startedAt: number;
  proc: ChildProcess | null;
  /** Latest accumulated combined output. */
  output: string;
  /** Chars already returned by `output` reads (incremental cursor). */
  readCursor: number;
}

/** Public shape for the model's `background_jobs(list)` + the UI indicator. */
export interface BackgroundJobInfo {
  operationId: string;
  command: string;
  startedAt: number;
  elapsedMs: number;
}

const OUTPUT_TAIL_CAP = 8_000;
const MAX_QUEUED_PER_CHAT = 10;

const resultsByChat = new Map<number, BackgroundCommandResult[]>();
const runningJobsByChat = new Map<number, Map<string, RunningJob>>();
/** Operations the agent/user asked to cancel — the natural exit records them as cancelled. */
const cancelledOps = new Set<string>();

/** main-process notifier (set by the IPC host) → renderer indicator + auto-wake. */
let notifier:
  | ((
      chatId: number,
      ev: { operationId: string; status: BackgroundJobStatus; running: number },
    ) => void)
  | null = null;

export function setBackgroundJobNotifier(
  fn: (
    chatId: number,
    ev: { operationId: string; status: BackgroundJobStatus; running: number },
  ) => void,
): void {
  notifier = fn;
}

function runningCount(chatId: number): number {
  return runningJobsByChat.get(chatId)?.size ?? 0;
}

function notify(
  chatId: number,
  operationId: string,
  status: BackgroundJobStatus,
): void {
  notifier?.(chatId, { operationId, status, running: runningCount(chatId) });
}

export function recordBackgroundCommandStart(
  chatId: number,
  operationId: string,
  command: string,
  startedAt: number,
): void {
  const jobs = runningJobsByChat.get(chatId) ?? new Map<string, RunningJob>();
  jobs.set(operationId, {
    operationId,
    command,
    startedAt,
    proc: null,
    output: "",
    readCursor: 0,
  });
  runningJobsByChat.set(chatId, jobs);
  notify(chatId, operationId, "running");
}

/** Attach the spawned process handle so the job can be cancelled. */
export function registerBackgroundProc(
  chatId: number,
  operationId: string,
  proc: ChildProcess,
): void {
  const job = runningJobsByChat.get(chatId)?.get(operationId);
  if (job) job.proc = proc;
}

/** Update a running job's latest accumulated output (for `output` reads). */
export function updateBackgroundOutput(
  chatId: number,
  operationId: string,
  output: string,
): void {
  const job = runningJobsByChat.get(chatId)?.get(operationId);
  if (job) job.output = output;
}

export function recordBackgroundCommandResult(
  chatId: number,
  operationId: string,
  result: Omit<BackgroundCommandResult, "finishedAt">,
): void {
  runningJobsByChat.get(chatId)?.delete(operationId);
  const wasCancelled = cancelledOps.delete(operationId);
  const list = resultsByChat.get(chatId) ?? [];
  list.push({
    ...result,
    cancelled: wasCancelled,
    output:
      result.output.length > OUTPUT_TAIL_CAP
        ? `…${result.output.slice(-OUTPUT_TAIL_CAP)}`
        : result.output,
    finishedAt: Date.now(),
  });
  resultsByChat.set(chatId, list.slice(-MAX_QUEUED_PER_CHAT));
  // "cancelled" must NOT auto-wake the agent; "finished" (success or failure) may.
  notify(chatId, operationId, wasCancelled ? "cancelled" : "finished");
}

export function hasRunningBackgroundCommands(chatId: number): boolean {
  return runningCount(chatId) > 0;
}

/** Running jobs for `background_jobs(list)` and the UI indicator. */
export function listBackgroundJobs(chatId: number): BackgroundJobInfo[] {
  const now = Date.now();
  return [...(runningJobsByChat.get(chatId)?.values() ?? [])].map((j) => ({
    operationId: j.operationId,
    command: j.command,
    startedAt: j.startedAt,
    elapsedMs: now - j.startedAt,
  }));
}

/** New output since the last read for a running job (incremental). */
export function readBackgroundOutput(
  chatId: number,
  operationId: string,
): { found: boolean; newOutput: string; running: boolean } {
  const job = runningJobsByChat.get(chatId)?.get(operationId);
  if (!job) return { found: false, newOutput: "", running: false };
  const newOutput = job.output.slice(job.readCursor);
  job.readCursor = job.output.length;
  return { found: true, newOutput, running: true };
}

/**
 * Cancel a running background job: SIGTERM the process and mark it cancelled so
 * its natural exit is recorded (once) as a cancelled result. Returns false if
 * no such running job.
 */
export function killBackgroundJob(chatId: number, operationId: string): boolean {
  const job = runningJobsByChat.get(chatId)?.get(operationId);
  if (!job) return false;
  cancelledOps.add(operationId);
  try {
    job.proc?.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  return true;
}

/**
 * Take-once drain of finished background command results, formatted as a
 * model-facing block. Returns null when nothing is pending.
 */
export function takePendingBackgroundCommandResults(
  chatId: number,
): string | null {
  const list = resultsByChat.get(chatId);
  if (!list?.length) return null;
  resultsByChat.delete(chatId);
  const blocks = list.map((r) => {
    const status = r.cancelled
      ? "was cancelled"
      : r.exitCode === 0
        ? "succeeded"
        : `failed (exit ${r.exitCode})`;
    return [
      `Background command ${status} after ${(r.durationMs / 1000).toFixed(1)}s:`,
      `$ ${r.command}`,
      r.output ? "```\n" + r.output + "\n```" : "(no output)",
    ].join("\n");
  });
  return `[Background command results]\n\n${blocks.join("\n\n")}`;
}

/**
 * Non-destructive check for undrained background results. Used by the renderer
 * at turn-end to close the auto-wake race: if a job finished just as the turn
 * was ending (so no further prepareStep drained it), wake a fresh turn to
 * deliver it instead of letting it sit until the next user message.
 */
export function hasPendingBackgroundCommandResults(chatId: number): boolean {
  return (resultsByChat.get(chatId)?.length ?? 0) > 0;
}

export function clearBackgroundCommandsForChat(chatId: number): void {
  resultsByChat.delete(chatId);
  runningJobsByChat.delete(chatId);
}

/** Kill every running background process — call on app quit to avoid orphans. */
export function killAllBackgroundJobs(): void {
  for (const jobs of runningJobsByChat.values()) {
    for (const job of jobs.values()) {
      try {
        job.proc?.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  runningJobsByChat.clear();
}
