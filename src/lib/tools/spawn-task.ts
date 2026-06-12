/**
 * `task` — the ONE sub-agent tool (v13).
 *
 * Spawns a scoped read-only sub-agent (runSubagent). Issue MULTIPLE task calls
 * in one response for independent scopes — they run concurrently (up to 5 per
 * turn). `background: true` returns immediately with a task id to resume via
 * `task_id`. `subagent_type` may name a user-defined `.atlarix/agents/` agent.
 */

import { randomUUID } from "node:crypto";
import {
  ToolRegistry,
  ToolCategory,
  createParameters,
  stringParam,
  booleanParam,
} from "./registry";
import {
  runSubagent,
  type SubagentActivityEmit,
} from "../agents/run-subagent";
import {
  recordSubagentStart,
  recordSubagentResult,
} from "../agents/subagent-results";

/** Wall-clock cap for a background sub-agent so a hung one can't stall the turn. */
const DEFAULT_BACKGROUND_TIMEOUT_MS = 5 * 60_000;
function backgroundTimeoutMs(): number {
  const fromEnv = Number(process.env.ATLARIX_SUBAGENT_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0
    ? fromEnv
    : DEFAULT_BACKGROUND_TIMEOUT_MS;
}

type TaskRecord = {
  id: string;
  state: "running" | "completed" | "error";
  subagentType: string;
  prompt: string;
  resultText?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
};

const taskStore = new Map<string, TaskRecord>();

function taskEnvelope(
  taskId: string,
  state: TaskRecord["state"],
  inner: string,
): string {
  return [
    `<task id="${taskId}" state="${state}">`,
    inner,
    "</task>",
  ].join("\n");
}

ToolRegistry.register({
  name: "task",
  description:
    "Spawn a scoped read-only sub-agent for an independent piece of work (exploring a folder, researching a question, mapping a subsystem). " +
    "For independent scopes, issue MULTIPLE task calls in ONE response — they run concurrently (up to 5 per turn). " +
    "Optional subagent_type names a user-defined .atlarix/agents/ agent. " +
    "Set background=true to return immediately with a task id; pass task_id later to collect the result.",
  category: ToolCategory.TASK,
  cost: 3,
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      description: stringParam("Short (3-5 word) description of the task"),
      prompt: stringParam("Full task prompt for the sub-agent"),
      subagent_type: stringParam(
        "Optional: a user-defined agent name from .atlarix/agents/ (omit for the generic scout)",
      ),
      task_id: stringParam(
        "Resume a prior background task (same sub-agent session)",
      ),
      background: booleanParam(
        "When true, run async and return immediately with task id",
      ),
    },
    ["description", "prompt"],
  ),
  handler: async (args: {
    description: string;
    prompt: string;
    subagent_type?: string;
    task_id?: string;
    background?: boolean;
    workspace?: string;
    workspaceId?: number;
    chatId?: number;
    turnId?: string;
    delegationChatMode?: "build" | "plan" | "ask";
    /** Stream wrapper context (register-delegation-tools). */
    parentDelegationId?: string;
    emitSubagentActivity?: (payload: SubagentActivityEmit) => void;
  }) => {
    const resumeId = args.task_id?.trim();
    if (resumeId) {
      const existing = taskStore.get(resumeId);
      if (!existing) {
        return taskEnvelope(
          resumeId,
          "error",
          `<task_error>Unknown task_id: ${resumeId}</task_error>`,
        );
      }
      if (existing.state === "running") {
        return taskEnvelope(
          resumeId,
          "running",
          [
            "<summary>Background task still running</summary>",
            "<task_result>",
            "Task is still in progress. Continue other work or retry with the same task_id later.",
            "</task_result>",
          ].join("\n"),
        );
      }
      const tag = existing.state === "completed" ? "task_result" : "task_error";
      const body = existing.resultText ?? existing.error ?? "";
      return taskEnvelope(
        resumeId,
        existing.state,
        `<summary>${args.description}</summary><${tag}>${body}</${tag}>`,
      );
    }

    const taskId = randomUUID();
    const subagentType = args.subagent_type?.trim() || "";

    const run = async () => {
      const outcome = await runSubagent({
        prompt: args.prompt,
        subagentType: subagentType || undefined,
        workspace: args.workspace,
        workspaceId: args.workspaceId,
        chatId: args.chatId,
        turnId: args.turnId,
        delegationChatMode: args.delegationChatMode,
        delegationId: args.parentDelegationId ?? taskId,
        emit: args.emitSubagentActivity,
      });
      const rec = taskStore.get(taskId);
      if (!rec) return;
      if (outcome.success) {
        rec.state = "completed";
        rec.resultText = outcome.summary ?? "";
      } else {
        rec.state = "error";
        rec.error = outcome.error ?? "Sub-agent run failed";
      }
      rec.finishedAt = Date.now();
    };

    taskStore.set(taskId, {
      id: taskId,
      state: "running",
      subagentType,
      prompt: args.prompt,
      startedAt: Date.now(),
    });

    if (args.background) {
      const chatId = args.chatId;
      if (chatId != null) recordSubagentStart(chatId, taskId);

      // Record the result into the per-chat store exactly once (on completion,
      // failure, or timeout) so prepareStep can fold it into the turn as it
      // arrives — no polling needed.
      let settled = false;
      const finalize = (state: "completed" | "error", body: string) => {
        if (settled) return;
        settled = true;
        if (chatId == null) return;
        const rec = taskStore.get(taskId);
        const durationMs = Date.now() - (rec?.startedAt ?? Date.now());
        recordSubagentResult(chatId, taskId, {
          description: args.description,
          state,
          body,
          durationMs,
        });
      };

      const timeoutMs = backgroundTimeoutMs();
      const timeout = setTimeout(() => {
        const rec = taskStore.get(taskId);
        if (rec && rec.state === "running") {
          rec.state = "error";
          rec.error = `Sub-agent timed out after ${Math.round(timeoutMs / 1000)}s`;
          rec.finishedAt = Date.now();
        }
        finalize(
          "error",
          `Sub-agent timed out after ${Math.round(timeoutMs / 1000)}s and was abandoned. If still needed, spawn a narrower task.`,
        );
      }, timeoutMs);

      void run()
        .catch((err) => {
          const rec = taskStore.get(taskId);
          if (!rec) return;
          rec.state = "error";
          rec.error = err instanceof Error ? err.message : String(err);
          rec.finishedAt = Date.now();
        })
        .finally(() => {
          clearTimeout(timeout);
          const rec = taskStore.get(taskId);
          const state = rec?.state === "completed" ? "completed" : "error";
          finalize(state, rec?.resultText ?? rec?.error ?? "");
        });

      return taskEnvelope(
        taskId,
        "running",
        [
          "<summary>Background task started</summary>",
          "<task_result>",
          "Background sub-agent started. You'll receive its result automatically when it finishes — keep doing other work; no need to poll with task_id.",
          "</task_result>",
        ].join("\n"),
      );
    }

    await run();
    const done = taskStore.get(taskId)!;
    const tag = done.state === "completed" ? "task_result" : "task_error";
    const body = done.resultText ?? done.error ?? "";
    return taskEnvelope(
      taskId,
      done.state === "completed" ? "completed" : "error",
      `<summary>${args.description}</summary><${tag}>${body}</${tag}>`,
    );
  },
});
