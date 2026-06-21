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
    "Finished jobs are delivered to you automatically — use this only to peek at or stop STILL-RUNNING jobs.",
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["list", "output", "cancel"],
        description: "What to do: list running jobs, read a job's new output, or cancel a job.",
      },
      job_id: {
        type: "string",
        description: "The background job id (returned by run_command background:true) — required for \"output\" and \"cancel\".",
      },
    },
    required: ["operation"],
  },
  handler: async (args: WithChat<{ operation?: string; job_id?: string }>) => {
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
        return {
          success: false,
          error: `No running job "${jobId}" — it may have finished (its result is delivered to you automatically).`,
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

    return {
      success: false,
      error: `Unknown operation "${String(operation)}". Use "list", "output", or "cancel".`,
    };
  },
});
