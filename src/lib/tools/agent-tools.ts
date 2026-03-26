/**
 * v2.1: delegate_to_agent tool for Guided/Autonomous mode.
 * Guided: flat delegation only. Autonomous: agents can call delegate_to_agent (nested) up to max depth.
 */

import { generateText } from "ai";
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
import type { ZodTypeAny } from "zod";
import {
  ArchitectPlanPayloadSchema,
  BuilderExecutionSummarySchema,
  ReviewerFindingsSchema,
  DebuggerRootCauseSchema,
} from "../agents/agent-handoff-schemas";
import { validateStructuredOutputWithSingleRetry } from "../agents/structured-output-validation";
import { defaultAgentForWorkMode } from "../agents/work-mode-agents";

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

  if (agentMode === "autonomous" && depth >= maxDepth) {
    return {
      success: false,
      error: `Max delegation depth (${maxDepth}) reached. Cannot nest further.`,
      agent: agent.name,
    };
  }

  const workspace = args.workspace ?? "";
  const workspaceId = args.workspaceId;

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
          const result = await ToolRegistry.execute(t.name, {
            ...toolArgs,
            workspace: workspace || undefined,
            workspaceId,
            chatMode: "build",
          });
          return typeof result === "object" && result !== null
            ? JSON.stringify(result)
            : String(result);
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
            });
            return JSON.stringify(nestedResult);
          },
        };
      }
    }

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
    const rawSummary = result.text?.trim() || "(No summary produced)";
    if (!schemaConfig) {
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
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
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
