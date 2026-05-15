/**
 * v2.1: delegate_to_agent tool for Guided/Autonomous mode.
 * Guided: flat delegation only. Autonomous: agents can call delegate_to_agent (nested) up to max depth.
 */

import { generateText, zodSchema, type ModelMessage } from "ai";
import { normalizeToolInputSchemaForAiSdk } from "../ai/normalize-tool-schema";
import {
  buildContinuationPrompt,
  shouldContinue,
} from "../streaming/continuation-handler";
import { runMidLoopCompaction, pruneToolOutputsInModelMessages } from "@/lib/context/mid_loop_compaction";
import { resolveModelContextLimit } from "@/lib/context/resolve-model-context-limit";
import { estimateTokens } from "@/ipc/utils/token_utils";
import {
  createLedger,
  getLedger,
  planLedgerTurnId,
  recordDelegationToolOnLedger,
  advanceLedgerAfterDelegation,
  seedLedgerFromHandoff,
  setLedgerSteps,
  descriptionsFromArchitectPayload,
} from "../tasks/task-ledger";
import {
  ToolRegistry,
  ToolCategory,
  createParameters,
  stringParam,
} from "./registry";
import type { ToolSet } from "ai";
import { expandDelegationPreset } from "./delegation-presets";
import { loadSkill } from "../skills/skill-loader";
import {
  getAgentMetadata,
  getFocusedSkillNameForAgent,
  getSkillNameForAgent,
} from "../skills/skill-registry";
import { getToolManifest } from "../skills/tool-manifest";
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
import { recordToolUseForTurn } from "../../ipc/handlers/turn-tool-tracking";
import {
  publishAgentMessage,
  toAgentId,
  waitForBusReply,
  drainAgentCorrections,
} from "../agents/agent-bus";

const logger = log.scope("agent-tools");

const DELEGATION_LENGTH_CONTINUATION_MAX = 3;

function collectFilesWrittenFromLedger(turnId: string | undefined): string[] {
  if (!turnId) return [];
  const L = getLedger(turnId);
  if (!L) return [];
  return [
    ...new Set(L.steps.flatMap((s) => s.filesWritten ?? []).map((p) => String(p).trim())),
  ].filter(Boolean);
}

/** Stable JSON string for tool consumers when schema validation fails or research has no schema. */
function structuredDelegationEnvelope(args: {
  agentRole: DelegationAgentRole;
  status: "research" | "fallback";
  summary: string;
  turnId?: string;
}): string {
  return JSON.stringify({
    agentRole: args.agentRole,
    status: args.status,
    summary: args.summary,
    filesWritten: collectFilesWrittenFromLedger(args.turnId),
    completedAt: Date.now(),
  });
}

export type DelegateArgs = {
  agent_id: string;
  task: string;
  context?: string;
  /** Shorthand brief for Build/Debug — expands into `task` + structured instructions. */
  preset?: "none" | "map_repo" | "dependency_web_scout";
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

/** Builtin specialist id persisted on delegate JSON for HandoffResultCard labels. */
export type DelegationAgentRole =
  | "research"
  | "explore"
  | "scout"
  | "architect"
  | "builder"
  | "reviewer"
  | "debugger";

export type DelegationResult = {
  success: boolean;
  agent?: string;
  agentRole?: DelegationAgentRole;
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
};

/** Run a single delegation; used by handler, nested execute, and parallel-runner. */
export async function runDelegation(args: DelegateArgs): Promise<DelegationResult> {
  const settings = readSettings();
  const requestedAgentId = args.agent_id;
  const resolvedAgentId =
    settings.intentMode === "auto" || !settings.workModePreference
      ? requestedAgentId
      : defaultAgentForWorkMode(settings.workModePreference);
  const meta = getAgentMetadata(resolvedAgentId);
  if (!meta) {
    const roleUnknown = requestedAgentId as DelegationAgentRole;
    return {
      success: false,
      error: `Unknown agent: ${resolvedAgentId}`,
      agentRole: ["research", "explore", "scout", "architect", "builder", "reviewer", "debugger"].includes(
        roleUnknown,
      )
        ? roleUnknown
        : undefined,
    };
  }
  const agentMode = settings.agentMode ?? "guided";
  const maxDepth = settings.aiConfiguration?.autonomous?.maxDelegationDepth ?? 2;
  const depth = args.depth ?? 0;
  const delegationChatMode = args.delegationChatMode ?? "build";

  if (agentMode === "autonomous" && depth >= maxDepth) {
    return {
      success: false,
      error: `Max delegation depth (${maxDepth}) reached. Cannot nest further.`,
      agent: meta.name,
      agentRole: resolvedAgentId as DelegationAgentRole,
    };
  }

  const workspace = args.workspace ?? "";
  const workspaceId = args.workspaceId;
  const parentRole = toAgentId(args.parentAgentRole ?? "main");
  const targetAgent = toAgentId(resolvedAgentId);
  const effectiveTask = expandDelegationPreset(args.preset, args.task, args.context);

  try {
    // v2.5: Mode/role-aware model for delegation (Guided: Fast; Autonomous depth 0: Balanced; depth > 0: Fast)
    const effectiveModel = getEffectiveModel(settings);
    const delegationOptions = {
      agentMode: agentMode as "direct" | "guided" | "autonomous",
      delegationRole: depth > 0 ? ("subagent" as const) : ("agent" as const),
      delegationDepth: depth,
    };
    const { modelClient } = await getModelClient(effectiveModel, settings, delegationOptions);

    const skillName =
      depth > 0
        ? getFocusedSkillNameForAgent(resolvedAgentId)
        : getSkillNameForAgent(resolvedAgentId);
    const skillMarkdown = await loadSkill(skillName, workspace || undefined);
    const trimmedSkill = skillMarkdown.trim();
    if (!trimmedSkill) {
      return {
        success: false,
        error: `Empty or missing skill for agent: ${skillName}`,
        agent: meta.name,
        agentRole: resolvedAgentId as DelegationAgentRole,
      };
    }
    const manifest = getToolManifest(skillName);
    const delegationSystem = trimmedSkill;

    const allTools = ToolRegistry.getAll();
    const allowAll = manifest.allowed.includes("*");
    const allowSet = new Set(manifest.allowed.filter((n) => n !== "*"));
    let toolsForAgent = allowAll
      ? allTools
      : allTools.filter((t) => allowSet.has(t.name));

    const toolSet: ToolSet = {};
    for (const t of toolsForAgent) {
      toolSet[t.name] = {
        description: t.description,
        // ToolRegistry stores `parameters` as raw JSON Schema; the AI SDK
        // (`generateText`) runs `_def.typeName` over `inputSchema`, so raw
        // JSON Schema crashes with "Cannot read properties of undefined".
        // Always pipe through the shared normalizer.
        inputSchema: normalizeToolInputSchemaForAiSdk(t.parameters) as never,
        execute: async (toolArgs: any) => {
          let result = await ToolRegistry.execute(
            t.name,
            {
              ...toolArgs,
              workspace: workspace || undefined,
              workspaceId,
              chatMode: delegationChatMode,
            },
          );

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

          if (args.turnId) {
            recordToolUseForTurn(args.turnId, t.name);
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
            recordDelegationToolOnLedger(args.turnId, {
              toolName: t.name,
              summary: out.slice(0, 400),
            });
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
          inputSchema: normalizeToolInputSchemaForAiSdk(delegateMeta.parameters) as never,
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
        to: z.enum([
          "research",
          "explore",
          "scout",
          "architect",
          "builder",
          "reviewer",
          "debugger",
          "main",
        ]),
        type: z.enum(["question", "answer", "status", "blocker"]),
        content: z.string(),
      });
      toolSet["message_agent"] = {
        description:
          "Send a message to another specialist agent and wait for their response. Use when you need information or a decision from a peer before continuing. Available agents: research, explore, scout, architect, builder, reviewer, debugger, main. Replies require the peer to publish an answer on the agent bus (otherwise you get no_reply after 10s).",
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
        payload: { task: effectiveTask, context: args.context ?? null },
        content: effectiveTask,
        turnId: args.turnId,
        depth,
        chatId: args.chatId,
      });
    }

    const delegationWallStart = Date.now();
    const delegationModelId = `${effectiveModel.provider}:${effectiveModel.name}`;

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
        modelId: delegationModelId,
        responseMs: Date.now() - delegationWallStart,
      });
    };

    const userContent = effectiveTask;

    let delegMsgs: ModelMessage[] = [{ role: "user", content: userContent }];
    let delegLengthAttempts = 0;
    let totalDelegSteps = 0;
    // PASS8 C1-C4: Tier limit for compaction in the length-continuation loop.
    let delegationTierLimit = 32_000;
    try {
      const tierResolved = await resolveModelContextLimit(effectiveModel, settings);
      delegationTierLimit = tierResolved.tierLimit;
    } catch (e) {
      logger.warn("[Delegation] Failed to resolve tier limit; using fallback 32K:", e);
    }
    const delegationSystemEstimate = estimateTokens(delegationSystem);
    let result = await generateText({
      model: modelClient.model,
      system: delegationSystem,
      messages: delegMsgs,
      tools: toolSet,
      stopWhen: [() => false],
    } as Parameters<typeof generateText>[0]);
    totalDelegSteps += result.steps?.length ?? 0;

    while (
      shouldContinue(result.finishReason, {
        attemptCount: delegLengthAttempts,
        maxAttempts: DELEGATION_LENGTH_CONTINUATION_MAX,
      })
    ) {
      delegLengthAttempts++;
      delegMsgs = [
        ...delegMsgs,
        ...(result.response.messages as ModelMessage[]),
        {
          role: "user",
          content: buildContinuationPrompt({
            chatId: args.chatId ?? 0,
            turnId: args.turnId ?? "delegation",
            attemptCount: delegLengthAttempts,
            maxAttempts: DELEGATION_LENGTH_CONTINUATION_MAX,
            lastContent: result.text ?? "",
          }),
        },
      ];

      // PASS8-FIX: Tool results are appended above (SDK
      // `result.response.messages` includes any tool-result entries), THEN
      // prune, THEN compaction. Compaction never runs before the current
      // round's tool results land in delegMsgs.
      // PASS8 D1: Prune large tool outputs between rounds before compaction.
      delegMsgs = pruneToolOutputsInModelMessages(delegMsgs);

      // PASS8 C1-C4: Compaction mirrored from Build into all agentic loops.
      // Honors settings.enableContextAutoSummarize. No UI activity from this
      // context (delegation runs inside a tool execute callback with no sender).
      {
        const delegationCompaction = await runMidLoopCompaction({
          messages: delegMsgs,
          systemPromptEstimate: delegationSystemEstimate,
          tierLimit: delegationTierLimit,
          enabled: settings.enableContextAutoSummarize !== false,
          chatId: args.chatId ?? 0,
          loopLabel: "Delegation",
          onInfo: (msg) => logger.log(msg),
          onWarn: (msg, err) => logger.warn(msg, err),
        });
        if (delegationCompaction.compacted) {
          delegMsgs = delegationCompaction.messages;
        }
      }

      result = await generateText({
        model: modelClient.model,
        system: delegationSystem,
        messages: delegMsgs,
        tools: toolSet,
        stopWhen: [() => false],
      } as Parameters<typeof generateText>[0]);
      totalDelegSteps += result.steps?.length ?? 0;
    }

    const stepsUsed = totalDelegSteps;
    logger.info(`Delegation to ${meta.name} (depth=${depth}) completed; steps=${stepsUsed}`);

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
      const envelope = structuredDelegationEnvelope({
        agentRole: resolvedAgentId as DelegationAgentRole,
        status: "research",
        summary: rawSummary,
        turnId: args.turnId,
      });
      emitTaskResult(envelope);
      if (args.turnId) advanceLedgerAfterDelegation(args.turnId, envelope);
      return {
        success: true,
        agent: meta.name,
        agentRole: resolvedAgentId as DelegationAgentRole,
        summary: envelope,
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
          system: `${delegationSystem}\n\nReturn only valid JSON for structured handoff output.`,
          messages: [{ role: "user" as const, content: retryPrompt }],
        } as Parameters<typeof generateText>[0]);
        return retryResult.text?.trim() || "";
      },
    });

    if (validated.status === "ok") {
      emitTaskResult(validated.normalizedText);
      if (args.turnId) {
        const seeded =
          resolvedAgentId === "architect" &&
          (await seedLedgerFromHandoff(args.turnId, validated.data));
        if (!seeded) {
          advanceLedgerAfterDelegation(args.turnId, validated.normalizedText);
        }
        if (seeded && resolvedAgentId === "architect" && workspaceId != null) {
          const descriptions = descriptionsFromArchitectPayload(validated.data);
          if (descriptions?.length) {
            const pid = planLedgerTurnId(workspaceId);
            if (pid != null) {
              const planL = getLedger(pid);
              if (planL) {
                await setLedgerSteps(pid, descriptions, { archive: false });
              } else if (workspace.trim()) {
                createLedger({
                  turnId: pid,
                  chatId: args.chatId ?? 0,
                  originalTask: effectiveTask.slice(0, 8000),
                  chatType: "workspace",
                  workspacePath: workspace,
                  stepDescriptions: descriptions,
                });
              }
            }
          }
        }
      }
      return {
        success: true,
        agent: meta.name,
        agentRole: resolvedAgentId as DelegationAgentRole,
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

    const fallbackEnvelope = structuredDelegationEnvelope({
      agentRole: resolvedAgentId as DelegationAgentRole,
      status: "fallback",
      summary: rawSummary,
      turnId: args.turnId,
    });
    emitTaskResult(fallbackEnvelope);
    if (args.turnId) advanceLedgerAfterDelegation(args.turnId, fallbackEnvelope);
    return {
      success: true,
      agent: meta.name,
      agentRole: resolvedAgentId as DelegationAgentRole,
      summary: fallbackEnvelope,
      stepsUsed,
      validation: {
        status: "fallback",
        schema: schemaConfig.schemaName,
        attempts: validated.attempts,
        warning: validated.warning,
      },
    };
  } catch (err) {
    logger.error(`runDelegation failed (agent=${resolvedAgentId}):`, err);
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
      agent: meta.name,
      agentRole: resolvedAgentId as DelegationAgentRole,
    };
  }
}

ToolRegistry.register({
  name: "delegate_to_agent",
  description:
    "You have this tool in Guided and Autonomous modes. Delegate to a specialist: **explore** (read-only repo map), **scout** (deps + targeted web), **research** (web/docs), **architect**, **builder**, **reviewer**, or **debugger** (errors/traces). Optional **preset**: `map_repo` (Explore) or `dependency_web_scout` (Scout) expands a minimal task into a full brief. Returns the agent's summary so you can continue. In Autonomous mode, nested delegation is allowed up to the configured depth.",
  category: ToolCategory.TASK,
  cost: 2,
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      agent_id: {
        type: "string",
        description:
          "One of: explore, scout, research, architect, builder, reviewer, debugger",
        enum: ["explore", "scout", "research", "architect", "builder", "reviewer", "debugger"],
      },
      preset: {
        type: "string",
        description:
          "Optional. `map_repo` → Explore brief. `dependency_web_scout` → Scout brief. `none` or omit for free-form task only.",
        enum: ["none", "map_repo", "dependency_web_scout"],
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

// ═══════════════════════════════════════════════════════════
// REQUEST_TOOLS (absorbed from request-tools.ts)
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "request_tools",
    category: ToolCategory.COMMAND,
    description:
        "Request additional tool categories when the core set is not enough. " +
        "Pass `categories` as an array of internal ToolCategory names; only request what you will use this turn.",
    cost: 0,
    requiresWorkspace: false,
    isCore: true,
    parameters: {
        categories: {
            type: "array",
            items: { type: "string" },
            description: "Category names to load (e.g. ['memory', 'analysis']).",
            required: true,
        },
        reason: {
            type: "string",
            description: "Why you need them (optional).",
            required: false,
        },
    },
    handler: async (params: { categories: string[]; reason?: string }) => {
        return {
            __REQUEST_TOOLS__: true,
            categories: params.categories,
            reason: params.reason,
            message: `Requested tool categories: ${params.categories.join(", ")}`,
        };
    },
});
export { expandDelegationPreset } from "./delegation-presets";
