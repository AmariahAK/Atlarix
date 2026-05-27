/**
 * delegate_to_agent / spawn_sub_agent — specialist delegation (all work modes).
 */

import { generateText, type ModelMessage } from "ai";
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
import type { ZodTypeAny } from "zod";
import {
  ArchitectPlanPayloadSchema,
  BuilderExecutionSummarySchema,
  ReviewerFindingsSchema,
  DebuggerRootCauseSchema,
} from "../agents/agent-handoff-schemas";
import { validateStructuredOutputWithSingleRetry } from "../agents/structured-output-validation";
import { defaultAgentForWorkMode } from "../agents/work-mode-agents";
import { getDelegationConfig } from "../agents/agent-runtime";
import { recordToolUseForTurn } from "../../ipc/handlers/turn-tool-tracking";
import { drainAgentCorrections } from "../agents/agent-corrections";
import { buildGroupHandoffDigest } from "@/lib/chat/group-handoff-digest";
import { getToolActivityLabel } from "@/lib/tool-activity-labels";
import {
  formatSmallRepoInventory,
  getWorkspaceRelFilePaths,
  SMALL_REPO_FILE_THRESHOLD,
} from "./workspace-file-hints";

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
  /** Workspace-relative section for blueprint/search tools in this delegation. */
  defaultFocusPath?: string;
  /** Batch up to 5 paths/repos for one sub-agent run. */
  scopes?: string[];
  parentDelegationId?: string;
  roundId?: string;
  /** Live UI: nested tool / progress rows inside the sub-agent round panel. */
  emitSubagentActivity?: (payload: SubagentActivityEmit) => void;
};

export type SubagentActivityEmit =
  | {
      type: "tool_use";
      id: string;
      toolName: string;
      status: "running" | "done" | "error";
      detail?: string;
    }
  | {
      type: "subagent_progress";
      preview: string;
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
  const { maxDelegationDepth: maxDepth } = getDelegationConfig(settings);
  const depth = args.depth ?? 0;
  const delegationChatMode = args.delegationChatMode ?? "build";

  if (depth >= maxDepth) {
    return {
      success: false,
      error: `Max delegation depth (${maxDepth}) reached. Cannot nest further.`,
      agent: meta.name,
      agentRole: resolvedAgentId as DelegationAgentRole,
    };
  }

  const workspace = args.workspace ?? "";
  const workspaceId = args.workspaceId;
  const targetAgent = resolvedAgentId;
  let effectiveTask = expandDelegationPreset(args.preset, args.task, args.context);
  const scopeList = Array.isArray(args.scopes)
    ? args.scopes.map((s) => String(s).trim()).filter(Boolean).slice(0, 5)
    : [];
  if (scopeList.length > 0) {
    effectiveTask += `\n\n## Scopes (batch)\n${scopeList.map((s) => `- ${s}`).join("\n")}`;
  }
  const ledgerEntries: { toolName: string; summary: string }[] = [];

  try {
    // v2.5: Mode/role-aware model for delegation (Guided: Fast; Autonomous depth 0: Balanced; depth > 0: Fast)
    const effectiveModel = getEffectiveModel(settings);
    const delegationOptions = {
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
    let delegationSystem = trimmedSkill;
    if (workspace?.trim()) {
      try {
        const { paths, count } = await getWorkspaceRelFilePaths(workspace);
        if (count > 0 && count <= SMALL_REPO_FILE_THRESHOLD) {
          delegationSystem += `\n\n## Workspace file inventory (authoritative)\n${formatSmallRepoInventory(paths)}`;
        }
      } catch (invErr) {
        logger.debug("[Delegation] workspace file inventory skipped:", invErr);
      }
    }

    const focusSection = args.defaultFocusPath?.trim();
    if (focusSection) {
      delegationSystem += `\n\n<delegation_blueprint_scope>
focus_path: ${focusSection}
Use this focus_path for get_blueprint. Parse and architecture graphs are section-scoped only for get_blueprint.
See guides/blueprint-section-first.md.
</delegation_blueprint_scope>`;
    }

    const allTools = ToolRegistry.getAll();
    const allowAll = manifest.allowed.includes("*");
    const allowSet = new Set(manifest.allowed.filter((n) => n !== "*"));
    let toolsForAgent = allowAll
      ? allTools
      : allTools.filter((t) => allowSet.has(t.name));

    if (depth > 0) {
      toolsForAgent = toolsForAgent.filter((t) => t.isReadOnly === true);
      if (!manifest.readOnly) {
        toolsForAgent = toolsForAgent.filter((t) =>
          ["read_file", "search", "explore_folder", "list_files", "get_repo_overview", "get_blueprint", "get_file_outline", "get_diagram", "web_search", "read_url", "find_file"].includes(t.name),
        );
      }
    }

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
          const emit = args.emitSubagentActivity;
          const delegationId = args.parentDelegationId?.trim();
          const toolActivityId =
            delegationId != null
              ? `sub-tool-${delegationId}-${t.name}-${Date.now()}`
              : null;

          if (emit && delegationId && toolActivityId) {
            emit({
              type: "tool_use",
              id: toolActivityId,
              toolName: t.name,
              status: "running",
            });
            emit({
              type: "subagent_progress",
              preview: `${getToolActivityLabel(t.name)}`,
            });
          }

          let result: unknown;
          try {
            result = await ToolRegistry.execute(
              t.name,
              {
                ...toolArgs,
                workspace: workspace || undefined,
                workspaceId,
                chatMode: delegationChatMode,
                _chatSessionId: args.chatId,
              },
            );
          } catch (err) {
            if (emit && delegationId && toolActivityId) {
              emit({
                type: "tool_use",
                id: toolActivityId,
                toolName: t.name,
                status: "error",
                detail: String(err).slice(0, 200),
              });
            }
            throw err;
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
            ledgerEntries.push({ toolName: t.name, summary: out.slice(0, 400) });
          }

          if (emit && delegationId && toolActivityId) {
            emit({
              type: "tool_use",
              id: toolActivityId,
              toolName: t.name,
              status: "done",
              detail: out.slice(0, 200),
            });
          }

          return out;
        },
      };
    }

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
    const toolsFooter =
      uniqTools.length > 0
        ? `\n\n— Delegation tools invoked — ${uniqTools.join(", ")}`
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
    const proseSummary =
      (result.text?.trim() || "(No summary produced)") + toolsFooter;
    const rawSummary = buildGroupHandoffDigest(ledgerEntries, proseSummary);
    if (!schemaConfig) {
      const envelope = structuredDelegationEnvelope({
        agentRole: resolvedAgentId as DelegationAgentRole,
        status: "research",
        summary: rawSummary,
        turnId: args.turnId,
      });
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
    "Delegate to a specialist: **explore** (read-only repo map), **scout** (deps + targeted web), **research** (web/docs), **architect**, **builder**, **reviewer**, or **debugger** (errors/traces). Optional **preset**: `map_repo` (Explore) or `dependency_web_scout` (Scout) expands a minimal task into a full brief. Returns the agent's summary so you can continue. In Autonomous mode, nested delegation is allowed up to the configured depth.",
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
      default_focus_path: stringParam(
        "Workspace-relative section folder for blueprint/search tools in this delegation.",
      ),
      scopes: {
        type: "array",
        description:
          "Optional batch of up to 5 workspace-relative paths/repos for one sub-agent run.",
        items: { type: "string" },
      },
    },
    ["agent_id", "task"]
  ),
  handler: async (args: DelegateArgs) => runDelegation({ ...args, depth: args.depth ?? 0 }),
});

ToolRegistry.register({
  name: "spawn_sub_agent",
  description:
    "Alias for delegate_to_agent (Cursor/OpenCode vocabulary). Spawn an isolated specialist for one scoped task: explore, scout, research, architect, builder, reviewer, or debugger. " +
    "Prefer one spawn per repo or focus_path (preset map_repo for Explore) instead of many parallel explore_folder calls. Returns a structured handoff summary.",
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
          "Optional. `map_repo` → Explore brief. `dependency_web_scout` → Scout brief.",
        enum: ["none", "map_repo", "dependency_web_scout"],
      },
      task: stringParam("Clear description of the task for the specialist"),
      context: {
        type: "string",
        description: "Optional extra context (file paths, repo name)",
      },
      default_focus_path: stringParam(
        "Workspace-relative section folder for this sub-agent.",
      ),
      scopes: {
        type: "array",
        description:
          "Optional batch of up to 5 workspace-relative paths/repos for one sub-agent run.",
        items: { type: "string" },
      },
    },
    ["agent_id", "task"],
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
