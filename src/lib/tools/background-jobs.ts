/**
 * background_jobs (v14) — inspect & control commands started with
 * run_command({ background: true }).
 *
 *   list   — running background jobs + commands with retained output
 *   output — new-since-last-check (default) or a tail; running OR finished
 *   cancel — stop a running job_id (SIGTERM)
 *
 * Finished jobs are delivered to the model automatically (mid-turn via
 * prepareStep, or on an auto-started turn when the chat is idle) — so `output`
 * is for peeking at a still-running job, or re-reading one whose result has
 * already been delivered; never for waiting on completion.
 *
 * v14.20: absorbed the short-lived `terminal_list` / `terminal_read` tools.
 * They answered the same question this one does, and three tools competing to
 * report on the agent's own work is worse than one that reports on all of it.
 */

import { ToolRegistry } from "./registry";
import {
  listBackgroundJobs,
  readBackgroundOutput,
  readBackgroundOutputTail,
  killBackgroundJob,
  getFinishedBackgroundResult,
  setWakeCondition,
  setAllowStalled,
} from "@/lib/agent/background-commands";
import { setJobWakeup, adjustJobWakeup } from "@/lib/agent/scheduled-wakeups";
import {
  findAgentBuffer,
  listRetainedAgentCommands,
  readTerminalInstance,
  resolveScopeKey,
} from "@/lib/terminal-instance-store";

type WithChat<T> = T & { _chatSessionId?: number };

/** Last `n` lines of a blob — the tail is where a running process's state is. */
function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.length <= n ? text : lines.slice(-n).join("\n");
}

/**
 * Resolve what the model called the job into a running job id.
 *
 * Accepts an exact id, or a distinctive substring of the
 * command. Ids are generated strings the model has to carry accurately across
 * turns, and one wrong character doesn't degrade — it fails and burns a step. A
 * name it chose itself is far harder to get wrong.
 *
 * Ambiguity is reported rather than guessed: silently picking one of two
 * matching jobs would read the wrong process's output, which is worse than
 * asking.
 */
function resolveRunningJobId(
  chatId: number,
  wanted: string,
): { id: string } | { error: string } | null {
  const jobs = listBackgroundJobs(chatId);
  const needle = wanted.toLowerCase();
  const exact = jobs.find((j) => j.operationId === wanted);
  if (exact) return { id: exact.operationId };
  const byCommand = jobs.filter((j) => j.command.toLowerCase().includes(needle));
  if (byCommand.length === 1) return { id: byCommand[0]!.operationId };
  if (byCommand.length > 1) {
    return {
      error:
        `"${wanted}" matches ${byCommand.length} running jobs: ` +
        `${JSON.stringify(byCommand.map((j) => ({ job_id: j.operationId, command: j.command })))}. ` +
        "Use the job_id of the one you mean.",
    };
  }
  return null;
}

ToolRegistry.register({
  name: "background_jobs",
  requiresWorkspace: false,
  isCore: false,
  // `cancel` mutates a process, but the surface is safe to offer broadly (the
  // job was already started by the agent); the mode allowlist still gates it.
  isReadOnly: false,
  allowInAskMode: true,
  description:
    "Inspect and control background commands you started with run_command(background:true). " +
    "Identify a job with `job`: its id, or a distinctive part of its command — whichever you have. " +
    "operation:\"list\" — running jobs (job_id, command, elapsed). " +
    "operation:\"output\" — by default the NEW output since your last check (incremental). Pass mode:\"tail\" for the most recent output instead, which is what you want to see a still-running server's CURRENT state; tail never consumes your incremental position. Works on finished jobs too. " +
    "operation:\"cancel\" — stop `job_id`. " +
    "operation:\"watch\" — attach a wake condition to a running `job_id`: pass `wake_on` and you'll be woken when its output contains that text (prefer this over polling). " +
    "operation:\"allow_stalled\" — mark a running `job_id` as expected-to-be-quiet (a dev server / watcher / long service): stop the harness pinging you when it goes silent. It still runs and you still get its exit result. " +
    "operation:\"wake_in\" — set/replace a live countdown timer on a running `job_id`: pass `seconds` and you'll be re-engaged then to re-check THAT job (only ONE timer per job — setting again replaces it, so timers never pile up). Prefer wake_on when the event is observable in output; use this for a timed re-check. " +
    "operation:\"adjust_timer\" — add/subtract time on a job's existing countdown: pass `delta_seconds` (negative = sooner). " +
    "\"list\" shows `wake_in_s` (the live seconds left) for any job that has a timer; a finished job drops its countdown, and won't ask you to re-check it even if the countdown had already elapsed. " +
    "Finished jobs are delivered to you automatically — use this only to peek at, watch, allow_stalled, time, or stop STILL-RUNNING jobs; never poll on a loop.",
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["list", "output", "cancel", "watch", "allow_stalled", "wake_in", "adjust_timer"],
        description: "What to do: list running jobs, read a job's new output, cancel a job, watch a job for an output condition, allow_stalled a job (stop being pinged about it going quiet), wake_in (set a countdown timer to re-check the job), or adjust_timer (change the job's countdown).",
      },
      job: {
        type: "string",
        description: "Which job to act on: a job id, or a distinctive substring of its command (e.g. \"npm run dev\"). Preferred over job_id — the command you ran is easier to get right than a generated id.",
      },
      job_id: {
        type: "string",
        description: "The background job id (returned by run_command background:true). Equivalent to `job`; kept for compatibility.",
      },
      mode: {
        type: "string",
        enum: ["new", "tail"],
        description: "For operation:\"output\" — \"new\" (default) returns only what appeared since your last check; \"tail\" returns the most recent output regardless, which is how you see a running process's current state. \"tail\" does not consume your incremental position.",
      },
      max_lines: {
        type: "number",
        description: "For mode:\"tail\" — how many trailing lines to return (default 200, max 2000).",
      },
      wake_on: {
        type: "string",
        description: "For operation:\"watch\" — wake you when the job's output contains this text.",
      },
      wake_on_regex: {
        type: "boolean",
        description: "Treat wake_on as a case-insensitive regex instead of a substring.",
      },
      seconds: {
        type: "number",
        description: "For operation:\"wake_in\" — how many seconds from now to re-engage you to re-check this job (clamped to 60–14400).",
      },
      delta_seconds: {
        type: "number",
        description: "For operation:\"adjust_timer\" — seconds to add (positive) or subtract (negative) from the job's existing countdown.",
      },
    },
    required: ["operation"],
  },
  handler: async (
    args: WithChat<{
      operation?: string;
      job?: string;
      job_id?: string;
      mode?: string;
      max_lines?: number;
      wake_on?: string;
      wake_on_regex?: boolean;
      seconds?: number;
      delta_seconds?: number;
    }>,
  ) => {
    const chatId = args._chatSessionId;
    if (chatId == null) {
      return { success: false, error: "No chat session for background jobs." };
    }
    const operation = args.operation;

    if (operation === "list") {
      const jobs = listBackgroundJobs(chatId);
      return {
        success: true,
        count: jobs.length,
        jobs: jobs.map((j) => ({
          job_id: j.operationId,
          command: j.command,
          elapsed_s: Math.round(j.elapsedMs / 1000),
          // Live countdown ("96s left") for jobs that have a wake timer.
          ...(j.wakeInMs != null ? { wake_in_s: Math.round(j.wakeInMs / 1000) } : {}),
        })),
        // Commands whose output is still retained — including ones that have
        // already FINISHED, which is how a job that exited before you looked is
        // still readable. Labelled by the command that produced it; the agent
        // no longer names these (run_command's `terminal` param was removed in
        // v14.27.0 along with the agent tabs in the UI).
        // The shared foreground buffer is excluded: its label is "Agent", not a
        // command, so listing it as one invites a `job:"Agent"` that means
        // nothing. `operation:"output"` falls back to it by id when no command
        // name matches, which is the only way it is usefully reachable.
        retained_output: listRetainedAgentCommands(resolveScopeKey(chatId, null)).map(
          (t) => ({ command: t.label, lines: t.lineCount }),
        ),
        note: jobs.length === 0 ? "No background jobs are running." : undefined,
      };
    }

    const wanted = String(args.job ?? args.job_id ?? "").trim();
    if (!wanted) {
      return { success: false, error: `operation:"${operation}" requires \`job\` (an id, or part of the command).` };
    }
    const resolved = resolveRunningJobId(chatId, wanted);
    if (resolved && "error" in resolved) {
      return { success: false, error: resolved.error };
    }
    // Unresolved is not yet an error: the job may have FINISHED, which the
    // output branch handles by reading its retained terminal tab.
    const jobId = resolved?.id ?? wanted;

    if (operation === "output") {
      const wantTail = String(args.mode ?? "new").toLowerCase() === "tail";
      const maxLines = Math.min(2000, Math.max(1, Number(args.max_lines) || 200));

      // Tail on a RUNNING job: most recent output, cursor untouched, so asking
      // "what does this look like now" never costs the next incremental read.
      if (wantTail) {
        const t = readBackgroundOutputTail(chatId, jobId);
        if (t.found) {
          return {
            success: true,
            job_id: jobId,
            running: true,
            mode: "tail",
            output: lastLines(t.tail, maxLines) || "(no output yet)",
          };
        }
      }

      const r = readBackgroundOutput(chatId, jobId);
      if (!r.found) {
        // Not running. Peek for a finished-but-undrained result so we tell the
        // truth (show the real output/status) instead of the old "delivered
        // automatically" claim — which could be false and made the model poll.
        const finished = getFinishedBackgroundResult(chatId, jobId);
        if (finished) {
          const status = finished.cancelled
            ? "was cancelled"
            : finished.exitCode === 0
              ? "succeeded"
              : `failed (exit ${finished.exitCode})`;
          return {
            success: true,
            job_id: jobId,
            running: false,
            finished: true,
            status,
            output: finished.output || "(no output)",
            note: "This job has finished. Its result will also be delivered to you automatically — no need to poll.",
          };
        }
        // Finished AND already delivered. The result is gone from the queue, but
        // the terminal tab kept a line-capped, disk-persisted buffer — so read
        // that rather than refusing. Refusing is what made a model conclude it
        // had missed the output and re-run work that had already succeeded.
        const scopeKey = resolveScopeKey(chatId, null);
        // Agent-owned buffers only, and the shared foreground one as a last
        // resort — see `findAgentBuffer`. Searching every instance meant a
        // substring match could return one of the USER's shells, and refusing
        // when the foreground buffer held the answer is what this file's
        // `finished` branch above exists to stop: a model that thinks it missed
        // the output re-runs work that already succeeded.
        const tab = findAgentBuffer(scopeKey, wanted);
        if (tab) {
          const read = readTerminalInstance(scopeKey, tab.id, maxLines);
          if (read.success) {
            return {
              success: true,
              job_id: jobId,
              running: false,
              finished: true,
              terminal: read.label,
              mode: "tail",
              output: read.text || "(no output)",
              note:
                tab.shared
                  ? `No command named "${wanted}" is retained separately; this is the recent output of foreground commands in this session. Act on it; do not re-run the work.`
                  : "This job has finished and its result was already delivered — this is its retained output. Act on it; do not re-run the work.",
            };
          }
        }
        // Only now is there genuinely nothing. Say it in the vocabulary `list`
        // uses — retained COMMANDS. "Open terminals" named a UI the agent no
        // longer has: agent tabs and `run_command`'s `terminal` param were both
        // removed in v14.27.0, so a terminal is not something it can address.
        const retained = listRetainedAgentCommands(scopeKey).map((t) => t.label);
        return {
          success: false,
          error:
            `No running job matching "${wanted}", and no retained output under that name. ` +
            (retained.length > 0
              ? `Retained commands: ${JSON.stringify(retained)}. `
              : "Nothing is retained for this session. ") +
            "If this job finished, its result was already delivered to you — act on that; do not re-run the work.",
        };
      }
      return {
        success: true,
        job_id: jobId,
        running: r.running,
        new_output: r.newOutput || "(no new output since last check)",
      };
    }

    if (operation === "cancel") {
      const ok = killBackgroundJob(chatId, jobId);
      return ok
        ? { success: true, cancelled: jobId, note: "Cancellation requested (SIGTERM); the result will confirm." }
        : { success: false, error: `No running job "${jobId}" to cancel.` };
    }

    if (operation === "watch") {
      const pattern = String(args.wake_on ?? "").trim();
      if (!pattern) {
        return { success: false, error: `operation:"watch" requires wake_on (text to match).` };
      }
      const ok = setWakeCondition(chatId, jobId, {
        pattern,
        regex: args.wake_on_regex === true,
      });
      return ok
        ? {
            success: true,
            job_id: jobId,
            watching: pattern,
            note: "You'll be woken when this job's output matches — keep doing other work; don't poll.",
          }
        : { success: false, error: `No running job "${jobId}" to watch.` };
    }

    if (operation === "allow_stalled") {
      const ok = setAllowStalled(chatId, jobId, true);
      return ok
        ? {
            success: true,
            job_id: jobId,
            allow_stalled: true,
            note: "Won't ping you about this job going quiet anymore — it keeps running and you still get its exit result (and any wake_on match). Continue other work.",
          }
        : { success: false, error: `No running job "${jobId}" to allow_stalled.` };
    }

    if (operation === "wake_in") {
      // Only time a job that's actually running (else the timer would orphan).
      const running = listBackgroundJobs(chatId).some((j) => j.operationId === jobId);
      if (!running) {
        return { success: false, error: `No running job "${jobId}" to time.` };
      }
      const seconds = Number(args.seconds);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return { success: false, error: `operation:"wake_in" requires seconds > 0.` };
      }
      const res = setJobWakeup(chatId, jobId, seconds * 1000, `re-check background job ${jobId}`);
      if ("error" in res) return { success: false, error: res.error };
      return {
        success: true,
        job_id: jobId,
        wake_in_s: Math.round(res.firesInMs / 1000),
        note: "Countdown set (only one per job — this replaced any prior timer). Keep doing other work; you'll be re-engaged to re-check this job when it fires. If the job finishes first you won't be asked to re-check it — the countdown is dropped either way.",
      };
    }

    if (operation === "adjust_timer") {
      const delta = Number(args.delta_seconds);
      if (!Number.isFinite(delta) || delta === 0) {
        return { success: false, error: `operation:"adjust_timer" requires a non-zero delta_seconds.` };
      }
      const res = adjustJobWakeup(chatId, jobId, delta * 1000);
      if (!res) {
        return { success: false, error: `No timer on job "${jobId}" to adjust — set one with operation:"wake_in" first.` };
      }
      return {
        success: true,
        job_id: jobId,
        wake_in_s: Math.round(res.firesInMs / 1000),
        note: "Countdown adjusted.",
      };
    }

    return {
      success: false,
      error: `Unknown operation "${String(operation)}". Use "list", "output", "cancel", "watch", "allow_stalled", "wake_in", or "adjust_timer".`,
    };
  },
});
