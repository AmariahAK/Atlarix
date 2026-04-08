/**
 * v2.1: delegate_to_agent tool for Guided/Autonomous mode.
 * Guided: flat delegation only. Autonomous: agents can call delegate_to_agent (nested) up to max depth.
 */

import { generateText, zodSchema } from "ai";
import type { ToolSet } from "ai";
import {
  ToolRegistry,
  ToolCategory,
  createParameters,
  stringParam,
} from "./registry";
import { getBuiltinAgent } from "../agents/builtin";
import { readSettings } from "../../main/settings";
import { getModelClient, getEffectiveModel } from "../../ipc/utils/get_model_client";
import log from "electron-log";
import { z, type ZodTypeAny } from "zod";
import {
  ArchitectPlanPayloadSchema,
  BuilderExecutionSummarySchema,
  ReviewerFindingsSchema,
  DebuggerRootCauseSchema,
} from "../agents/agent-handoff-schemas";
import { validateStructuredOutputWithSingleRetry } from "../agents/structured-output-validation";
import { defaultAgentForWorkMode } from "../agents/work-mode-agents";
import {
  appendAutonomousOp,
  autonomousOpFromPermissionExec,
} from "../../ipc/handlers/autonomous-session-state";
import {
  publishAgentMessage,
  toAgentId,
  waitForBusReply,
  drainAgentCorrections,
} from "../agents/agent-bus";

const logger = log.scope("agent-tools");

const DELEGATE_MAX_STEPS = 8;

type DelegateArgs = {
  agent_id: string;
  task: string;
  context?: string;
  workspace?: string;
  workspaceId?: number;
  /** Set by caller; depth for nested delegation (0 = top level). */
  depth?: number;
  /** Fix: Finding 3 — parent session tool mode for nested ToolRegistry.execute */
  delegationChatMode?: "build" | "plan" | "ask";
  /** Active chat (Build stream) — required for autonomous sub-agent permission auto-approve. */
  chatId?: number;
  /** Assistant message id for this turn — autonomous session log + snapshots. */
  turnId?: string;
  /** Role of the delegating agent (for bus); omit for main. */
  parentAgentRole?: string;
};

/** Run a single delegation; used by handler and by nested execute when Autonomous. */
async function runDelegation(args: DelegateArgs): Promise<{
  success: boolean;
  agent?: string;
  summary?: string;
  stepsUsed?: number;
  error?: string;
  structuredPayload?: unknown;
  validation?: {
    status: "ok" | "fallback";
    schema: string;
    attempts: 1 | 2;
    warning?: string;
  };
}> {
  const settings = readSettings();
  const requestedAgentId = args.agent_id;
  const resolvedAgentId =
    settings.intentMode === "auto" || !settings.workModePreference
      ? requestedAgentId
      : defaultAgentForWorkMode(settings.workModePreference);
  const agent = getBuiltinAgent(resolvedAgentId);
  if (!agent) {
    return { success: false, error: `Unknown agent: ${resolvedAgentId}` };
  }
  const agentMode = settings.agentMode ?? "guided";
  const maxDepth = settings.aiConfiguration?.autonomous?.maxDelegationDepth ?? 2;
  const depth = args.depth ?? 0;
  const delegationChatMode = args.delegationChatMode ?? "build";

  if (agentMode === "autonomous" && depth >= maxDepth) {
    return {
      success: false,
      error: `Max delegation depth (${maxDepth}) reached. Cannot nest further.`,
      agent: agent.name,
    };
  }

  const workspace = args.workspace ?? "";
  const workspaceId = args.workspaceId;
  const parentRole = toAgentId(args.parentAgentRole ?? "main");
  const targetAgent = toAgentId(resolvedAgentId);

  try {
    // v2.5: Mode/role-aware model for delegation (Guided: Fast; Autonomous depth 0: Balanced; depth > 0: Fast)
    const effectiveModel = getEffectiveModel(settings);
    const delegationOptions = {
      agentMode: agentMode as "direct" | "guided" | "autonomous",
      delegationRole: depth > 0 ? ("subagent" as const) : ("agent" as const),
      delegationDepth: depth,
    };
    const { modelClient } = await getModelClient(effectiveModel, settings, delegationOptions);

    const allTools = ToolRegistry.getAll();
    const agentToolNames = new Set(agent.toolSet);
    let toolsForAgent = allTools.filter((t) => agentToolNames.has(t.name));

    const toolSet: ToolSet = {};
    for (const t of toolsForAgent) {
      toolSet[t.name] = {
        description: t.description,
        inputSchema: (t.parameters ?? {}) as never,
        execute: async (toolArgs: any) => {
          let result = await ToolRegistry.execute(t.name, {
            ...toolArgs,
            workspace: workspace || undefined,
            workspaceId,
            chatMode: delegationChatMode,
          });

          // Autonomous: run permissioned tools without user queue (all delegation depths when chatId set)
          if (
            agentMode === "autonomous" &&
            args.chatId != null &&
            result &&
            typeof result === "object" &&
            (result as { __permission_required?: boolean }).__permission_required === true
          ) {
            const { getInterceptor } = await import("../../ipc/handlers/permissions/handlers");
            const interceptor = getInterceptor(args.chatId);
            const perm = interceptor?.parsePermissionRequest(result) ?? null;
            if (interceptor && perm) {
              const operationId = interceptor.generateOperationId();
              interceptor.bufferOperation(operationId, perm, true);
              logger.info(
                `[Autonomous] Tool executed without user approval: ${t.name} (${perm.operation})`,
              );
              const execMeta = await interceptor.executeOperation(operationId);
              const detail = interceptor.getExecutionResult(operationId);
              if (args.turnId != null && args.turnId !== "") {
                appendAutonomousOp(
                  args.chatId,
                  args.turnId,
                  autonomousOpFromPermissionExec(
                    operationId,
                    perm.operation,
                    perm.preview,
                    execMeta.approved,
                  ),
                );
              }
              if (execMeta.approved) {
                result = {
                  success: true,
                  message: `Executed ${perm.operation} (autonomous sub-agent)`,
                  path: detail.path,
                  output: detail.output,
                  exitCode: detail.exitCode,
                };
              } else {
                result = {
                  success: false,
                  error: execMeta.error ?? detail.error ?? "Execution failed",
                  output: detail.output,
                  exitCode: detail.exitCode,
                };
              }
            }
          }

          let out =
            typeof result === "object" && result !== null
              ? JSON.stringify(result)
              : String(result);
          if (args.turnId) {
            const notes = drainAgentCorrections(args.turnId, targetAgent);
            if (notes.length > 0) {
              out += `\n\n[Main correction]\n${notes.map((n) => `- ${n}`).join("\n")}`;
            }
          }
          return out;
        },
      };
    }

    // Autonomous: allow this agent to call delegate_to_agent (nested) if under depth limit
    if (agentMode === "autonomous" && depth < maxDepth) {
      const delegateMeta = ToolRegistry.get("delegate_to_agent");
      if (delegateMeta) {
        toolSet["delegate_to_agent"] = {
          description: delegateMeta.description,
          inputSchema: (delegateMeta.parameters ?? {}) as never,
          execute: async (toolArgs: any) => {
            const nestedResult = await runDelegation({
              ...toolArgs,
              workspace,
              workspaceId,
              depth: depth + 1,
              delegationChatMode,
              chatId: args.chatId,
              turnId: args.turnId,
              parentAgentRole: resolvedAgentId,
            });
            return JSON.stringify(nestedResult);
          },
        };
      }
    }

    if (agentMode === "autonomous" && args.chatId != null && args.turnId) {
      const messageAgentSchema = z.object({
        to: z.enum(["research", "architect", "builder", "reviewer", "debugger", "main"]),
        type: z.enum(["question", "answer", "status", "blocker"]),
        content: z.string(),
      });
      toolSet["message_agent"] = {
        description:
          "Send a message to another specialist agent and wait for their response. Use when you need information or a decision from a peer before continuing. Available agents: research, architect, builder, reviewer, debugger, main. Replies require the peer to publish an answer on the agent bus (otherwise you get no_reply after 10s).",
        inputSchema: zodSchema(messageAgentSchema),
        execute: async (params: z.infer<typeof messageAgentSchema>) => {
          const { to, type, content } = params;
          const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
          const toId = toAgentId(to);
          const fromId = targetAgent;
          publishAgentMessage({
            id: messageId,
            from: fromId,
            to: toId,
            type,
            payload: { content },
            content,
            turnId: args.turnId,
            depth,
            chatId: args.chatId,
          });
          const reply = await waitForBusReply(messageId, {
            expectFrom: toId,
            expectTo: fromId,
            timeoutMs: 10_000,
          });
          if (!reply) {
            return JSON.stringify({
              status: "no_reply",
              message: "Agent did not respond within timeout, continuing.",
            });
          }
          return JSON.stringify({
            status: "replied",
            from: reply.from,
            content: reply.content ?? String(reply.payload ?? ""),
          });
        },
      };
    }

    if (args.turnId) {
      publishAgentMessage({
        from: parentRole,
        to: targetAgent,
        type: "task_assign",
        payload: { task: args.task, context: args.context ?? null },
        content: args.task,
        turnId: args.turnId,
        depth,
        chatId: args.chatId,
      });
    }

    const emitTaskResult = (summary: string) => {
      if (!args.turnId) return;
      publishAgentMessage({
        from: targetAgent,
        to: parentRole,
        type: "task_result",
        payload: { summary: summary.slice(0, 4000) },
        content: summary.slice(0, 2000),
        turnId: args.turnId,
        depth,
        chatId: args.chatId,
      });
    };

    const userContent =
      args.task + (args.context ? `\n\nContext:\n${args.context}` : "");

    const result = await generateText({
      model: modelClient.model,
      system: agent.systemPrompt,
      messages: [{ role: "user" as const, content: userContent }],
      tools: toolSet,
      maxSteps: DELEGATE_MAX_STEPS,
    } as Parameters<typeof generateText>[0]);

    const stepsUsed = result.steps?.length ?? 0;
    logger.info(`Delegation to ${agent.name} (depth=${depth}) completed; steps=${stepsUsed}`);

    const toolNames: string[] = [];
    for (const step of result.steps ?? []) {
      const tc = (step as { toolCalls?: { toolName?: string }[] }).toolCalls;
      if (Array.isArray(tc)) {
        for (const c of tc) {
          if (c?.toolName) toolNames.push(String(c.toolName));
        }
      }
    }
    const uniqTools = [...new Set(toolNames)];
    // Fix: Workforce-4 — completion line for autonomous runs (tool visibility in returned summary)
    const autonomousFooter =
      agentMode === "autonomous" && uniqTools.length > 0
        ? `\n\n— Autonomous run: tools invoked — ${uniqTools.join(", ")}`
        : "";

    const schemaByAgent: Record<
      string,
      {
        schemaName: string;
        schemaHint: string;
        schema: ZodTypeAny;
      }
    > = {
      architect: {
        schemaName: "ArchitectPlanPayload",
        schemaHint:
          "{ version: 1, summary: string, phases: [{ id: string, title: string, tasks: string[] }], risks?: string[] }",
        schema: ArchitectPlanPayloadSchema,
      },
      builder: {
        schemaName: "BuilderExecutionSummary",
        schemaHint:
          "{ version: 1, filesTouched: string[], summary: string, testsRun?: string }",
        schema: BuilderExecutionSummarySchema,
      },
      reviewer: {
        schemaName: "ReviewerFindings",
        schemaHint:
          "{ version: 1, severity: pass|minor|major|blocker, findings: [{ file?: string, message: string, suggestion?: string }] }",
        schema: ReviewerFindingsSchema,
      },
      debugger: {
        schemaName: "DebuggerRootCause",
        schemaHint:
          "{ version: 1, hypothesis: string, likelyFiles: string[], nextSteps: string[] }",
        schema: DebuggerRootCauseSchema,
      },
    };

    const schemaConfig = schemaByAgent[resolvedAgentId];
    const rawSummary = (result.text?.trim() || "(No summary produced)") + autonomousFooter;
    if (!schemaConfig) {
      emitTaskResult(rawSummary);
      return {
        success: true,
        agent: agent.name,
        summary: rawSummary,
        stepsUsed,
      };
    }

    const validated = await validateStructuredOutputWithSingleRetry({
      rawText: rawSummary,
      schema: schemaConfig.schema,
      schemaName: schemaConfig.schemaName,
      schemaHint: schemaConfig.schemaHint,
      retry: async (retryPrompt) => {
        const retryResult = await generateText({
          model: modelClient.model,
          system: `${agent.systemPrompt}\n\nReturn only valid JSON for structured handoff output.`,
          messages: [{ role: "user" as const, content: retryPrompt }],
        } as Parameters<typeof generateText>[0]);
        return retryResult.text?.trim() || "";
      },
    });

    if (validated.status === "ok") {
      emitTaskResult(validated.normalizedText);
      return {
        success: true,
        agent: agent.name,
        summary: validated.normalizedText,
        stepsUsed,
        structuredPayload: validated.data,
        validation: {
          status: "ok",
          schema: schemaConfig.schemaName,
          attempts: validated.attempts,
          warning: validated.warning,
        },
      };
    }

    emitTaskResult(rawSummary);
    return {
      success: true,
      agent: agent.name,
      summary: rawSummary,
      stepsUsed,
      validation: {
        status: "fallback",
        schema: schemaConfig.schemaName,
        attempts: validated.attempts,
        warning: validated.warning,
      },
    };
  } catch (err) {
    logger.error("delegate_to_agent failed:", err);
    const errMessage = err instanceof Error ? err.message : String(err);
    if (args.turnId) {
      publishAgentMessage({
        from: targetAgent,
        to: parentRole,
        type: "blocker",
        content: errMessage,
        payload: { error: errMessage },
        turnId: args.turnId,
        depth,
        chatId: args.chatId,
      });
    }
    return {
      success: false,
      error: errMessage,
      agent: agent.name,
    };
  }
}

ToolRegistry.register({
  name: "delegate_to_agent",
  description:
    "You have this tool in Guided and Autonomous modes. Delegate to a specialist: research, architect, builder, reviewer, or debugger (errors/traces). Returns the agent's summary so you can continue. In Autonomous mode, nested delegation is allowed up to the configured depth.",
  category: ToolCategory.TASK,
  cost: 2,
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      agent_id: {
        type: "string",
        description: "One of: research, architect, builder, reviewer, debugger",
        enum: ["research", "architect", "builder", "reviewer", "debugger"],
      },
      task: stringParam("Clear description of the task for the specialist"),
      context: {
        type: "string",
        description: "Optional extra context (file paths, previous findings)",
      },
    },
    ["agent_id", "task"]
  ),
  handler: async (args: DelegateArgs) => runDelegation({ ...args, depth: args.depth ?? 0 }),
});
