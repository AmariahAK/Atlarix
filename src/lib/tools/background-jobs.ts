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
} from "@/lib/agent/background-commands";

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
    "Finished jobs are delivered to you automatically — use this only to peek at, watch, or stop STILL-RUNNING jobs; never poll on a loop.",
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["list", "output", "cancel", "watch"],
        description: "What to do: list running jobs, read a job's new output, cancel a job, or watch a job for an output condition.",
      },
      job_id: {
        type: "string",
        description: "The background job id (returned by run_command background:true) — required for \"output\", \"cancel\", and \"watch\".",
      },
      wake_on: {
        type: "string",
        description: "For operation:\"watch\" — wake you when the job's output contains this text.",
      },
      wake_on_regex: {
        type: "boolean",
        description: "Treat wake_on as a case-insensitive regex instead of a substring.",
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

    return {
      success: false,
      error: `Unknown operation "${String(operation)}". Use "list", "output", "cancel", or "watch".`,
    };
  },
});
