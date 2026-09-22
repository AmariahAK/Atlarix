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
import {
  hasActiveScheduledWakeup,
  cancelJobWakeups,
  getJobWakeupRemainingMs,
} from "@/lib/agent/scheduled-wakeups";
import { killShellProcess } from "@/ipc/utils/runShellCommand";

export type BackgroundJobStatus =
  | "running"
  | "finished"
  | "cancelled"
  /** A4: still running but no output for OUTPUT_IDLE_THRESHOLD_MS — advisory. */
  | "stalled"
  /** v14.8.10: a still-running job's output matched its `wake_on` condition. */
  | "condition_met";

/** v14.8.10: an opt-in wake condition tested against a running job's output. */
export interface WakeCondition {
  /** Substring (default) or regex source to look for in the job's output. */
  pattern: string;
  /** When true, `pattern` is treated as a regex (bounded, case-insensitive). */
  regex?: boolean;
}

export type BackgroundCommandResult = {
  /** The op this result belongs to — lets `background_jobs(output)` peek a
   *  finished-but-undrained result instead of lying "delivered automatically". */
  operationId: string;
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
  /**
   * A BOUNDED TAIL of everything this job has printed.
   *
   * It used to be the full, unbounded transcript for the life of the job — a
   * six-hour dev server held its entire log in main, and `wakeConditionMatches`
   * ran a user-supplied regex over all of it once a minute. `OUTPUT_TAIL_CAP`
   * was only ever applied when the value was READ, never to what was retained.
   */
  output: string;
  /**
   * Output printed since the last incremental read, kept separately.
   *
   * This replaced a `readCursor` byte index into `output`. That index was only
   * sound while `output` grew monotonically — the moment it is tail-capped (as
   * it now is) the cursor points into text dropped from the front, and
   * `slice(readCursor)` returns garbage or nothing. Holding the unread text
   * itself removes the coupling entirely.
   */
  unread: string;
  /** A4: last time output changed — drives the output-idle hang watchdog. */
  lastOutputAt: number;
  /** v14.8.10: opt-in wake condition; fires once when the output matches. */
  wakeOn?: WakeCondition;
  /**
   * The wake pattern has been SEEN in the output, but the advisory has not been
   * queued yet (that happens on the next watchdog scan).
   *
   * Needed because `output` is now a bounded tail. The scan runs once a minute
   * and used to re-match against the job's entire transcript, so a pattern
   * printed at any point was still there to find. Against a tail, a busy job can
   * print the matching line and scroll it away inside one scan interval — the
   * wake would simply never fire. Checking on every update closes that window
   * without changing WHEN the advisory is delivered.
   */
  wakeSeen?: boolean;
  /** v14.8.10: set once the wake condition has fired (so it fires only once). */
  wakeMatched?: boolean;
  /**
   * Opt-out: this background job is EXPECTED to be quiet (dev server / watcher /
   * long service) — the harness never fires the stall advisory for it. Does NOT
   * change anything else: it still runs, its exit result is still delivered, and
   * `wake_on` still fires. Set at start (run_command allow_stalled) or mid-run
   * (background_jobs allow_stalled), on a new OR existing job.
   */
  allowStalled?: boolean;
}

/**
 * A4: an advisory about a still-running job. `kind:"stall"` = gone quiet
 * (possibly hung); `kind:"match"` = its `wake_on` condition matched (v14.8.10).
 */
export interface StalledAdvisory {
  operationId: string;
  command: string;
  idleMs: number;
  /** Tail of output captured so far (so the model can judge / decide). */
  outputTail: string;
  kind?: "stall" | "match";
  /** For `kind:"match"`: the pattern that matched. */
  matchedPattern?: string;
}

/** Public shape for the model's `background_jobs(list)` + the UI indicator. */
export interface BackgroundJobInfo {
  operationId: string;
  command: string;
  startedAt: number;
  elapsedMs: number;
  /** v14.8.10: the idle-stall watchdog flagged this job as gone quiet. */
  stalled?: boolean;
  /** v14.8.10: this job's `wake_on` condition has matched. */
  wakeMatched?: boolean;
  /** Live "time left" (ms) on a job-tied wake timer, if one is set (Part 2). */
  wakeInMs?: number;
}

const OUTPUT_TAIL_CAP = 8_000;

/**
 * How much unread output is held for a job the model has not checked on.
 *
 * Larger than the display tail because this is what the model actually reads
 * back, and dropping the middle of a build failure is worse than holding a bit
 * more. Still bounded: an incremental read that nobody ever performs must not
 * turn into an unbounded queue, which is the failure `output` itself had.
 */
const UNREAD_CAP = 64_000;

/**
 * Keep the last `cap` characters, marking that the head was dropped.
 *
 * The leading ellipsis is not decoration — without it a reader cannot tell a
 * truncated tail from a command that simply started there.
 */
function capTail(s: string, cap = OUTPUT_TAIL_CAP): string {
  return s.length > cap ? `…${s.slice(-cap)}` : s;
}
const MAX_QUEUED_PER_CHAT = 10;
/**
 * A4: a running job that emits NO output for this long is flagged as STALLED —
 * an advisory wake so the model can decide (keep waiting / read / cancel). It is
 * NEVER auto-killed. Global, single threshold (output-flow = liveness, mirroring
 * the LLM stream's idle watchdog). Slow-but-progressing jobs reset the clock via
 * updateBackgroundOutput, so a chatty slow job never trips it.
 */
// 3 min: advisory-only (never kills). A quiet job is USUALLY still working
// (first-run Gradle builds / cold Docker pulls / CI installs go silent for
// minutes while downloading), so the notice fires ONCE, points at the opt-out,
// and never implies "stuck". 3 min was previously too eager only because the
// agent's response was destructive (it woke and cancelled a healthy build);
// `allow_stalled` gives it a non-destructive response, so informing sooner is
// safe — the model just sets allow_stalled on a quiet-by-design job (dev server
// / watcher / long service) and is never pinged about it again.
const OUTPUT_IDLE_THRESHOLD_MS = 180_000;
/** How often the watchdog scans running jobs (cadence, not the threshold). */
const STALL_CHECK_INTERVAL_MS = 60_000;

const resultsByChat = new Map<number, BackgroundCommandResult[]>();
const runningJobsByChat = new Map<number, Map<string, RunningJob>>();
/** Operations the agent/user asked to cancel — the natural exit records them as cancelled. */
const cancelledOps = new Set<string>();
/** A4: ops already advised this stall episode (re-armed when output resumes). */
const stalledNotified = new Set<string>();
/** A4: undrained stall advisories per chat (drained like results). */
const advisoriesByChat = new Map<number, StalledAdvisory[]>();
/** A4: the single global watchdog interval (lazy; cleared when no jobs remain). */
let stallWatchdog: ReturnType<typeof setInterval> | null = null;

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

/** A4: total running jobs across all chats — gates the watchdog lifecycle. */
function totalRunningJobs(): number {
  let n = 0;
  for (const jobs of runningJobsByChat.values()) n += jobs.size;
  return n;
}

/**
 * A4: scan every running job; a job that has produced no output for
 * OUTPUT_IDLE_THRESHOLD_MS is flagged STALLED exactly once per quiet episode
 * (re-armed when output resumes — see updateBackgroundOutput). Advisory only:
 * the process is NEVER killed. Queues an advisory + fires a "stalled" notify so
 * an idle (parked) chat auto-wakes and the model can decide.
 */
function scanForStalledJobs(): void {
  const now = Date.now();
  for (const [chatId, jobs] of runningJobsByChat) {
    // The model's schedule_wakeup is the single wait authority: while an
    // outstanding self-wake covers this chat, the model deliberately chose to
    // wait, so the idle-stall backstop is snoozed — otherwise the "gone quiet,
    // may be stuck" advisory fires every ~3 min and auto-wakes a turn, yanking
    // the model out of its own wait. wake_on matches + finished results are
    // unaffected; only the idle-stall ping is suppressed.
    const wakeupActive = hasActiveScheduledWakeup(chatId);
    for (const job of jobs.values()) {
      // `job.output` is already a bounded tail (capped at write time), so this
      // is a no-op guard rather than the truncation it used to perform.
      const tail = capTail(job.output);

      // v14.8.10: wake_on condition — fire once when the output matches. This is
      // ADDITIVE to the idle-stall backstop below (a job with a wake_on still
      // gets the 3-min "gone quiet" ping if the condition never matches).
      if (
        job.wakeOn &&
        !job.wakeMatched &&
        (job.wakeSeen || wakeConditionMatches(job.wakeOn, job.output))
      ) {
        job.wakeMatched = true;
        const list = advisoriesByChat.get(chatId) ?? [];
        list.push({
          operationId: job.operationId,
          command: job.command,
          idleMs: now - job.lastOutputAt,
          outputTail: tail,
          kind: "match",
          matchedPattern: job.wakeOn.pattern,
        });
        advisoriesByChat.set(chatId, list.slice(-MAX_QUEUED_PER_CHAT));
        notify(chatId, job.operationId, "condition_met");
      }

      // Opted out: this background job is allowed to be quiet (dev server /
      // watcher / long service). Never fire the stall advisory for it — wake_on
      // (above) and the finish result are unaffected; only the nag is muted.
      if (job.allowStalled) continue;

      // Snooze the idle-stall backstop while the model is deliberately waiting.
      if (wakeupActive) continue;
      const idleMs = now - job.lastOutputAt;
      if (idleMs < OUTPUT_IDLE_THRESHOLD_MS) continue;
      if (stalledNotified.has(job.operationId)) continue;
      stalledNotified.add(job.operationId);
      const list = advisoriesByChat.get(chatId) ?? [];
      list.push({
        operationId: job.operationId,
        command: job.command,
        idleMs,
        outputTail: tail,
        kind: "stall",
      });
      advisoriesByChat.set(chatId, list.slice(-MAX_QUEUED_PER_CHAT));
      notify(chatId, job.operationId, "stalled");
    }
  }
}

function ensureStallWatchdog(): void {
  if (stallWatchdog != null) return;
  stallWatchdog = setInterval(scanForStalledJobs, STALL_CHECK_INTERVAL_MS);
  // Don't keep the process alive just for the watchdog (Node only).
  (stallWatchdog as { unref?: () => void }).unref?.();
}

function stopStallWatchdogIfIdle(): void {
  if (stallWatchdog != null && totalRunningJobs() === 0) {
    clearInterval(stallWatchdog);
    stallWatchdog = null;
  }
}

export function recordBackgroundCommandStart(
  chatId: number,
  operationId: string,
  command: string,
  startedAt: number,
  wakeOn?: WakeCondition,
  allowStalled?: boolean,
): void {
  const jobs = runningJobsByChat.get(chatId) ?? new Map<string, RunningJob>();
  jobs.set(operationId, {
    operationId,
    command,
    startedAt,
    proc: null,
    output: "",
    unread: "",
    lastOutputAt: startedAt,
    ...(wakeOn ? { wakeOn } : {}),
    ...(allowStalled ? { allowStalled: true } : {}),
  });
  runningJobsByChat.set(chatId, jobs);
  ensureStallWatchdog();
  notify(chatId, operationId, "running");
}

/**
 * v14.8.10: attach (or replace) a wake condition on an already-running job so the
 * agent is woken when its output matches — without relaunching. Returns false if
 * no such running job.
 */
export function setWakeCondition(
  chatId: number,
  operationId: string,
  wakeOn: WakeCondition,
): boolean {
  const job = runningJobsByChat.get(chatId)?.get(operationId);
  if (!job) return false;
  job.wakeOn = wakeOn;
  job.wakeMatched = false;
  return true;
}

/**
 * Allow an already-running background job to go quiet without the harness pinging
 * about it (the mid-run opt-out; run_command sets it at start). Clears any pending
 * stall flag for the job. Returns false if no such running job. Only the stall nag
 * is muted — the job still runs, still delivers its exit result, and `wake_on`
 * still fires.
 */
export function setAllowStalled(
  chatId: number,
  operationId: string,
  value = true,
): boolean {
  const job = runningJobsByChat.get(chatId)?.get(operationId);
  if (!job) return false;
  job.allowStalled = value;
  if (value) stalledNotified.delete(operationId);
  return true;
}

/** Test a wake condition against accumulated output (substring or bounded regex). */
function wakeConditionMatches(cond: WakeCondition, output: string): boolean {
  if (!cond.pattern) return false;
  if (cond.regex) {
    try {
      // Case-insensitive; matched against the (capped) output tail, so no
      // catastrophic-backtracking exposure on unbounded input.
      return new RegExp(cond.pattern, "i").test(output);
    } catch {
      // Invalid regex → fall back to substring so a bad pattern never throws.
      return output.includes(cond.pattern);
    }
  }
  return output.toLowerCase().includes(cond.pattern.toLowerCase());
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
/**
 * Record new output for a running job.
 *
 * TAKES A DELTA. It used to take the accumulated buffer and derive the delta
 * itself — `output.slice(job.output.length)` after an O(N) string equality — on
 * every chunk, which is O(n²) over a command and the reason the caller had to
 * keep a full cumulative copy at all.
 *
 * `deltaIn` is optional: absent, the old derivation runs, so a caller that still
 * passes the accumulated buffer keeps working. The promotion handoff in
 * `interceptor.ts` deliberately still does.
 */
export function updateBackgroundOutput(
  chatId: number,
  operationId: string,
  output: string,
  deltaIn?: string,
): void {
  const job = runningJobsByChat.get(chatId)?.get(operationId);
  if (!job) return;
  if (deltaIn == null && output === job.output) return;
  if (deltaIn != null && !deltaIn) return;
  // A4: any output change is LIVENESS — reset the idle clock so an actively
  // updating job (incl. a `\r`-redrawn progress bar, which never emits a new
  // line) is never mis-flagged as stuck.
  //
  // But only a MEANINGFUL change RE-ARMS the advisory. Once we've advised on a
  // quiet episode, a lone trivial byte (a spinner tick, a stray `\r`) must not
  // clear `stalledNotified` and let the 3-min ping re-fire on the next quiet
  // gap. Re-arm only when the delta carries a genuine new line — real progress
  // worth re-advising if the job then goes quiet again.
  const delta =
    deltaIn ??
    (output.length > job.output.length
      ? output.slice(job.output.length)
      : output);
  const meaningfulChange = delta.includes("\n");
  // Append + tail-cap rather than replace-with-everything. The unread buffer is
  // capped too — a job nobody reads must not become an unbounded queue.
  job.output = capTail(deltaIn == null ? output : job.output + delta);
  job.unread = capTail(job.unread + delta, UNREAD_CAP);
  job.lastOutputAt = Date.now();
  if (
    job.wakeOn &&
    !job.wakeMatched &&
    !job.wakeSeen &&
    wakeConditionMatches(job.wakeOn, job.output)
  ) {
    job.wakeSeen = true;
  }
  if (meaningfulChange) {
    stalledNotified.delete(operationId);
  }
}

export function recordBackgroundCommandResult(
  chatId: number,
  operationId: string,
  result: Omit<BackgroundCommandResult, "finishedAt" | "operationId">,
): void {
  runningJobsByChat.get(chatId)?.delete(operationId);
  stalledNotified.delete(operationId);
  // No orphan timers: a finished job drops any wake timer tied to it (Part 2).
  cancelJobWakeups(chatId, operationId);
  stopStallWatchdogIfIdle();
  const wasCancelled = cancelledOps.delete(operationId);
  const list = resultsByChat.get(chatId) ?? [];
  list.push({
    ...result,
    operationId,
    cancelled: wasCancelled,
    output:
      result.output.length > OUTPUT_TAIL_CAP
        ? `…${result.output.slice(-OUTPUT_TAIL_CAP)}`
        : result.output,
    finishedAt: Date.now(),
  });
  if (list.length > MAX_QUEUED_PER_CHAT) {
    console.warn(
      `[background-commands] chat ${chatId}: >${MAX_QUEUED_PER_CHAT} undrained results — dropping ${list.length - MAX_QUEUED_PER_CHAT} oldest (never delivered to the model)`,
    );
  }
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
    // Surface live status flags so the UI can badge without a separate pull.
    stalled: stalledNotified.has(j.operationId),
    wakeMatched: !!j.wakeMatched,
    wakeInMs: getJobWakeupRemainingMs(chatId, j.operationId) ?? undefined,
  }));
}

/**
 * C3: full current output for a running job (NON-destructive — does not advance
 * the incremental cursor). Powers the UI detail view + the "send to chat" chip.
 * Returns null if the job isn't running.
 */
export function getBackgroundJobOutput(
  chatId: number,
  operationId: string,
): { command: string; output: string; elapsedMs: number } | null {
  const job = runningJobsByChat.get(chatId)?.get(operationId);
  if (!job) return null;
  return {
    command: job.command,
    // Already capped at write time; kept for callers that hand in a raw string.
    output: capTail(job.output),
    elapsedMs: Date.now() - job.startedAt,
  };
}

/** New output since the last read for a running job (incremental). */
export function readBackgroundOutput(
  chatId: number,
  operationId: string,
): { found: boolean; newOutput: string; running: boolean } {
  const job = runningJobsByChat.get(chatId)?.get(operationId);
  if (!job) return { found: false, newOutput: "", running: false };
  const newOutput = job.unread;
  job.unread = "";
  return { found: true, newOutput, running: true };
}

/**
 * Trailing output for a running job WITHOUT advancing the incremental cursor.
 *
 * The incremental read answers "what changed since I last looked", which is the
 * right default because it can't re-feed the model text it has already read.
 * But after several checks it can no longer answer "what does this look like
 * NOW" — a dev server's current state is in the last few lines, not in the
 * delta. Leaving the cursor alone means a `tail` never costs the caller a
 * subsequent incremental read.
 */
export function readBackgroundOutputTail(
  chatId: number,
  operationId: string,
  maxChars = 8000,
): { found: boolean; tail: string; running: boolean } {
  const job = runningJobsByChat.get(chatId)?.get(operationId);
  if (!job) return { found: false, tail: "", running: false };
  return {
    found: true,
    tail: job.output.slice(-Math.max(1, maxChars)),
    running: true,
  };
}

/**
 * Cancel a running background job: SIGTERM the process and mark it cancelled so
 * its natural exit is recorded (once) as a cancelled result. Returns false if
 * no such running job.
 */
export function killBackgroundJob(
  chatId: number,
  operationId: string,
): boolean {
  const job = runningJobsByChat.get(chatId)?.get(operationId);
  if (!job) return false;
  cancelledOps.add(operationId);
  // Via killShellProcess, not proc.kill: the child is the SHELL, and a background
  // job is precisely the long-lived kind (dev server, watcher, test runner) whose
  // real process is a grandchild that outlives it.
  killShellProcess(job.proc);
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
  // Imperative framing: a finished background command is a real event to act
  // on, not ambient info. The closing directive keeps weak/open-weight models
  // from reading the block and ending the turn without handling the result —
  // but it must NOT read as "keep working" once the task is done (observed:
  // a model re-ran already-finished background tasks on the completion wake).
  return [
    `[Background command results]`,
    blocks.join("\n\n"),
    `Act on these results now and continue the user's task. If these results COMPLETE the user's request, report the outcome and end your turn — never restart or re-run work that already finished.`,
  ].join("\n\n");
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

/**
 * NON-destructive peek of a specific finished job's result. Powers the honest
 * `background_jobs(output)` reply: once a job leaves the running registry its
 * result sits (undrained) in `resultsByChat` until a consumer delivers it, so
 * the tool can show the real output/status instead of claiming it was already
 * "delivered automatically" (which it may not have been). Returns null if no
 * finished result for that op is currently queued (already drained, or unknown).
 */
export function getFinishedBackgroundResult(
  chatId: number,
  operationId: string,
): BackgroundCommandResult | null {
  const list = resultsByChat.get(chatId);
  if (!list?.length) return null;
  // Last match wins (most recent) in the unlikely event of a reused op id.
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.operationId === operationId) return list[i] ?? null;
  }
  return null;
}

/**
 * A4: take-once drain of stall advisories, formatted as a model-facing block.
 * These are for STILL-RUNNING jobs (distinct from finished results) — the model
 * is asked to decide, not handed a terminal result. Returns null when none.
 */
export function takePendingStalledAdvisories(chatId: number): string | null {
  const list = advisoriesByChat.get(chatId);
  if (!list?.length) return null;
  advisoriesByChat.delete(chatId);
  const blocks = list.map((a) =>
    a.kind === "match"
      ? [
          `Background job ${a.operationId} matched your wake condition ${JSON.stringify(a.matchedPattern)} and is STILL RUNNING:`,
          `$ ${a.command}`,
          a.outputTail ? "```\n" + a.outputTail + "\n```" : "(no output yet)",
          `Act on it now: read more with background_jobs({operation:"output", job_id:"${a.operationId}"}), or stop it with background_jobs({operation:"cancel", job_id:"${a.operationId}"}).`,
        ].join("\n")
      : [
          `Background job ${a.operationId} has produced no output for ${Math.round(a.idleMs / 1000)}s but is STILL RUNNING. For builds, installs, downloads, dependency fetches, and long test suites this is NORMAL — a quiet job is usually working, not stuck (a first Gradle build or an npm/pip install can be silent for minutes while it downloads).`,
          `$ ${a.command}`,
          a.outputTail ? "```\n" + a.outputTail + "\n```" : "(no output yet)",
          `Check its logs above. If this job is quiet BY DESIGN (a dev server, file watcher, or long-running service that only prints on activity), call background_jobs({operation:"allow_stalled", job_id:"${a.operationId}"}) — you'll stop being pinged about it going quiet (it keeps running and you still get its exit result). Otherwise prefer to KEEP WAITING: schedule_wakeup to re-check it later so you don't hold the turn open. Only cancel (background_jobs {operation:"cancel", job_id:"${a.operationId}"}) if the USER asked you to stop it, or you have concrete evidence it is genuinely hung (e.g. a deadlock/error in the output). Do NOT cancel just because it is quiet, and do NOT report work as done that this job has not finished.`,
        ].join("\n"),
  );
  return [
    `[Background job advisory]`,
    blocks.join("\n\n"),
    `Handle each job above before ending your turn — act on a matched condition; for a quiet-but-running job, set allow_stalled if it's quiet by design, else prefer waiting (schedule_wakeup) over cancelling.`,
  ].join("\n\n");
}

/** A4: non-destructive check for undrained stall advisories (turn-end wake). */
export function hasPendingStalledAdvisories(chatId: number): boolean {
  return (advisoriesByChat.get(chatId)?.length ?? 0) > 0;
}

export function clearBackgroundCommandsForChat(chatId: number): void {
  resultsByChat.delete(chatId);
  advisoriesByChat.delete(chatId);
  for (const opId of runningJobsByChat.get(chatId)?.keys() ?? [])
    stalledNotified.delete(opId);
  runningJobsByChat.delete(chatId);
  stopStallWatchdogIfIdle();
}

/** Kill every running background process — call on app quit to avoid orphans. */
export function killAllBackgroundJobs(): void {
  for (const jobs of runningJobsByChat.values()) {
    for (const job of jobs.values()) {
      killShellProcess(job.proc);
    }
  }
  runningJobsByChat.clear();
  stalledNotified.clear();
  if (stallWatchdog != null) {
    clearInterval(stallWatchdog);
    stallWatchdog = null;
  }
}

// ── Foreground (blocking) run_command processes ──────────────────────────────
// A foreground command holds the turn open ("Waiting on command"). Until it is
// promoted to the background it is NOT a background job, so a user cancel could
// not reach it — the model stream aborted but the child kept running. We track
// the live foreground child here so the cancel/abort handlers can terminate it.
// Cross-platform termination goes through `killShellProcess`, which signals the
// whole process GROUP (POSIX) or walks the tree with `taskkill /T` (Windows) —
// the child we hold is the shell, not the command the user is waiting on.
const foregroundProcsByChat = new Map<number, Map<string, ChildProcess>>();

export function registerForegroundProc(
  chatId: number,
  operationId: string,
  proc: ChildProcess,
): void {
  let m = foregroundProcsByChat.get(chatId);
  if (!m) {
    m = new Map();
    foregroundProcsByChat.set(chatId, m);
  }
  m.set(operationId, proc);
}

export function clearForegroundProc(chatId: number, operationId: string): void {
  const m = foregroundProcsByChat.get(chatId);
  if (!m) return;
  m.delete(operationId);
  if (m.size === 0) foregroundProcsByChat.delete(chatId);
}

/**
 * Terminate every live foreground command for a chat — called when the user
 * cancels/aborts the turn so a blocking `run_command` actually stops. Returns
 * the number of processes signalled.
 */
export function killForegroundCommandsForChat(chatId: number): number {
  const m = foregroundProcsByChat.get(chatId);
  if (!m) return 0;
  let killed = 0;
  for (const proc of m.values()) {
    killShellProcess(proc);
    killed++;
  }
  foregroundProcsByChat.delete(chatId);
  return killed;
}
