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
import { getSummarizationModel } from "../summarization_model";
import { getModelClient } from "../../ipc/utils/get_model_client";
import log from "electron-log";

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
}> {
  const agent = getBuiltinAgent(args.agent_id);
  if (!agent) {
    return { success: false, error: `Unknown agent: ${args.agent_id}` };
  }

  const settings = readSettings();
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
    const summarizationModel = getSummarizationModel(settings);
    const { modelClient } = await getModelClient(summarizationModel, settings);

    const allTools = ToolRegistry.getAll();
    const agentToolNames = new Set(agent.toolSet);
    let toolsForAgent = allTools.filter((t) => agentToolNames.has(t.name));

    const toolSet: ToolSet = {};
    for (const t of toolsForAgent) {
      toolSet[t.name] = {
        description: t.description,
        parameters: t.parameters,
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
          parameters: delegateMeta.parameters,
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
    });

    const stepsUsed = result.steps?.length ?? 0;
    logger.info(`Delegation to ${agent.name} (depth=${depth}) completed; steps=${stepsUsed}`);

    return {
      success: true,
      agent: agent.name,
      summary: result.text?.trim() || "(No summary produced)",
      stepsUsed,
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
    "Delegate a task to a specialist agent (research, architect, builder, reviewer). Use when the task fits that specialist. Returns the agent's summary and findings. In Autonomous mode, agents can delegate to other agents (nested).",
  category: ToolCategory.TASK,
  cost: 2,
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      agent_id: {
        type: "string",
        description: "One of: research, architect, builder, reviewer",
        enum: ["research", "architect", "builder", "reviewer"],
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
