/**
 * OpenCode-style background task tool (Phase 2).
 * Foreground: runs delegate_to_agent and returns <task> XML envelope.
 * Background: starts delegation, stores result by task_id for resume.
 */

import { randomUUID } from "node:crypto";
import {
  ToolRegistry,
  ToolCategory,
  createParameters,
  stringParam,
  booleanParam,
} from "./registry";
import { runDelegation, type DelegateArgs } from "./agent";

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
    "Run a scoped sub-agent task (OpenCode-compatible). Use subagent_type explore|scout|architect|builder|reviewer|debugger|research. " +
    "Pass task_id to resume/wait on a background run. Set background=true to return immediately; you will get a running task id.",
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
        "Specialist: explore, scout, research, architect, builder, reviewer, debugger",
      ),
      task_id: stringParam(
        "Resume a prior background task (same subagent session)",
      ),
      background: booleanParam(
        "When true, run async and return immediately with task id",
      ),
    },
    ["description", "prompt", "subagent_type"],
  ),
  handler: async (args: {
    description: string;
    prompt: string;
    subagent_type: string;
    task_id?: string;
    background?: boolean;
    workspace?: string;
    workspaceId?: number;
    chatId?: number;
    turnId?: string;
    depth?: number;
    delegationChatMode?: DelegateArgs["delegationChatMode"];
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
    const agentId = args.subagent_type.trim() || "explore";

    const run = async () => {
      const delegation = await runDelegation({
        agent_id: agentId,
        task: args.prompt,
        workspace: args.workspace,
        workspaceId: args.workspaceId,
        depth: args.depth ?? 0,
        chatId: args.chatId,
        turnId: args.turnId,
        delegationChatMode: args.delegationChatMode,
        parentAgentRole: "main",
      });
      const rec = taskStore.get(taskId);
      if (!rec) return;
      if (delegation.success) {
        rec.state = "completed";
        rec.resultText =
          typeof delegation.summary === "string"
            ? delegation.summary
            : JSON.stringify(delegation);
      } else {
        rec.state = "error";
        rec.error = delegation.error ?? "Delegation failed";
      }
      rec.finishedAt = Date.now();
    };

    if (args.background) {
      taskStore.set(taskId, {
        id: taskId,
        state: "running",
        subagentType: agentId,
        prompt: args.prompt,
        startedAt: Date.now(),
      });
      void run().catch((err) => {
        const rec = taskStore.get(taskId);
        if (!rec) return;
        rec.state = "error";
        rec.error = err instanceof Error ? err.message : String(err);
        rec.finishedAt = Date.now();
      });
      return taskEnvelope(
        taskId,
        "running",
        [
          "<summary>Background task started</summary>",
          "<task_result>",
          "Background task started. Use task_id on a later turn to collect results.",
          "</task_result>",
        ].join("\n"),
      );
    }

    taskStore.set(taskId, {
      id: taskId,
      state: "running",
      subagentType: agentId,
      prompt: args.prompt,
      startedAt: Date.now(),
    });
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
