/**
 * Attach the `task` sub-agent tool to a stream ToolSet (v13).
 *
 * The registry-level `task` tool (spawn-task.ts) is plain; this wrapper adds
 * the live UI plumbing: subagent_start/progress/thought/complete chat:activity
 * events, the per-turn cap, the 5-slot concurrency limiter (multiple task
 * calls in one assistant round run in parallel), and dedupe.
 */

import type { ToolSet } from "ai";
import type { WebContents } from "electron";
import { ToolRegistry } from "@/lib/tools/registry";
import { normalizeToolInputSchemaForAiSdk } from "@/lib/ai/normalize-tool-schema";
import { getToolActivityLabel } from "@/lib/tool-activity-labels";
import {
  buildSubagentCompletePayload,
  buildSubagentStartPayload,
  initialSubagentProgressPreview,
} from "@/lib/chat/subagent-activity";
import { MAX_SUBAGENTS_PER_TURN } from "@/lib/agents/agent-runtime";
import {
  acquireDelegationSlot,
  releaseDelegationSlot,
} from "@/lib/agents/delegation-limiter";
import type { WorkMode } from "@/lib/schemas";
import type { SubagentActivityEmit } from "@/lib/agents/run-subagent";

export type DelegationStreamContext = {
  sender: WebContents;
  chatId: number;
  effectiveWorkMode: WorkMode;
  workspacePath?: string;
  workspaceId?: number;
  turnId: string;
  safeSend: (sender: WebContents, channel: string, payload: unknown) => void;
  onDelegated?: (agentId: string) => void;
  /** Count of sub-agents started this turn (in-flight + completed). */
  getDelegationCount?: () => number;
  onDelegationStart?: () => void;
  tryAcquireDedupeKey?: (key: string) => boolean;
  releaseDedupeKey?: (key: string) => void;
  maxConcurrentDelegations?: number;
};

function newDelegationId(agentId: string): string {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : String(Math.random()).slice(2, 10);
  return `delegation-${Date.now()}-${agentId}-${suffix}`;
}

function delegationChatModeFromWorkMode(
  workMode: WorkMode,
): "build" | "plan" | "ask" {
  if (workMode === "plan") return "plan";
  if (workMode === "build" || workMode === "debug") return "build";
  return "ask";
}

/**
 * v14.8.11: the sub-agent popup's bottom section renders this DISPLAY
 * summary — it must be the sub-agent's final answer, not the stringified
 * registry envelope ({"success":true,"result":"<task …"} used to render
 * verbatim). Unwraps the envelope + <task>/<summary>/<task_result> markup;
 * the model-facing result string is untouched by this. Also fixes the error
 * detection: inside the stringified envelope the quotes were escaped
 * (state=\"error\"), so the old regex never matched.
 */
export function extractDelegationDisplaySummary(
  result: unknown,
  resultStr: string,
): { summary: string; isError: boolean } {
  const unwrapped =
    result &&
    typeof result === "object" &&
    typeof (result as { result?: unknown }).result === "string"
      ? (result as { result: string }).result
      : resultStr;
  const isError = /state="error"/.test(unwrapped);
  const taskResult = /<task_result>([\s\S]*?)<\/task_result>/.exec(unwrapped);
  if (taskResult?.[1]?.trim()) {
    return { summary: taskResult[1].trim(), isError };
  }
  return {
    summary: unwrapped
      .replace(/<\/?task[^>]*>/g, "")
      .replace(/<\/?summary>/g, "")
      .trim(),
    isError,
  };
}

export function attachDelegationToolsToSet(
  tools: ToolSet,
  ctx: DelegationStreamContext,
): void {
  const delegationChatMode = delegationChatModeFromWorkMode(
    ctx.effectiveWorkMode,
  );

  const taskTool = ToolRegistry.get("task");
  if (!taskTool) return;

  tools.task = {
    description: taskTool.description,
    inputSchema: normalizeToolInputSchemaForAiSdk(
      taskTool.parameters ?? {},
    ) as never,
    execute: async (args: Record<string, unknown>) => {
      const activeCount = ctx.getDelegationCount?.() ?? 0;
      if (activeCount >= MAX_SUBAGENTS_PER_TURN) {
        return JSON.stringify({
          success: false,
          error: `Maximum ${MAX_SUBAGENTS_PER_TURN} sub-agents per turn. Wait for running tasks or fold the work into fewer prompts.`,
        });
      }

      const agentId = String(args.subagent_type ?? "").trim() || "scout";
      const task = String(args.prompt ?? args.description ?? "");
      const dedupeKey = `${agentId}|${task.slice(0, 200)}`;
      if (ctx.tryAcquireDedupeKey && !ctx.tryAcquireDedupeKey(dedupeKey)) {
        return JSON.stringify({
          success: false,
          error:
            "A sub-agent with the same prompt is already running. Vary the scope or wait for it to finish.",
        });
      }

      ctx.onDelegationStart?.();

      ctx.safeSend(ctx.sender, "chat:tool:start", {
        chatId: ctx.chatId,
        toolId: "task",
        toolName: getToolActivityLabel("task"),
      });
      const maxConcurrent =
        ctx.maxConcurrentDelegations ?? MAX_SUBAGENTS_PER_TURN;
      const id = newDelegationId(agentId);
      const startTime = Date.now();
      const startPayload = buildSubagentStartPayload({
        id,
        chatId: ctx.chatId,
        agentId,
        task,
        scope: undefined,
        parentToolId: "task",
        roundId: ctx.turnId,
        timestamp: startTime,
      });

      await acquireDelegationSlot(ctx.chatId, ctx.turnId, maxConcurrent, () => {
        ctx.safeSend(ctx.sender, "chat:activity", {
          type: "subagent_progress",
          id,
          chatId: ctx.chatId,
          agent: agentId,
          agentType: agentId,
          parentDelegationId: id,
          roundId: ctx.turnId,
          status: "running",
          timestamp: Date.now(),
          preview: "Queued — waiting for a sub-agent slot…",
          label: "Queued",
        });
      });

      try {
        ctx.safeSend(ctx.sender, "chat:activity", startPayload);
        const startPreview = initialSubagentProgressPreview(undefined, task);
        ctx.safeSend(ctx.sender, "chat:activity", {
          type: "subagent_progress",
          id,
          chatId: ctx.chatId,
          agent: agentId,
          agentType: agentId,
          parentDelegationId: id,
          roundId: ctx.turnId,
          status: "running",
          timestamp: Date.now(),
          preview: startPreview,
          label: startPreview,
        });

        const emitSubagentActivity = (payload: SubagentActivityEmit) => {
          const ts = Date.now();
          if (payload.type === "subagent_progress") {
            ctx.safeSend(ctx.sender, "chat:activity", {
              type: "subagent_progress",
              id,
              chatId: ctx.chatId,
              agent: agentId,
              agentType: agentId,
              parentDelegationId: id,
              roundId: ctx.turnId,
              status: "running",
              timestamp: ts,
              preview: payload.preview,
              label: payload.preview,
            });
            return;
          }
          if (payload.type === "subagent_thought") {
            // Rolling live model output — stable id per segment; the renderer
            // upserts so the block grows in place instead of appending lines.
            ctx.safeSend(ctx.sender, "chat:activity", {
              type: "subagent_thought",
              id: payload.id,
              chatId: ctx.chatId,
              agent: agentId,
              agentType: agentId,
              parentDelegationId: id,
              roundId: ctx.turnId,
              status: "running",
              timestamp: ts,
              preview: payload.content,
              channel: payload.channel,
            });
            return;
          }
          ctx.safeSend(ctx.sender, "chat:activity", {
            type: "tool_use",
            id: payload.id,
            chatId: ctx.chatId,
            toolName: payload.toolName,
            label:
              payload.label?.trim() || getToolActivityLabel(payload.toolName),
            status: payload.status === "running" ? "running" : payload.status,
            timestamp: ts,
            detail: payload.detail,
            // Forward args + result so the nested card renders an inline diff
            // (normalizeChatActivityPayload → streamThreadItemFromActivity →
            // buildToolExpandView). Without these the card falls back to a bare
            // "Editing file: N lines" label with no diff.
            toolArgs: payload.toolArgs,
            resultText: payload.resultText,
            parentDelegationId: id,
            roundId: ctx.turnId,
          });
        };

        const result = await ToolRegistry.execute("task", {
          ...args,
          workspace: ctx.workspacePath || undefined,
          workspaceId: ctx.workspaceId,
          delegationChatMode,
          chatId: ctx.chatId,
          turnId: ctx.turnId,
          parentDelegationId: id,
          emitSubagentActivity,
        });
        ctx.onDelegated?.(agentId);

        const duration = Date.now() - startTime;
        const resultStr =
          typeof result === "string" ? result : JSON.stringify(result);

        // v14.8.11: the DISPLAY summary must be the sub-agent's final answer,
        // not the stringified registry envelope — the popup used to render
        // {"success":true,"result":"<task …"} verbatim at its bottom. Unwrap
        // the envelope + <task>/<summary>/<task_result> markup; the model-
        // facing return (resultStr, below) is untouched.
        const { summary: innerResult, isError } = extractDelegationDisplaySummary(
          result,
          resultStr,
        );

        ctx.safeSend(
          ctx.sender,
          "chat:activity",
          buildSubagentCompletePayload({
            id,
            chatId: ctx.chatId,
            agentId,
            summary: innerResult.slice(0, 4_000),
            duration,
            isError,
            scope: undefined,
            roundId: ctx.turnId,
          }),
        );

        return resultStr;
      } finally {
        ctx.releaseDedupeKey?.(dedupeKey);
        releaseDelegationSlot(ctx.chatId, ctx.turnId, maxConcurrent);
        ctx.safeSend(ctx.sender, "chat:tool:end", { chatId: ctx.chatId });
      }
    },
  };
}
