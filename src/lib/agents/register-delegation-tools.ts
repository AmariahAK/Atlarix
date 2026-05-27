/**
 * Attach delegate_to_agent, spawn_sub_agent, and task to a stream ToolSet.
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
  scopeFromDelegateArgs,
} from "@/lib/chat/subagent-activity";
import {
  delegationChatModeFromWorkMode,
  MAX_SUBAGENTS_PER_TURN,
} from "@/lib/agents/agent-runtime";
import {
  acquireDelegationSlot,
  releaseDelegationSlot,
} from "@/lib/agents/delegation-limiter";
import type { WorkMode } from "@/lib/schemas";
import type { SubagentActivityEmit } from "@/lib/tools/agent";

export type DelegationStreamContext = {
  sender: WebContents;
  chatId: number;
  effectiveWorkMode: WorkMode;
  workspacePath?: string;
  workspaceId?: number;
  turnId: string;
  safeSend: (sender: WebContents, channel: string, payload: unknown) => void;
  recordToolUseForTurn: (turnId: string, toolName: string) => void;
  onDelegated?: (agentId: string) => void;
  /** Count of delegations started this turn (in-flight + completed). */
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

function delegationDedupeKey(
  agentId: string,
  args: Record<string, unknown>,
  scope: string | undefined,
): string {
  const preset = String(args.preset ?? "");
  return `${agentId}|${preset}|${scope ?? ""}`;
}

export function attachDelegationToolsToSet(
  tools: ToolSet,
  ctx: DelegationStreamContext,
): void {
  const delegationChatMode = delegationChatModeFromWorkMode(ctx.effectiveWorkMode);

  for (const delegateToolName of ["delegate_to_agent", "spawn_sub_agent"] as const) {
    const delegateTool = ToolRegistry.get(delegateToolName);
    if (!delegateTool) continue;

    tools[delegateToolName] = {
      description: delegateTool.description,
      inputSchema: normalizeToolInputSchemaForAiSdk(
        delegateTool.parameters ?? {},
      ) as never,
      execute: async (args: Record<string, unknown>) => {
        const activeCount = ctx.getDelegationCount?.() ?? 0;
        if (activeCount >= MAX_SUBAGENTS_PER_TURN) {
          return JSON.stringify({
            success: false,
            error: `Maximum ${MAX_SUBAGENTS_PER_TURN} sub-agents per turn. Batch scopes into fewer agents or wait for completion.`,
          });
        }

        const agentId = String(args.agent_id ?? "agent");
        const task = String(args.task ?? "");
        const scope = scopeFromDelegateArgs(args);
        const dedupeKey = delegationDedupeKey(agentId, args, scope);
        if (ctx.tryAcquireDedupeKey && !ctx.tryAcquireDedupeKey(dedupeKey)) {
          return JSON.stringify({
            success: false,
            error:
              "A sub-agent with the same agent, preset, and scope is already running. Batch paths into scopes[] on one spawn_sub_agent call instead of duplicate spawns.",
          });
        }

        ctx.onDelegationStart?.();

        ctx.safeSend(ctx.sender, "chat:tool:start", {
          chatId: ctx.chatId,
          toolId: delegateToolName,
          toolName: getToolActivityLabel(delegateToolName),
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
          scope,
          parentToolId: delegateToolName,
          roundId: ctx.turnId,
          timestamp: startTime,
        });
        const displayLabel =
          typeof startPayload.label === "string"
            ? startPayload.label
            : agentId;

        await acquireDelegationSlot(ctx.chatId, ctx.turnId, maxConcurrent, () => {
          ctx.safeSend(ctx.sender, "chat:activity", {
            type: "subagent_progress",
            id,
            chatId: ctx.chatId,
            agent: agentId,
            agentType: agentId,
            scope,
            parentDelegationId: id,
            roundId: ctx.turnId,
            status: "running",
            timestamp: Date.now(),
            preview: "Queued — waiting for a delegation slot…",
            label: "Queued",
          });
        });

        try {
          ctx.safeSend(ctx.sender, "chat:activity", {
            type: "delegation_start",
            id,
            parentId: undefined,
            depth: 0,
            agent: agentId,
            task,
            status: "active",
            timestamp: startTime,
            label: displayLabel,
            chatId: ctx.chatId,
          });
          ctx.safeSend(ctx.sender, "chat:activity", startPayload);
          const startPreview = initialSubagentProgressPreview(scope, task);
          ctx.safeSend(ctx.sender, "chat:activity", {
            type: "subagent_progress",
            id,
            chatId: ctx.chatId,
            agent: agentId,
            agentType: agentId,
            scope,
            parentDelegationId: id,
            roundId: ctx.turnId,
            status: "running",
            timestamp: Date.now(),
            preview: startPreview,
            label: startPreview,
          });

          const registryName =
            delegateToolName === "spawn_sub_agent"
              ? "spawn_sub_agent"
              : "delegate_to_agent";
          const emitSubagentActivity = (payload: SubagentActivityEmit) => {
            const ts = Date.now();
            if (payload.type === "subagent_progress") {
              ctx.safeSend(ctx.sender, "chat:activity", {
                type: "subagent_progress",
                id,
                chatId: ctx.chatId,
                agent: agentId,
                agentType: agentId,
                scope,
                parentDelegationId: id,
                roundId: ctx.turnId,
                status: "running",
                timestamp: ts,
                preview: payload.preview,
                label: payload.preview,
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
              parentDelegationId: id,
              roundId: ctx.turnId,
            });
          };

          const result = await ToolRegistry.execute(registryName, {
            ...args,
            workspace: ctx.workspacePath || undefined,
            workspaceId: ctx.workspaceId,
            delegationChatMode,
            chatId: ctx.chatId,
            depth: 1,
            turnId: ctx.turnId,
            parentAgentRole: "main",
            parentDelegationId: id,
            roundId: ctx.turnId,
            emitSubagentActivity,
          });
          ctx.recordToolUseForTurn(ctx.turnId, registryName);
          if (result?.success !== false) {
            ctx.onDelegated?.(agentId);
          }

          const duration = Date.now() - startTime;
          const isError = result?.success === false;
          const validationInfo =
            result && typeof result === "object"
              ? (result as { validation?: unknown }).validation
              : undefined;
          const summaryText =
            typeof result === "object" && result
              ? (result as { summary?: unknown }).summary
              : undefined;

          ctx.safeSend(ctx.sender, "chat:activity", {
            type: isError ? "delegation_error" : "delegation_complete",
            id,
            status: isError ? "error" : "done",
            result: summaryText,
            duration,
            timestamp: Date.now(),
            label: displayLabel,
            detail: summaryText
              ? String(summaryText).slice(0, 200)
              : undefined,
            chatId: ctx.chatId,
          });
          ctx.safeSend(
            ctx.sender,
            "chat:activity",
            buildSubagentCompletePayload({
              id,
              chatId: ctx.chatId,
              agentId,
              summary:
                typeof summaryText === "string" ? summaryText : undefined,
              duration,
              isError,
              scope,
              roundId: ctx.turnId,
            }),
          );

          if (
            validationInfo &&
            typeof validationInfo === "object" &&
            ((validationInfo as { status?: string }).status === "fallback" ||
              (validationInfo as { warning?: string }).warning)
          ) {
            ctx.safeSend(ctx.sender, "chat:activity", {
              id: `structured-validation-${Date.now()}`,
              type: "background",
              label: `Structured output validation (${agentId})`,
              status:
                (validationInfo as { status?: string }).status === "fallback"
                  ? "error"
                  : "done",
              timestamp: Date.now(),
              detail:
                (validationInfo as { warning?: string }).warning ||
                `Schema ${(validationInfo as { schema?: string }).schema ?? "unknown"} validated in ${(validationInfo as { attempts?: number }).attempts ?? 1} attempt(s).`,
              chatId: ctx.chatId,
            });
          }

          return typeof result === "string" ? result : JSON.stringify(result);
        } finally {
          ctx.releaseDedupeKey?.(dedupeKey);
          releaseDelegationSlot(ctx.chatId, ctx.turnId, maxConcurrent);
          ctx.safeSend(ctx.sender, "chat:tool:end", { chatId: ctx.chatId });
        }
      },
    };
  }

  const taskTool = ToolRegistry.get("task");
  if (taskTool) {
    tools.task = {
      description: taskTool.description,
      inputSchema: normalizeToolInputSchemaForAiSdk(
        taskTool.parameters ?? {},
      ) as never,
      execute: async (args: Record<string, unknown>) => {
        ctx.safeSend(ctx.sender, "chat:tool:start", {
          chatId: ctx.chatId,
          toolId: "task",
          toolName: getToolActivityLabel("task"),
        });
        try {
          const result = await ToolRegistry.execute("task", {
            ...args,
            workspace: ctx.workspacePath || undefined,
            workspaceId: ctx.workspaceId,
            delegationChatMode,
            chatId: ctx.chatId,
            turnId: ctx.turnId,
            depth: 0,
          });
          ctx.recordToolUseForTurn(ctx.turnId, "task");
          return typeof result === "string" ? result : JSON.stringify(result);
        } finally {
          ctx.safeSend(ctx.sender, "chat:tool:end", { chatId: ctx.chatId });
        }
      },
    };
  }
}
