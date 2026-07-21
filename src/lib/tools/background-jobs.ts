/**
 * background_jobs (v14) — inspect & control commands started with
 * run_command({ background: true }).
 *
 *   list   — running background jobs (id, command, elapsed)
 *   output — NEW output since your last check for a job_id (incremental)
 *   cancel — stop a running job_id (SIGTERM)
 *
 * Finished jobs are delivered to the model automatically (mid-turn via
 * prepareStep, or on an auto-started turn when the chat is idle) — so `output`
 * is only for peeking at STILL-RUNNING jobs, not for waiting on completion.
 */

import { ToolRegistry } from "./registry";
import {
  listBackgroundJobs,
  readBackgroundOutput,
  killBackgroundJob,
  getFinishedBackgroundResult,
  setWakeCondition,
  setAllowStalled,
} from "@/lib/agent/background-commands";
import { setJobWakeup, adjustJobWakeup } from "@/lib/agent/scheduled-wakeups";

type WithChat<T> = T & { _chatSessionId?: number };

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
    "operation:\"list\" — running jobs (job_id, command, elapsed). " +
    "operation:\"output\" — NEW output since your last check for `job_id` (incremental; running jobs only). " +
    "operation:\"cancel\" — stop `job_id`. " +
    "operation:\"watch\" — attach a wake condition to a running `job_id`: pass `wake_on` and you'll be woken when its output contains that text (prefer this over polling). " +
    "operation:\"allow_stalled\" — mark a running `job_id` as expected-to-be-quiet (a dev server / watcher / long service): stop the harness pinging you when it goes silent. It still runs and you still get its exit result. " +
    "operation:\"wake_in\" — set/replace a live countdown timer on a running `job_id`: pass `seconds` and you'll be re-engaged then to re-check THAT job (only ONE timer per job — setting again replaces it, so timers never pile up). Prefer wake_on when the event is observable in output; use this for a timed re-check. " +
    "operation:\"adjust_timer\" — add/subtract time on a job's existing countdown: pass `delta_seconds` (negative = sooner). " +
    "\"list\" shows `wake_in_s` (the live seconds left) for any job that has a timer; a job's timer is auto-removed when it finishes. " +
    "Finished jobs are delivered to you automatically — use this only to peek at, watch, allow_stalled, time, or stop STILL-RUNNING jobs; never poll on a loop.",
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["list", "output", "cancel", "watch", "allow_stalled", "wake_in", "adjust_timer"],
        description: "What to do: list running jobs, read a job's new output, cancel a job, watch a job for an output condition, allow_stalled a job (stop being pinged about it going quiet), wake_in (set a countdown timer to re-check the job), or adjust_timer (change the job's countdown).",
      },
      job_id: {
        type: "string",
        description: "The background job id (returned by run_command background:true) — required for \"output\", \"cancel\", \"watch\", \"wake_in\", and \"adjust_timer\".",
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
      job_id?: string;
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
        note: jobs.length === 0 ? "No background jobs are running." : undefined,
      };
    }

    const jobId = String(args.job_id ?? "").trim();
    if (!jobId) {
      return { success: false, error: `operation:"${operation}" requires a job_id.` };
    }

    if (operation === "output") {
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
        // No queued result: it finished AND was already delivered (or the id is
        // unknown). Now the "delivered automatically" claim is actually true.
        return {
          success: false,
          error: `No running job "${jobId}" — it has finished and its result was already delivered to you. Do not poll; act on the result you received.`,
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
        note: "Countdown set (only one per job — this replaced any prior timer). Keep doing other work; you'll be re-engaged to re-check this job when it fires, and the timer auto-clears when the job finishes.",
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
