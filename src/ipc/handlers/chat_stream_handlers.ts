import { v4 as uuidv4 } from "uuid";
import { ipcMain, IpcMainInvokeEvent, type WebContents } from "electron";
import {
  ModelMessage,
  streamText,
  generateText,
  ToolSet,
  jsonSchema as aiJsonSchema,
} from "ai";

import { db } from "../../db";
import { apps } from "../../db/schema";
import { eq } from "drizzle-orm";
import type { SmartContextMode, UserSettings, WorkMode } from "../../lib/schemas";
import {
  constructSystemPrompt,
  constructSystemPromptParts,
  buildSystemPromptWithProjectInstructions,
  type ModeSystemKey,
} from "../../prompts/system_prompt";
import { mergeSystemPromptParts } from "@/lib/ai/merge-system-prompt";
import { getNativeWebSearchSupport } from "../utils/native_web_search";
import { perfReportOnce } from "@/lib/perf-marks";
import { buildAttachmentRecord } from "@/lib/attachment-upload";
import {
  SUPABASE_AVAILABLE_SYSTEM_PROMPT,
  SUPABASE_NOT_AVAILABLE_SYSTEM_PROMPT,
} from "../../prompts/supabase_prompt";
import { getAtlarixAppPath, resolveAppPath } from "../../paths/paths";
import { readSettings } from "../../main/settings";
import type { ChatContextReport, ChatResponseEnd, ChatStreamParams } from "../ipc_types";
import type { CodebaseFile } from "../../utils/codebase";
import { streamTestResponse } from "./testing_chat_handlers";
import { getTestResponse } from "./testing_chat_handlers";
import { getModelClient, getEffectiveModel, getEffectiveModelForOptions, ModelClient, type GetModelClientOptions } from "../utils/get_model_client";
import { buildAtlarixCoreTierCatalog } from "@/lib/atlarix-core-catalog";
import { resolveActiveModelIdentity } from "@/lib/model-identity-prompt";
import {
  setActiveModelDisplayName,
  clearActiveModelDisplayName,
} from "@/ipc/utils/active-model-identity";
import { resetAuxUsage, takeAuxUsage } from "@/lib/usage/turn-usage-aggregator";
import {
  getCompassUsageFromSupabase,
  recordCompassUsageTokens,
  reasoningTokensFromAiUsage,
  totalTokensFromAiUsage,
} from "../../lib/auth/compass_usage";
import {
  COMPASS_REACHABILITY_ERROR,
  compassExhaustedUserMessage,
  getOpenRouterModelIdForCompassTier,
} from "../shared/compass_constants";
import log from "electron-log";
import {
  getSupabaseContext,
  getSupabaseClientCode,
} from "../../supabase_admin/supabase_context";
import { SUMMARIZE_CHAT_SYSTEM_PROMPT } from "../../prompts/summarize_chat_system_prompt";
import { SECURITY_REVIEW_SYSTEM_PROMPT } from "../../prompts/security_review_prompt";
import fs from "node:fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { readFile, writeFile, unlink } from "fs/promises";
import {
  getMaxTokensWithFloor,
  getTemperature,
} from "../utils/token_utils";
import {
  MAX_CHAT_TURNS_IN_CONTEXT,
  STREAM_TOOL_LOOP_DURATION_CAP_MS,
} from "@/constants/settings_constants";
import {
  requireMcpAuth,
  type RequireMcpAuthInfo,
} from "../utils/mcp_auth_wait";

import { getExtraProviderOptions } from "../utils/thinking_utils";

import { safeSend } from "../utils/safe_sender";
import {
  normalizeToolInputSchemaForAiSdk,
  PERMISSIVE_TOOL_JSON_SCHEMA,
} from "@/lib/ai/normalize-tool-schema";
import {
  clearToolsUsedForTurn,
  getToolsUsedThisTurn,
  recordToolUseForTurn,
} from "./turn-tool-tracking";
import { stripHallucinatedAtlarixToolTagsFromDelta } from "@/lib/chat/answer-display";
import {
  getEphemeralChatAppId,
  getEphemeralChat,
  buildContinueAfterQuestionsPrompt,
} from "@/lib/ephemeral-chat";
import { shouldUseTextToolFallback } from "@/lib/stream/text-tool-fallback";
import { isStreamDebugLoggingEnabled } from "@/lib/stream/stream-debug";
import { stripQuestionsBlockFromResponse } from "../utils/cleanFullResponse";
import {
  removeThinkingTags,
  stripAssistantDisplayContent,
  stripTaskCompleteTags,
  stripThinkBlocks,
} from "../utils/thinking_tags";
import { FileUploadsState } from "../utils/file_uploads_state";
import { extractMentionedAppsCodebases } from "../utils/mention_apps";
import { parseAppMentions } from "@/shared/parse_mention_apps";
import type { ZodTypeAny } from "zod";
import { isTurboEditsV2Enabled } from "@/lib/schemas";
import {
  AI_STREAMING_ERROR_MESSAGE_PREFIX,
  AI_STREAM_EMPTY_RESPONSE_FALLBACK,
  SAFETY_FILTER_BLOCKED_MESSAGE,
  modelFailureUserMessage,
} from "@/shared/texts";
import {
  attachEmptyOutputSafeRejectHandlers,
  EmptyModelOutputAfterRetryError,
  isNoUsableModelOutputError,
  MODEL_EMPTY_RESPONSE_USER_MESSAGE,
} from "../utils/no_usable_model_output";
import {
  prepareUserChatTurnInput,
  ChatPromptSafetyError,
} from "../../lib/security/chat-prompt-gate";
import { sanitizeAssistantOutput } from "../../lib/security/profanity-filter";
import type { ModelTier } from "@/lib/routing/capability-registry";
import {
  needsOpenRouterContextSafety,
  resolveContextBudgetTier,
} from "@/lib/routing/context_budget_routing";
import {
  buildReasoningProviderOptions,
  detectReasoningCapability,
  resolveReasoningCatalogModelId,
  hasNativeDeepThinkingSupport,
} from "@/lib/routing/reasoning-detector";
import { enforceTierContextBudget } from "@/lib/routing/tier_context_budget";
import { processStreamChunks } from "../utils/stream_chunk_tags";
import { createSnapshot } from "../../lib/workspace-snapshots";
import { revertSnapshot, revertSnapshotFiles, snapshotExists } from "../../lib/snapshot/snapshot-manager";
import { feedTerminalOutput } from "../../lib/streams/StreamManager";
import {
  processChatMessagesWithVersionedFiles as getVersionedFiles,
  VersionedFiles as VersionedFiles,
} from "../utils/versioned_codebase_context";
import { ToolRegistry } from "../../lib/tools";
import { AttachmentStore } from "../../lib/attachment-store";
import {
  buildPasteAttachmentDirective,
  ensurePasteAttachmentIds,
  pasteToAttachmentData,
} from "../../lib/attachment-persistence";
import type { StoredFileAttachment } from "../ipc_types";
import {
  generateProgressiveRevealNote,
  isCoreTool,
  isWorkspaceIntegrationTool,
  WORKSPACE_INTEGRATION_TOOL_NAMES,
} from "../../lib/tools/ToolManifest";
import {
  getModeToolAllowlist,
  getModeToolAllowSets,
  includeToolForSession,
} from "../../lib/tools/mode-tool-registry";
import { debugWriteGateResult } from "../../lib/debug/debug-hypothesis-gate";
import { clearDebugHypothesis } from "../../lib/debug/debug-hypothesis-session";
import { toolExecutionChatMode } from "../../lib/work-mode";
import { ToolSessionLoader } from "../../lib/tools/ToolSessionLoader";
import {
  buildContinuationPrompt,
  shouldContinue,
} from "../../lib/streaming/continuation-handler";
import {
  createAgenticRepetitionState,
  type AgenticRepetitionOutcome,
} from "../../lib/streaming/agentic-loop-repetition";
import { consumeDelegationAbort } from "../../lib/agents/agent-bus-monitor";
import {
  cancelLedger,
  createLedger,
  formatLedgerForPrompt,
  getLedger,
  getLedgerStateString,
  hasActivePlanLedger,
  hydrateLedgerFromDisk,
  markLedgerStreamComplete,
  notifyPlanUiForTurnIfPresent,
  persistLedgerToDisk,
  planLedgerTurnId,
  getWorkspacePlanLedger,
  recordToolOnLedger,
  registerLedgerPlanUiNotifier,
  setLedgerSteps,
  unregisterLedgerPlanUiNotifier,
} from "@/lib/tasks/task-ledger";
import { emitPlanUpdate } from "@/ipc/utils/emit_plan_update";
import {
  isTaskComplete as isLedgerTaskComplete,
  getRemainingSteps,
  buildPendingStepsContinuationPrompt,
} from "@/lib/tasks/completion-detector";
import { assembleContextSections, type ContextSection } from "@/lib/context/ContextAssembler";
import { ContextBudgetTracker } from "@/lib/context/context-budget-tracker";
import { pruneContextSectionsForBudget } from "@/lib/context/context-budget-pruning";
import { resolveModelContextLimit } from "@/lib/context/resolve-model-context-limit";
import { estimateDispatchTokens } from "@/lib/routing/tier_context_budget";
import { runMidLoopCompaction } from "@/lib/context/mid_loop_compaction";
import { loadSkill } from "@/lib/skills/skill-loader";
import { getSkillNameForMode } from "@/lib/skills/skill-registry";
import {
  loadPrioritySkillsForWorkspace,
  formatPrioritySkillsForPrompt,
} from "@/lib/skills/priority-skill-loader";
import { SubscriptionManager } from "@/lib/SubscriptionManager";
// Pass 7: loadInstalledSkillsForSession is now reached through the get_active_skills tool.
import {
  ArchitectPlanPayloadSchema,
  DebuggerRootCauseSchema,
  ReviewerFindingsSchema,
} from "@/lib/agents/agent-handoff-schemas";
import { validateStructuredOutputWithSingleRetry } from "@/lib/agents/structured-output-validation";
import {
  requireAuthSession,
  formatAuthRequiredIpcError,
  AuthRequiredError,
} from "../../lib/auth/require_auth_session";
import * as Sentry from "@sentry/electron/main";
import { PermissionInterceptor } from "./permissions/interceptor";
import { registerInterceptor } from "./permissions/handlers";
import {
  appendAutonomousOp,
  autonomousOpFromPermissionExec,
  getAutonomousSessionLog,
  getAgentActivityForTurn,
} from "./autonomous-session-state";
import { getSessionMemory } from "../../lib/session-memory";
import { readAtlarixMd } from "../../lib/project-memory";
import {
  getContextSummary,
  schedulePostTurnCompaction,
  notifyCompactionLedgerSettled,
} from "../../lib/context-compaction";
import {
  estimateTokens,
  getContextWindow,
  getContextWindowDetailed,
  setCompassContextWindow,
} from "../utils/token_utils";
import { recordTrace } from "../../lib/agents/agent-lightning";
import { writeSettings } from "../../main/settings";
import {
  labelForWorkMode,
  resolveEffectiveWorkMode,
  settingsPatchForWorkMode,
} from "../../lib/work-mode";
import { classifyTerminalCommand } from "../../lib/terminal-command-class";
import { runCommandGitInitGateResult } from "../../lib/git-init-command-guard";
import { attachDelegationToolsToSet } from "../../lib/agents/register-delegation-tools";
import { isDelegationAllowedForWorkMode } from "../../lib/agents/agent-runtime";
import {
  getDelegationConfig,
  shouldAutoApprovePermissions,
} from "../../lib/agents/agent-runtime";
import { getToolActivityLabel } from "../../lib/tool-activity-labels";
import { summarizeToolResultForActivityDetail, toolResultTextForExpand } from "@/lib/chat/stream-tool-display";
import { captureSafe } from "../../main/lib/analytics";
import { runCommandCategoryPreflight } from "./command_permission_handlers";
import {
  applyFileScopePreflightInStream,
  enrichFilePermissionRequest,
} from "./file_permission_preflight";

const logger = log.scope("chat_stream_handlers");

function runCommandModeGateResult(
  command: string,
  workMode: WorkMode,
): string | null {
  if (classifyTerminalCommand(command) !== "implementation") return null;
  if (workMode === "build") return null;
  return JSON.stringify({
    success: false,
    error: `This command (${command}) makes changes to the environment and is only available in Build mode. You are currently in ${labelForWorkMode(workMode)} mode. Ask the user to switch to Build mode in the UI, or use a read-only command.`,
  });
}

function runCommandGateResult(command: string, workMode: WorkMode): string | null {
  const gitInitBlock = runCommandGitInitGateResult(
    command,
    readSettings().allowGitInit,
  );
  if (gitInitBlock) return gitInitBlock;
  return runCommandModeGateResult(command, workMode);
}

function emitRunCommandPermissionActivity(
  sender: Electron.WebContents,
  chatId: number,
  label: string,
  command: string,
) {
  safeSend(sender, "chat:activity", {
    id: `run-cmd-perm-${chatId}-${Date.now()}`,
    type: "tool_use",
    toolName: "run_command",
    label,
    detail: command.slice(0, 200),
    status: "done",
    timestamp: Date.now(),
    chatId,
  });
}

function emitFilePermissionActivity(
  sender: Electron.WebContents,
  chatId: number,
  label: string,
  path: string,
) {
  safeSend(sender, "chat:activity", {
    id: `file-perm-${chatId}-${Date.now()}`,
    type: "tool_use",
    toolName: "write_file",
    label,
    detail: path.slice(0, 200),
    status: "done",
    timestamp: Date.now(),
    chatId,
  });
}

function enrichPermissionRequestForUi(
  permRequest: { operation: string; preview: unknown },
  appId: number | null | undefined,
) {
  if (permRequest.operation === "run_command") {
    return enrichRunCommandPermissionRequest(permRequest, appId);
  }
  return enrichFilePermissionRequest(permRequest as import("@/lib/tools/permissions/schema").PermissionRequest, appId);
}

/** Category DB gate for run_command; returns tool JSON to return early, or null to continue permission UI. */
function runCommandCategoryGateToolResult(
  command: string,
  appId: number | null | undefined,
  chatId: number,
  sender: Electron.WebContents,
): string | null {
  const preflight = runCommandCategoryPreflight(command, appId);
  if (preflight.type === "auto_deny") {
    emitRunCommandPermissionActivity(
      sender,
      chatId,
      `run_command blocked (${preflight.category})`,
      command,
    );
    safeSend(sender, "command-permission-blocked", {
      chatId,
      category: preflight.category,
      message: `Command blocked (${preflight.category}) — change in Settings`,
    });
    return JSON.stringify({
      success: false,
      error: `Command blocked by workspace policy (${preflight.category}). Update Terminal permissions in Settings.`,
      operation: "run_command",
    });
  }
  return null;
}

function shouldSkipPermissionWaitForRunCommand(
  command: string,
  appId: number | null | undefined,
  chatId: number,
  sender: Electron.WebContents,
): boolean {
  const preflight = runCommandCategoryPreflight(command, appId);
  if (preflight.type === "auto_allow") {
    emitRunCommandPermissionActivity(
      sender,
      chatId,
      `run_command auto-approved (${preflight.category})`,
      command,
    );
    return true;
  }
  return false;
}

function enrichRunCommandPermissionRequest<T extends { operation: string; preview: unknown }>(
  permRequest: T,
  appId: number | null | undefined,
): T {
  if (permRequest.operation !== "run_command") return permRequest;
  const preview = permRequest.preview as { command?: string; isDangerous?: boolean };
  const preflight = runCommandCategoryPreflight(preview.command ?? "", appId);
  const dangerous =
    preflight.type === "prompt" ? preflight.dangerous : false;
  return {
    ...permRequest,
    preview: {
      ...preview,
      commandCategory: preflight.category,
      isDangerous: dangerous || preview.isDangerous,
      canAlwaysAllow: preflight.type === "prompt" && !preflight.dangerous,
    },
  } as T;
}

function sentryAddBreadcrumbSafe(
  breadcrumb: Parameters<typeof Sentry.addBreadcrumb>[0],
): void {
  try {
    Sentry.addBreadcrumb(breadcrumb);
  } catch {
    /* noop */
  }
}

function sentryCaptureExceptionSafe(
  error: unknown,
  captureContext?: Parameters<typeof Sentry.captureException>[1],
): void {
  try {
    Sentry.captureException(error, captureContext);
  } catch {
    /* noop */
  }
}

// v4.0 Progressive Tool Reveal: one loader per chat session
const toolSessionLoaders = new Map<number, ToolSessionLoader>();
function getOrCreateToolSessionLoader(chatId: number): ToolSessionLoader {
  let loader = toolSessionLoaders.get(chatId);
  if (!loader) {
    loader = new ToolSessionLoader((name) => ToolRegistry.get(name));
    toolSessionLoaders.set(chatId, loader);
  }
  return loader;
}

// Legacy: Ask->Build approval wait (unused on request_mode_change tool path; respond-mode-change may still resolve)
const pendingModeChangeResolvers = new Map<
  number,
  { finish: (approved: boolean) => void }
>();

export function resolveModeChange(chatId: number, approve: boolean): void {
  const r = pendingModeChangeResolvers.get(chatId);
  if (r) {
    r.finish(approve);
  }
}

/** Abort reason when the task ledger shows all steps done — not a user cancel. */
const TASK_COMPLETE_STREAM_STOP = "task_complete";

async function maybeAppendAutoMemoryAfterStream(params: {
  settings: UserSettings;
  appPath: string | undefined;
  chatId: number;
  isEphemeralWorkspace: boolean;
  streamTurnIdForLedger: string;
  isBuildModeTurn: boolean;
  sender: WebContents;
}): Promise<void> {
  const {
    settings,
    appPath,
    chatId,
    isEphemeralWorkspace,
    streamTurnIdForLedger,
    isBuildModeTurn,
    sender,
  } = params;
  try {
    if (isEphemeralWorkspace || chatId < 0 || !appPath) return;
    if (settings.autoMemory?.enabled === false) return;
    if (settings.autoMemory?.writeToFile === false) return;
    if (!isBuildModeTurn) return;
    const ledger = getLedger(streamTurnIdForLedger);
    const files = [
      ...new Set(ledger?.steps.flatMap((s) => s.filesWritten ?? []) ?? []),
    ].filter(Boolean);
    if (files.length === 0) return;
    const minConf = settings.autoMemory?.minConfidence ?? 0.7;
    const confidence = 0.85;
    const toolsUsed = getToolsUsedThisTurn(streamTurnIdForLedger);
    const { appendAutoMemoryIfEligible } = await import("@/lib/memory/auto-memory");
    const summary = `Wrote ${files.length} file(s): ${files.slice(0, 5).join(", ")}${files.length > 5 ? "…" : ""}`;
    const ok = await appendAutoMemoryIfEligible({
      workspacePath: appPath,
      chatId,
      toolsUsed,
      summary,
      confidence,
      minConfidence: minConf,
      // Earlier guard returns when `writeToFile === false`; here only enabled / default-on remains.
      writeToFile: settings.autoMemory?.writeToFile ?? true,
    });
    if (ok) {
      safeSend(sender, "chat:activity", {
        id: `memory-saved-${Date.now()}`,
        type: "memory_saved",
        label: "Auto memory",
        status: "done",
        timestamp: Date.now(),
        chatId,
        detail: "Appended to .atlarix/ATLARIX.md",
      });
    }
  } catch (e) {
    logger.warn("[auto-memory] skipped:", e);
  } finally {
    clearToolsUsedForTurn(streamTurnIdForLedger);
  }
}

/**
 * Parallel reviewer + debugger after autonomous <task_complete> when files were written.
 * Callers must **not** await this before `chat:response:end` — fire-and-forget so the next
 * user message is not queued behind verification. Results surface via `chat:activity`
 * (`build_verification_complete`).
 */
async function runAutonomousBuildVerificationAfterTaskComplete(params: {
  sender: WebContents;
  chatId: number;
  streamStopWasTaskComplete: boolean;
  agentMode: string | undefined;
  appPath: string | undefined;
  workspaceId: number | undefined;
  streamTurnIdForLedger: string;
  rootAssistantMessageId: number;
  isEphemeralWorkspace: boolean;
  settings: UserSettings;
}): Promise<void> {
  const {
    sender,
    chatId,
    streamStopWasTaskComplete,
    appPath,
    workspaceId,
    streamTurnIdForLedger,
    rootAssistantMessageId,
    isEphemeralWorkspace,
    settings,
  } = params;
  if (!streamStopWasTaskComplete || !appPath || chatId < 0 || isEphemeralWorkspace) {
    return;
  }
  if (settings.buildVerification?.enabled === false) return;

  const ledger = getLedger(streamTurnIdForLedger);
  const filesWritten = [...new Set(ledger?.steps.flatMap((s) => s.filesWritten ?? []) ?? [])].filter(
    Boolean,
  );
  if (filesWritten.length === 0) return;

  try {
    const { runAgentsInParallel, buildParallelContext } = await import(
      "../../lib/agents/parallel-runner"
    );
    const { enqueueSyntheticFollowUpIfUnderCap } = await import("./self_correction_followup");
    const results = await runAgentsInParallel(
      [
        {
          agentId: "reviewer",
          task: `Review these files for correctness and quality: ${filesWritten.join(", ")}`,
          turnId: streamTurnIdForLedger,
          depth: 1,
          chatId,
          workspacePath: appPath,
          workspaceId,
          recordOnParentLedger: false,
        },
        {
          agentId: "debugger",
          task: `Check these files for errors or issues: ${filesWritten.join(", ")}`,
          turnId: streamTurnIdForLedger,
          depth: 1,
          chatId,
          workspacePath: appPath,
          workspaceId,
          recordOnParentLedger: false,
        },
      ],
      120_000,
    );
    const combined = buildParallelContext(results);
    const blob = combined.toLowerCase();
    const hasIssues =
      /\b(issue|issues|fail|failed|failure|error|errors|bug|critical|blocker|problem|problems)\b/.test(
        blob,
      ) || results.some((r) => !r.success);

    captureSafe("autonomous_build_verification_run", {
      files_written_count: filesWritten.length,
      has_issues: hasIssues,
    });

    const verifyDetail = hasIssues
      ? "Review + debug complete — issues found. See follow-up message for details."
      : "Review + debug complete — no issues found.";
    safeSend(sender, "chat:activity", {
      id: `build-verify-${Date.now()}`,
      type: "build_verification_complete",
      label: "Build verification (review + debug)",
      status: "done",
      timestamp: Date.now(),
      chatId,
      detail: verifyDetail,
    });

    if (hasIssues) {
      await enqueueSyntheticFollowUpIfUnderCap({
        webContents: sender,
        chatId,
        rootAssistantMessageId,
        content: `Review and debug pass found issues:\n\n${combined.slice(0, 12_000)}\n\nAddress these before considering the task complete.`,
        label: "build verification",
      });
    }
  } catch (e) {
    logger.warn("[build-verify] parallel review/debug failed:", e);
    if (appPath && !isEphemeralWorkspace) {
      sentryCaptureExceptionSafe(e, { tags: { feature: "build_verify" } });
    }
  }
}

/**
 * FIX 6: Build an `emitActivity` callback for `runMidLoopCompaction` that
 * (a) forwards the original `type: "background"` payload (keeps the existing
 * token-bar pulse working via `useCompactionTokenVisuals`) AND (b) mirrors
 * the running/done lifecycle as a `type: "compaction"` event with the
 * banner-friendly label that `CompactionProgressStrip` listens for.
 *
 * The compaction-typed event is intentionally NOT routed through
 * `chat-activity-normalize.ts` — the banner subscribes to raw IPC like
 * `SummarizationProgressStrip` does, so the un-normalized event is fine.
 */
function emitCompactionMirroredActivity(
  sender: IpcMainInvokeEvent["sender"],
  chatId: number,
): (payload: {
  id: string;
  type: string;
  label: string;
  status: "running" | "done";
  detail?: string;
  timestamp: number;
  chatId: number;
}) => void {
  return (payload) => {
    safeSend(sender, "chat:activity", payload);
    if (
      payload.type === "background" &&
      payload.label === "Summarizing in-task context"
    ) {
      safeSend(sender, "chat:activity", {
        id: `${payload.id}-banner`,
        type: "compaction",
        status: payload.status,
        label:
          payload.status === "running"
            ? "Compressing context to continue..."
            : "Context compressed — continuing task",
        timestamp: Date.now(),
        chatId,
        detail: payload.detail,
      });
    }
  };
}

/** Per `chat:stream` invocation — duplicate tool collapse + hard per-tool cap. */
type ToolTurnDedupState = {
  dedupeByKey: Map<string, unknown>;
  callCountByTool: Map<string, number>;
};

const TOOL_DEDUP_EXEMPT = new Set(["ask_user", "stream_terminal_output"]);

/** Max distinct invocations per tool per `chat:stream` turn (exact duplicates are skipped earlier and do not count). */
const TOOL_CALL_CAP_READ = 20;
const TOOL_CALL_CAP_WRITE = 10;

const TOOL_NAMES_CAP_READ_20 = new Set([
  "read_file",
  "search",
  "find_file",
  "list_files",
  "get_file_outline",
  "explore_folder",
  "get_repo_overview",
  "get_blueprint",
]);

const TOOL_NAMES_CAP_WRITE_10 = new Set([
  "write_file",
  "edit_file",
  "write_multiple_files",
  "run_command",
  "write_implementation_plan",
]);

function perTurnCallCapForTool(toolName: string): number {
  if (TOOL_NAMES_CAP_READ_20.has(toolName)) return TOOL_CALL_CAP_READ;
  if (TOOL_NAMES_CAP_WRITE_10.has(toolName)) return TOOL_CALL_CAP_WRITE;
  return TOOL_CALL_CAP_WRITE;
}

const TOOL_CALL_LIMIT_ERROR = (toolName: string) =>
  JSON.stringify({
    success: false,
    error: `Per-turn call limit reached for ${toolName}. Summarize your findings so far and respond to the user — do not attempt more ${toolName} calls this turn.`,
  });

function stableNormalizeForToolDedup(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stableNormalizeForToolDedup);
  }
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => !k.startsWith("_"))
    .sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    out[k] = stableNormalizeForToolDedup(o[k]);
  }
  return out;
}

function hashToolArgsForDedup(executeArgs: Record<string, unknown>): string {
  const normalized = stableNormalizeForToolDedup(executeArgs) as Record<string, unknown>;
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/** Execute a tool through ToolRegistry, recording ledger updates and honoring task-complete signals. */
async function runToolExecute(
  toolName: string,
  executeArgs: Record<string, unknown>,
  sender: IpcMainInvokeEvent["sender"],
  chatId: number,
  streamOpts?: {
    turnId?: string;
    abortController?: AbortController;
    onTaskLedgerComplete?: () => void;
    /** When false, ledger "task complete" does not abort the chat stream (Ask tier). Default true. */
    abortStreamOnLedgerComplete?: boolean;
    toolTurnDedup?: ToolTurnDedupState;
  },
): Promise<unknown> {
  const maybeStopStreamForCompleteLedger = () => {
    if (!streamOpts?.turnId || !streamOpts.abortController) return;
    const L = getLedger(streamOpts.turnId);
    if (L && isLedgerTaskComplete(L)) {
      streamOpts.onTaskLedgerComplete?.();
      if (streamOpts.abortStreamOnLedgerComplete === false) return;
      try {
        streamOpts.abortController.abort(TASK_COMPLETE_STREAM_STOP);
      } catch {
        /* noop */
      }
    }
  };

  const dedup = streamOpts?.toolTurnDedup;

  // Exact-duplicate collapse first: same tool + same args does not consume the per-turn cap.
  if (dedup && !TOOL_DEDUP_EXEMPT.has(toolName)) {
    const argHashEarly = hashToolArgsForDedup(executeArgs);
    const dedupeKeyEarly = `${toolName}\0${argHashEarly}`;
    const cached = dedup.dedupeByKey.get(dedupeKeyEarly);
    if (cached !== undefined) {
      logger.warn(`[tool-dedup] Skipped duplicate call: ${toolName} (already ran this turn)`);
      if (streamOpts?.turnId) {
        recordToolUseForTurn(streamOpts.turnId, toolName);
      }
      maybeStopStreamForCompleteLedger();
      return cached;
    }
  }

  if (dedup) {
    const cap = perTurnCallCapForTool(toolName);
    const prev = dedup.callCountByTool.get(toolName) ?? 0;
    const next = prev + 1;
    dedup.callCountByTool.set(toolName, next);
    if (next > cap) {
      logger.warn(
        `[tool-dedup] Per-turn call cap exceeded for ${toolName} (cap=${cap}, chatId=${chatId})`,
      );
      if (streamOpts?.turnId) {
        recordToolUseForTurn(streamOpts.turnId, toolName);
      }
      maybeStopStreamForCompleteLedger();
      return TOOL_CALL_LIMIT_ERROR(toolName);
    }
  }

  // MCP auth-and-retry: let mcp_call pause for the user to authenticate, then retry.
  if (toolName === "mcp_call") {
    executeArgs._mcpInvocationContext = {
      requireAuth: (info: RequireMcpAuthInfo) => requireMcpAuth(sender, info),
    };
  }

  const result: unknown = await ToolRegistry.execute(toolName, executeArgs);
  if (dedup && !TOOL_DEDUP_EXEMPT.has(toolName)) {
    const argHash = hashToolArgsForDedup(executeArgs);
    const dedupeKey = `${toolName}\0${argHash}`;
    dedup.dedupeByKey.set(dedupeKey, result);
  }
  if (streamOpts?.turnId) {
    recordToolUseForTurn(streamOpts.turnId, toolName);
  }
  maybeStopStreamForCompleteLedger();
  return result;
}

/** Optional callback injected into `search` so the UI shows resolved engine (text / semantic-lite / etc.). */
function attachSearchRoutingActivity(
  execArgs: Record<string, unknown>,
  sender: IpcMainInvokeEvent["sender"],
  chatId: number,
) {
  execArgs._onSearchRouting = (detail: string) => {
    safeSend(sender, "chat:activity", {
      id: `search-route-${chatId}-${Date.now()}`,
      type: "tool_use",
      label: "Search",
      detail,
      status: "done",
      timestamp: Date.now(),
      chatId,
    });
  };
}

async function resolveAskUserToolResult(
  event: IpcMainInvokeEvent,
  chatId: number,
  toolName: string,
  result: unknown,
  hooks?: { finalizeAskUserBreakpoint?: () => void | Promise<void> },
): Promise<string | null> {
  if (toolName !== "ask_user") return null;
  // Accept the marker both raw and nested inside a registry success envelope
  // (`{ success, result: { __ask_user } }`) — defensive against wrappers.
  let marker = result;
  if (
    marker &&
    typeof marker === "object" &&
    (marker as { __ask_user?: boolean }).__ask_user !== true &&
    (marker as { result?: unknown }).result &&
    typeof (marker as { result?: unknown }).result === "object" &&
    ((marker as { result: { __ask_user?: boolean } }).result.__ask_user === true)
  ) {
    marker = (marker as { result: unknown }).result;
  }
  if (!marker || typeof marker !== "object" || (marker as { __ask_user?: boolean }).__ask_user !== true) {
    return null;
  }
  const q = marker as {
    question: string;
    options?: string[];
    questions?: Array<{ question: string; options?: string[] }>;
  };
  // v10.1: one ask_user call can carry several questions; the stream pauses
  // until the user answers ALL of them in the inline card.
  const questions =
    Array.isArray(q.questions) && q.questions.length > 0
      ? q.questions
      : [
          {
            question: q.question ?? "",
            ...(Array.isArray(q.options) && q.options.length > 0
              ? { options: q.options }
              : {}),
          },
        ];
  const { waitForUserQuestionAnswer } = await import("./user_question_wait");
  await hooks?.finalizeAskUserBreakpoint?.();
  const questionId = `uq_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  safeSend(event.sender, "user-question-request", {
    chatId,
    questionId,
    question: questions[0].question,
    options: questions[0].options,
    questions,
  });
  logger.log(
    `[ask_user] Waiting for UI answer (${questionId}, ${questions.length} question(s))`,
  );
  const answer = await waitForUserQuestionAnswer(chatId, questionId, 30 * 60 * 1000);
  // The UI submits a readable combined "Q → A" string (single answers come
  // back as plain text). Include the questions so the tool card shows Q + A.
  return JSON.stringify({
    success: true,
    questions: questions.map((it) => it.question),
    answer,
  });
}

/** Agentic loop completion: explicit model tag only (no inferred prose). */
function isTaskComplete(response: string): boolean {
  return response.includes("<task_complete>");
}

// Track active streams for cancellation
const activeStreams = new Map<number, AbortController>();

/** Clear skill file cache when switching workspace (see `loadSkill`). */
let lastSkillCacheAppId: number | undefined;

// Track partial responses for cancelled streams
const partialResponses = new Map<number, string>();

/** DB: assistant placeholder row receiving post–ask_user continuation (for ordering injected user Q+A). */
const askUserContinuationAssistantIdByChatId = new Map<number, number>();

// ─── FIX 4: stream reconnect plumbing ──────────────────────────────────────
// Last successful `chat:stream` request per chat. Re-dispatched when the
// renderer fires `chat:stream:reconnect` after the auto-retry sequence ran
// out. Cleared on chat delete is unnecessary; entries are overwritten on the
// next normal `chat:stream` invocation for the same chatId.
const lastStreamRequest = new Map<number, ChatStreamParams>();

const RECONNECT_DELAYS_MS = [2000, 5000, 10000];

/**
 * Distinguish a network/provider mid-stream failure (worth silently retrying)
 * from a user abort or a malformed-request error (must not be retried).
 *
 * AbortError-class exceptions and `abortController.signal.aborted` already
 * short-circuit elsewhere; this helper is defensive about the message-only
 * cases the AI SDK surfaces when fetch socket dies.
 */
function isNetworkStreamError(err: unknown): boolean {
  if (!err) return false;
  if ((err as { name?: string })?.name === "AbortError") return false;
  if ((err as { name?: string })?.name === "APICallError") return true;
  const msg = String((err as { message?: unknown })?.message ?? err);
  return /terminated|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|premature close|connection (?:reset|refused|closed)|network/i.test(
    msg,
  );
}

/**
 * Thrown after the silent retry sequence exhausts itself. Carries the
 * accumulated partial response so the outer catch can include it in the
 * `chat:stream:disconnected` IPC payload — the renderer keeps it visible
 * while the user decides whether to `[Reconnect]` or `[Continue]`.
 */
class NetworkStreamDisconnectedError extends Error {
  partialResponse: string;
  constructor(partialResponse: string) {
    super("Network stream disconnected after retries");
    this.name = "NetworkStreamDisconnectedError";
    this.partialResponse = partialResponse;
  }
}


/**
 * Abort all active AI streams - call on app quit to save tokens
 */
export function abortAllStreams(): void {
  const count = activeStreams.size;
  if (count === 0) return;

  logger.log(`[Cleanup] Aborting ${count} active AI streams to save tokens...`);

  for (const [chatId, controller] of activeStreams.entries()) {
    try {
      controller.abort();
      logger.log(`[Cleanup] Aborted stream for chat ${chatId}`);
    } catch (error) {
      logger.warn(`[Cleanup] Error aborting stream ${chatId}:`, error);
    }
  }

  activeStreams.clear();
  partialResponses.clear();
  logger.log(`[Cleanup] All AI streams aborted`);
}

// Directory for storing temporary files
const TEMP_DIR = path.join(os.tmpdir(), "atlarix-attachments");

// Common helper functions
const TEXT_FILE_EXTENSIONS = [
  ".md",
  ".txt",
  ".json",
  ".csv",
  ".js",
  ".ts",
  ".html",
  ".css",
];

async function isTextFile(filePath: string): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_FILE_EXTENSIONS.includes(ext);
}

// Ensure the temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

type TierSourceTag = "user_setting" | "override" | "force_thinking";

function tierLabelForActivity(tier: string): string {
  switch (tier) {
    case "thinking":
      return "Deep-thinking tier";
    case "balanced":
      return "Balanced tier";
    case "fast":
      return "Fast tier";
    default:
      return `${tier} tier`;
  }
}

function tierDetailForActivity(args: {
  tier: string;
  source: TierSourceTag;
  providerId: string;
  modelName: string;
  reason?: string;
}): string {
  const friendlySource = (() => {
    switch (args.source) {
      case "user_setting":
        return "manual model selection";
      case "override":
        return "per-turn override";
      case "force_thinking":
        return "force-thinking opt-in";
      default:
        return args.source;
    }
  })();
  const base = `${args.providerId}/${args.modelName} · source: ${friendlySource}`;
  return args.reason ? `${base} · ${args.reason}` : base;
}

/** Full snapshot revert + ledger cancel + message `isReverted` flags + blueprint (via `revertSnapshot` or partial files + sync). */
async function performFullRevert(params: {
  chatId: number;
  turnId: string;
  assistantMessageId: number;
  workspacePath: string;
  workspaceId: number;
  options?: {
    /** Only restore these workspace-relative paths from the turn snapshot (no full diagram rollback). */
    filesFilter?: string[];
    /** Skip isReverted / hasAnsweredQuestions updates (e.g. autonomous single-file revert). */
    skipMessageFlags?: boolean;
  };
}): Promise<{
  success: boolean;
  error?: string;
  restoredFiles?: number;
}> {
  const { chatId, turnId, assistantMessageId, workspacePath } =
    params;
  const skipMessageFlags = params.options?.skipMessageFlags ?? false;
  const filesFilter = params.options?.filesFilter;

  const snap =
    filesFilter != null && filesFilter.length > 0
      ? await revertSnapshotFiles({
          workspacePath,
          turnId,
          relativePaths: filesFilter,
        })
      : await revertSnapshot({
          workspacePath,
          turnId,
        });
  if (!snap.success) {
    logger.warn("performFullRevert: snapshot restore failed:", snap.error);
  }
  await cancelLedger(turnId);

  if (skipMessageFlags) {
    return {
      success: snap.success,
      error: snap.error,
      restoredFiles: snap.restoredFiles,
    };
  }

  const ec = getEphemeralChat(chatId);
  if (ec) {
    const idx = ec.messages.findIndex((m) => m.id === assistantMessageId);
    if (idx < 0) {
      return {
        success: false,
        error: "Message not in chat",
        restoredFiles: snap.restoredFiles,
      };
    }
    ec.messages = ec.messages.map((m, i) => ({
      ...m,
      isReverted: i >= idx ? true : false,
    }));
  }

  return {
    success: snap.success,
    error: snap.error,
    restoredFiles: snap.restoredFiles,
  };
}

function queuePostTurnSelfCorrection(
  sender: WebContents,
  args: {
    chatId: number;
    rootAssistantMessageId: number;
    appId: number | undefined;
    appPath: string;
    filesWrittenInThisExchange: string[];
    isBuildModeTurn: boolean;
    isEphemeralWorkspace: boolean;
    aborted: boolean;
  },
): void {
  setImmediate(() => {
    void import("./self_correction_followup")
      .then(({ schedulePostTurnSelfCorrection }) =>
        schedulePostTurnSelfCorrection({
          webContents: sender,
          chatId: args.chatId,
          rootAssistantMessageId: args.rootAssistantMessageId,
          appId: args.appId,
          appPathResolved: args.appPath,
          filesWrittenInThisExchange: args.filesWrittenInThisExchange,
          isBuildModeTurn: args.isBuildModeTurn,
          isEphemeralWorkspace: args.isEphemeralWorkspace,
          aborted: args.aborted,
          isStreamActive: () => activeStreams.has(args.chatId),
        }),
      )
      .catch((e) => logger.warn("[self-correction] queue failed", e));
  });
}

export function registerChatStreamHandlers() {
  ipcMain.handle(
    "respond-mode-change",
    async (
      _event,
      payload: { chatId: number; approve: boolean; requestedMode?: string }
    ): Promise<{ ok: boolean }> => {
      const { chatId, approve, requestedMode } = payload;
      resolveModeChange(chatId, approve);
      if (approve) {
        const mode = (requestedMode ?? "build") as WorkMode;
        writeSettings(settingsPatchForWorkMode(mode));
      }
      return { ok: true };
    }
  );

  ipcMain.handle(
    "chat:submit-user-question-answer",
    async (
      event,
      payload: { chatId: number; questionId: string; answer: string; questionText: string },
    ): Promise<{ success: boolean }> => {
      const { formatInteractiveQaLine } = await import("../../lib/interactive-qa-format");
      const {
        isEphemeralChatId,
        getEphemeralChat,
        insertAskUserAnswerUserMessage,
        chatOnlyStreamingAssistantDraftByChatId,
      } = await import("@/lib/ephemeral-chat");
      const { resolveUserQuestionAnswer } = await import("./user_question_wait");

      const ok = resolveUserQuestionAnswer(payload.chatId, payload.questionId, payload.answer);
      if (!ok) return { success: false };

      const content = formatInteractiveQaLine(payload.questionText, payload.answer);

      if (isEphemeralChatId(payload.chatId)) {
        if (!insertAskUserAnswerUserMessage(payload.chatId, content)) {
          return { success: false };
        }
        const chat = getEphemeralChat(payload.chatId);
        const tail =
          chatOnlyStreamingAssistantDraftByChatId.get(payload.chatId) ??
          partialResponses.get(payload.chatId) ??
          "";
        safeSend(event.sender, "chat:response:chunk", {
          chatId: payload.chatId,
          messages: [
            ...(chat?.messages ?? []),
            ...(tail
              ? [
                  {
                    id: -1,
                    chatId: payload.chatId,
                    role: "assistant" as const,
                    content: tail,
                    createdAt: new Date(),
                  },
                ]
              : []),
          ],
        });
        return { success: true };
      }

      return { success: false };
    },
  );

  ipcMain.handle("workspace:prewarm-cache", async (_event, workspacePath: string) => {
    const { prewarmWorkspaceCache } = await import("./chat_stream/workspace-context");
    await prewarmWorkspaceCache(workspacePath);
    return { ok: true };
  });

  const chatStreamHandler = async (
    event: Electron.IpcMainInvokeEvent,
    req: ChatStreamParams,
  ) => {
    const abortController = new AbortController();
    activeStreams.set(req.chatId, abortController);
    askUserContinuationAssistantIdByChatId.delete(req.chatId);
    // FIX 4: remember this request so the renderer's [Reconnect] button can
    // re-dispatch the exact same turn via `chat:stream:reconnect`.
    lastStreamRequest.set(req.chatId, req);

    const runStream = async () => {
      let stopAgentOrchestrator: (() => void) | undefined;
      let streamTerminated = false;
      const toolTurnDedupState: ToolTurnDedupState = {
        dedupeByKey: new Map<string, unknown>(),
        callCountByTool: new Map<string, number>(),
      };
      const ensureTerminal = (error?: unknown) => {
        if (streamTerminated) return;
        streamTerminated = true;
        if (error) {
          safeSend(event.sender, "chat:response:error", {
            chatId: req.chatId,
            error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${String((error as any)?.message ?? error)}`,
          });
        }
        safeSend(event.sender, "chat:response:end", {
          chatId: req.chatId,
          updatedFiles: false,
          hadToolCallsOrPermissions: false,
        } satisfies ChatResponseEnd);
        activeStreams.delete(req.chatId);
      };

      /** Stream stall watchdog — aborts hung provider streams after 45s silence. */
      let streamStallNotified = false;
      const handleStreamStall = () => {
        if (streamStallNotified) return;
        streamStallNotified = true;
        logger.warn(`[stream] Stall detected for chat ${req.chatId}`);
        safeSend(event.sender, "chat:activity", {
          id: `stream-stall-${req.chatId}-${Date.now()}`,
          type: "stream_stall_aborted",
          label: "Stream stalled",
          detail:
            "The model stopped responding mid-stream. Retry the message or switch models.",
          status: "error",
          timestamp: Date.now(),
          chatId: req.chatId,
        });
      };

      const streamDebugLogging = isStreamDebugLoggingEnabled();
      let lastToolInputPhaseLabel = "";
      const handleToolInputProgress = ({
        toolName,
        deltaCount,
      }: {
        toolName: string;
        deltaCount: number;
      }) => {
        const label = `${getToolActivityLabel(toolName).replace(/…$/u, "")} (${deltaCount} chunks)…`;
        if (label === lastToolInputPhaseLabel) return;
        lastToolInputPhaseLabel = label;
        safeSend(event.sender, "chat:stream:phase", {
          chatId: req.chatId,
          phase: "thinking",
          label,
        });
      };
      const handleStreamActivityPulse = () => {
        safeSend(event.sender, "chat:stream:pulse", {
          chatId: req.chatId,
          timestamp: Date.now(),
        });
      };

      try {
        try {
          await requireAuthSession();
        } catch (e) {
          if (e instanceof AuthRequiredError) {
            safeSend(event.sender, "chat:response:error", {
              chatId: req.chatId,
              error: formatAuthRequiredIpcError(),
            });
            safeSend(event.sender, "chat:response:end", {
              chatId: req.chatId,
              updatedFiles: false,
              hadToolCallsOrPermissions: false,
            } satisfies ChatResponseEnd);
            activeStreams.delete(req.chatId);
            return;
          }
          throw e;
        }

        try {
          if (!req.continueAfterQuestions) {
            req.prompt = prepareUserChatTurnInput(req.prompt);
          }
        } catch (e) {
          if (e instanceof ChatPromptSafetyError) {
            safeSend(event.sender, "chat:response:error", {
              chatId: req.chatId,
              error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${SAFETY_FILTER_BLOCKED_MESSAGE}`,
            });
            safeSend(event.sender, "chat:response:end", {
              chatId: req.chatId,
              updatedFiles: false,
              hadToolCallsOrPermissions: false,
            } satisfies ChatResponseEnd);
            activeStreams.delete(req.chatId);
            return;
          }
          if (e instanceof Error && /maximum length|Invalid prompt/i.test(e.message)) {
            safeSend(event.sender, "chat:response:error", {
              chatId: req.chatId,
              error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${e.message}`,
            });
            safeSend(event.sender, "chat:response:end", {
              chatId: req.chatId,
              updatedFiles: false,
              hadToolCallsOrPermissions: false,
            } satisfies ChatResponseEnd);
            activeStreams.delete(req.chatId);
            return;
          }
          throw e;
        }

        // Fix: Finding 4 — immediate feedback while context/model loads
        safeSend(event.sender, "chat:stream:phase", {
          chatId: req.chatId,
          phase: "thinking",
          label: "Thinking…",
        });

        const fileUploadsState = FileUploadsState.getInstance();
        let engineRequestId: string | undefined;
        let hadToolCallsOrPermissions = false;
        const { isEphemeralChatId, getEphemeralChatAppId } = await import("@/lib/ephemeral-chat");

        if (!isEphemeralChatId(req.chatId)) {
          const legacyMsg =
            "Legacy database chats were removed. Open a workspace session from the sidebar.";
          logger.warn(`Chat ${req.chatId} rejected: legacy positive chat id`);
          safeSend(event.sender, "chat:response:error", {
            chatId: req.chatId,
            error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${legacyMsg}`,
          });
          safeSend(event.sender, "chat:response:end", {
            chatId: req.chatId,
            updatedFiles: false,
            hadToolCallsOrPermissions: false,
          } satisfies ChatResponseEnd);
          streamTerminated = true;
          return;
        }

        if (isEphemeralChatId(req.chatId)) {
          // Check if this ephemeral chat is associated with a workspace
          const ephemeralAppId = getEphemeralChatAppId(req.chatId);

          if (ephemeralAppId) {
            logger.log(`Chat ${req.chatId} is ephemeral workspace chat for app: ${ephemeralAppId}`);
          } else {
            const noWorkspaceMsg =
              "Open a workspace folder to start chatting. Use Open folder on the welcome screen.";
            logger.warn(`Chat ${req.chatId} rejected: ephemeral chat without workspace`);
            safeSend(event.sender, "chat:response:error", {
              chatId: req.chatId,
              error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${noWorkspaceMsg}`,
            });
            safeSend(event.sender, "chat:response:end", {
              chatId: req.chatId,
              updatedFiles: false,
              hadToolCallsOrPermissions: false,
            } satisfies ChatResponseEnd);
            streamTerminated = true;
            return;
          }
        }

      // Get app for ephemeral workspace chats or regular DB chats
      let chat: any;
      let appData: any;

      if (isEphemeralChatId(req.chatId)) {
        // Ephemeral workspace chat - get app from DB using the stored appId
        const ephemeralAppId = getEphemeralChatAppId(req.chatId);
        const { getEphemeralChat } = await import("@/lib/ephemeral-chat");
        const ephemeralChat = getEphemeralChat(req.chatId);

        appData = await db.query.apps.findFirst({
          where: eq(apps.id, ephemeralAppId!),
        });

        if (!appData) {
          throw new Error(`App not found for ephemeral workspace chat: ${ephemeralAppId}`);
        }

        // Create a chat-like object for compatibility
        chat = {
          id: req.chatId,
          appId: ephemeralAppId,
          title: ephemeralChat?.title || "New chat",
          messages: ephemeralChat?.messages || [],
          app: appData,
          initialCommitHash: null,
          lastUsedAt: new Date(),
          hasAnsweredQuestions: false,
        };

        logger.log(`Ephemeral workspace chat loaded for app: ${appData.name} (${appData.path})`);
      }

      const { resolveOrBindWorkspaceSessionForStream } = await import(
        "./workspace_session_handlers"
      );
      req.workspaceSessionId = await resolveOrBindWorkspaceSessionForStream({
        workspaceSessionId: req.workspaceSessionId,
        chatId: req.chatId,
        workspaceAppId: chat.app?.id ?? req.appId ?? null,
      });

      if (!req.continueAfterQuestions) {
        try {
          const { parseCommandFromMessage, buildCommandPrompt } = await import(
            "@/lib/commands/custom-commands"
          );
          const { customCommands: customCommandsTable } = await import("@/db/schema");
          const { or, eq, isNull, desc } = await import("drizzle-orm");
          const appId = chat.app?.id ?? null;
          const scope =
            appId != null
              ? or(
                  isNull(customCommandsTable.workspaceId),
                  eq(customCommandsTable.workspaceId, appId),
                )
              : isNull(customCommandsTable.workspaceId);
          const cmdRows = await db
            .select()
            .from(customCommandsTable)
            .where(scope)
            .orderBy(desc(customCommandsTable.id));
          const parsed = parseCommandFromMessage(req.prompt, cmdRows);
          if (parsed) {
            const row = cmdRows.find(
              (c) => c.name.toLowerCase() === parsed.name.toLowerCase(),
            );
            if (row) {
              req.prompt = buildCommandPrompt(row.promptTemplate, parsed.rest);
              const mo = row.modeOverride?.trim().toLowerCase();
              if (mo === "ask" || mo === "agent" || mo === "build") {
                req.streamChatModeOverride = mo;
              }
            }
          }
        } catch (e) {
          logger.warn("[chat:stream] custom command expansion skipped:", e);
        }
      }

      // v3.9: Set in Build block; used when updating assistant message after stream (must be in same scope as onFinish)
      let preExchangeSnapshotId: number | null = null;
      let filesWrittenInThisExchange: string[] = [];

      if (req.redo) {
        const chatMessages = [...chat.messages];
        let lastUserMessageIndex = chatMessages.length - 1;
        while (
          lastUserMessageIndex >= 0 &&
          chatMessages[lastUserMessageIndex].role !== "user"
        ) {
          lastUserMessageIndex--;
        }
        if (lastUserMessageIndex >= 0) {
          chat.messages = chatMessages.slice(0, lastUserMessageIndex);
          const ephemeral = getEphemeralChat(req.chatId);
          if (ephemeral) {
            ephemeral.messages = chat.messages;
          }
        }
      }

      // v3.9: Continue after clarifying questions — use last user message (already updated with Q/A block)
      let userPrompt: string = "";
      if (req.continueAfterQuestions) {
        const ephemeral = getEphemeralChat(req.chatId);
        if (!ephemeral) throw new Error("Chat not found");
        const composed = buildContinueAfterQuestionsPrompt(ephemeral.messages);
        if (!composed.trim()) {
          throw new Error("Continue after questions: no user message content found");
        }
        userPrompt = prepareUserChatTurnInput(composed);
      }

      // Process attachments if any (skip when continuing after questions)
      // NOTE: Attachment *context* must not be appended to the user-visible message content.
      // We keep UI message content clean, but inject attachment info into the model prompt later.
      let attachmentInfoForModel = "";
      let attachmentPaths: string[] = [];
      let attachmentInfosForMessage: { id: string; filename: string; mimeType: string; size: number }[] = [];
      let storedFileAttachments: StoredFileAttachment[] = [];
      let pasteAttachmentsForMessage =
        req.pasteAttachments && req.pasteAttachments.length > 0
          ? ensurePasteAttachmentIds(req.pasteAttachments)
          : null;

      const mimeTypes: Record<string, string> = {
        ".pdf": "application/pdf",
        ".doc": "application/msword",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xls": "application/vnd.ms-excel",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".ppt": "application/vnd.ms-powerpoint",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".md": "text/markdown",
        ".txt": "text/plain",
        ".csv": "text/csv",
        ".json": "application/json",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
      };

      if (!req.continueAfterQuestions && req.attachments && req.attachments.length > 0) {
        // Model-only attachment directive (do not leak into user-visible bubble).
        attachmentInfoForModel =
          "\n\nFILES ATTACHED (already uploaded; do NOT ask the user to attach again):\n";

        for (const [index, attachment] of req.attachments.entries()) {
          // Generate a unique filename
          const hash =
            attachment.id ||
            crypto
              .createHash("md5")
              .update(attachment.name + Date.now())
              .digest("hex");
          const fileExtension = path.extname(attachment.name);
          const filename = `${hash}${fileExtension}`;
          const filePath = path.join(TEMP_DIR, filename);

          // Extract the base64 data (remove the data:mime/type;base64, prefix)
          const base64Data = attachment.data.split(";base64,").pop() || "";

          await writeFile(filePath, Buffer.from(base64Data, "base64"));
          attachmentPaths.push(filePath);

          // Store in AttachmentStore for read_attachment tool
          const resolvedMimeType = mimeTypes[fileExtension] || "application/octet-stream";
          const resolvedSize = Buffer.from(base64Data, "base64").length;
          AttachmentStore.add(
            await buildAttachmentRecord({
              id: hash,
              filename: attachment.name,
              mimeType: resolvedMimeType,
              base64Data,
              size: resolvedSize,
            }),
          );

          // Session-only: used by renderer to show chips/previews under the user message.
          attachmentInfosForMessage.push({
            id: hash,
            filename: attachment.name,
            mimeType: resolvedMimeType,
            size: resolvedSize,
          });
          storedFileAttachments.push({
            id: hash,
            filename: attachment.name,
            mimeType: resolvedMimeType,
            size: resolvedSize,
            data: base64Data,
          });

          if (attachment.attachmentType === "upload-to-codebase") {
            // For upload-to-codebase, create a unique file ID and store the mapping
            const fileId = `ATLARIX_ATTACHMENT_${index}`;

            fileUploadsState.addFileUpload(
              { chatId: req.chatId, fileId },
              {
                filePath,
                originalName: attachment.name,
              },
            );

            // Add instruction for AI (model-only)
            attachmentInfoForModel += `- name: "${attachment.name}" | attachmentId: ${hash} | mime: ${resolvedMimeType} | kind: upload-to-codebase | size: ${resolvedSize}\n`;
          } else {
            // For chat-context, include attachment ID and preview
            const isText = await isTextFile(filePath);
            attachmentInfoForModel += `- name: "${attachment.name}" | attachmentId: ${hash} | mime: ${resolvedMimeType} | kind: ${isText ? "text" : "binary"} | size: ${resolvedSize}\n`;

            // If it's a text-based file, include content preview
            if (isText) {
              try {
                const content = await readFile(filePath, "utf-8");
                attachmentInfoForModel += `  preview:\n  ---\n  ${content
                  .slice(0, 1500)
                  .replace(/\n/g, "\n  ")}\n  ---\n`;
              } catch (err) {
                logger.error(`Error reading file content: ${err}`);
              }
            }
          }
        }
        attachmentInfoForModel +=
          '\nMANDATORY TOOL USE:\n- If the user asks to read/summarize any attached file, you MUST call the tool `read_attachment` with the exact `attachmentId` shown above.\n- Example: read_attachment({ "attachmentId": "<id>" })\n';
      }

      if (pasteAttachmentsForMessage?.length) {
        for (const paste of pasteAttachmentsForMessage) {
          AttachmentStore.add(pasteToAttachmentData(paste));
        }
        attachmentInfoForModel += buildPasteAttachmentDirective(pasteAttachmentsForMessage);
        if (!attachmentInfoForModel.includes("MANDATORY TOOL USE")) {
          attachmentInfoForModel +=
            '\nMANDATORY TOOL USE:\n- For pasted text or terminal snippets, content is inline in the user message AND available via read_attachment using the attachmentId above.\n';
        }
      }

      // Add user message to database (skip when continueAfterQuestions).
      // Display text uses stub attachment tags; model uses full bodies in req.prompt.
      let userDisplayContent = userPrompt;
      if (!req.continueAfterQuestions) {
        userDisplayContent = req.displayPrompt ?? req.prompt;
        userPrompt = req.prompt;
      }
      const componentsToProcess = req.continueAfterQuestions ? [] : (req.selectedComponents || []);

      if (componentsToProcess.length > 0) {
        userPrompt += "\n\nSelected components:\n";
        userDisplayContent += "\n\nSelected components:\n";

        for (const component of componentsToProcess) {
          let componentSnippet = "[component snippet not available]";
          try {
            const componentFileContent = await readFile(
              path.join(resolveAppPath(chat.app.path), component.relativePath),
              "utf8",
            );
            const lines = componentFileContent.split(/\r?\n/);
            const selectedIndex = component.lineNumber - 1;

            // Let's get one line before and three after for context.
            const startIndex = Math.max(0, selectedIndex - 1);
            const endIndex = Math.min(lines.length, selectedIndex + 4);

            const snippetLines = lines.slice(startIndex, endIndex);
            const selectedLineInSnippetIndex = selectedIndex - startIndex;

            if (snippetLines[selectedLineInSnippetIndex]) {
              snippetLines[selectedLineInSnippetIndex] =
                `${snippetLines[selectedLineInSnippetIndex]} // <-- EDIT HERE`;
            }

            componentSnippet = snippetLines.join("\n");
          } catch (err) {
            logger.error(
              `Error reading selected component file content: ${err}`,
            );
          }

          const componentBlock = `\n${componentsToProcess.length > 1 ? `${componentsToProcess.indexOf(component) + 1}. ` : ""}Component: ${component.name} (file: ${component.relativePath})

Snippet:
\`\`\`
${componentSnippet}
\`\`\`
`;
          userPrompt += componentBlock;
          userDisplayContent += componentBlock;
        }
      }

      // Check if this is an ephemeral workspace chat (skip legacy chats/messages DB writes)
      const isEphemeralWorkspace = isEphemeralChatId(req.chatId);

      if (
        req.workspaceSessionId &&
        !req.continueAfterQuestions &&
        isEphemeralWorkspace
      ) {
        try {
          const { persistWorkspaceSessionUserMessage } = await import(
            "./workspace_session_handlers"
          );
          await persistWorkspaceSessionUserMessage(
            req.workspaceSessionId,
            userDisplayContent,
            {
              modelContent:
                userPrompt !== userDisplayContent ? userPrompt : null,
              pasteAttachments: pasteAttachmentsForMessage,
              fileAttachments:
                storedFileAttachments.length > 0 ? storedFileAttachments : null,
            },
          );
        } catch (err) {
          logger.error("Failed to persist workspace session user message:", err);
        }
      }

      clearDebugHypothesis(req.chatId);

      const settingsBase = readSettings();
      let settings =
        req.streamChatModeOverride != null
          ? { ...settingsBase, selectedChatMode: req.streamChatModeOverride }
          : settingsBase;
      if (req.workModeOverride) {
        const { settingsPatchForWorkMode } = await import("@/lib/work-mode");
        settings = { ...settings, ...settingsPatchForWorkMode(req.workModeOverride) };
      }
      // Generate requestId early so it can be saved with the message
      engineRequestId = uuidv4();

      // Add a placeholder assistant message immediately
      // For ephemeral chats, we'll use a placeholder ID
      let placeholderAssistantMessage: any = { id: Date.now() }; // Default for ephemeral
      let updatedChat: any = chat; // Use the existing chat object for ephemeral

      const ephemeralChat = getEphemeralChat(req.chatId);
      const existingMessages = ephemeralChat?.messages || [];

      const placeholderMessage = {
        id: Date.now() + 1,
        chatId: req.chatId,
        role: "assistant",
        content: "",
        createdAt: new Date(),
        sourceCommitHash: null,
        commitHash: null,
      };

      if (req.continueAfterQuestions) {
        updatedChat.messages = [...existingMessages, placeholderMessage];
      } else {
        const newUserMessage = {
          id: Date.now(),
          chatId: req.chatId,
          role: "user",
          content: userDisplayContent,
          modelContent:
            userPrompt !== userDisplayContent ? userPrompt : null,
          pasteAttachments:
            pasteAttachmentsForMessage && pasteAttachmentsForMessage.length > 0
              ? pasteAttachmentsForMessage
              : null,
          createdAt: new Date(),
          sourceCommitHash: null,
          commitHash: null,
          attachments:
            attachmentInfosForMessage.length > 0 ? attachmentInfosForMessage : null,
          fileAttachments:
            storedFileAttachments.length > 0 ? storedFileAttachments : null,
        };
        updatedChat.messages = [
          ...existingMessages,
          newUserMessage,
          placeholderMessage,
        ];
      }
      placeholderAssistantMessage = placeholderMessage;
      if (ephemeralChat) {
        ephemeralChat.messages = updatedChat.messages;
      }

      let streamTurnIdForLedger = String(placeholderAssistantMessage.id);
      let streamStopWasTaskComplete = false;
      const delegatedAgentsThisTurn: string[] = [];
      let delegationsStartedThisTurn = 0;
      const inFlightDelegationKeys = new Set<string>();
      const buildToolStreamOpts = () => ({
        turnId: streamTurnIdForLedger,
        abortController,
        onTaskLedgerComplete: () => {
          streamStopWasTaskComplete = true;
        },
        toolTurnDedup: toolTurnDedupState,
      });

      // Send the messages right away so that the loading state is shown for the message.
      safeSend(event.sender, "chat:response:chunk", {
        chatId: req.chatId,
        messages: updatedChat.messages,
      });

      let fullResponse = "";
      let maxTokensUsed: number | undefined;
      let maxReasoningTokensUsed: number | undefined;

      // Check if this is a test prompt
      const testResponse = getTestResponse(req.prompt);

      if (testResponse) {
        // For test prompts, use the dedicated function
        fullResponse = await streamTestResponse(
          event,
          req.chatId,
          testResponse,
          abortController,
          updatedChat,
        );
      } else {
        // Normal AI processing for non-test prompts
        const mainOptions: GetModelClientOptions = {
          agentMode: settings.agentMode ?? "direct",
          delegationRole: "main",
        };
        let effectiveModel = getEffectiveModel(settings);
        if (req.modelOverride) {
          effectiveModel = req.modelOverride;
        }
        if (effectiveModel.provider === "compass") {
          const usageForPlan = await getCompassUsageFromSupabase();
          if (usageForPlan.ok) {
            const { coerceCompassModelForPlan, subscriptionTierToPlan } =
              await import("../../lib/compass-plan-access");
            const coercedName = coerceCompassModelForPlan(
              effectiveModel.name,
              subscriptionTierToPlan(usageForPlan.tier),
            );
            if (coercedName !== effectiveModel.name) {
              effectiveModel = { ...effectiveModel, name: coercedName };
            }
          }
        }
        // `modelClient` is `let` (not destructured const) so the mid-stream
        // tier-escalation guard can rebind it when Auto-routing decides a
        // tool-heavy turn deserves `balanced` or `thinking` halfway through.
        // `isEngineEnabled` / `isSmartContextEnabled` stay tied to the initial
        // client because they encode capabilities used during system-prompt
        // assembly and would be unsafe to flip mid-turn.
        const initialModelClientBundle = await getModelClient(
          effectiveModel,
          settings,
          mainOptions,
        );
        let modelClient = initialModelClientBundle.modelClient;
        const isEngineEnabled = initialModelClientBundle.isEngineEnabled;
        const isSmartContextEnabled = initialModelClientBundle.isSmartContextEnabled;
        const forceThinkingNativeSupported =
          req.forceThinkingTier === true
            ? hasNativeDeepThinkingSupport(
                effectiveModel,
                modelClient.builtinProviderId,
                settings,
              )
            : false;

        let contextBudgetTier = resolveContextBudgetTier(effectiveModel, settings);
        if (req.forceThinkingTier === true && forceThinkingNativeSupported) {
          contextBudgetTier = "thinking";
        }

        // FIX 3: tier diagnostic log. Ephemeral workspace chats already share
        // the same resolution path as persisted chats; this log surfaces the
        // actual source so we can confirm whether any "stuck on fast" symptom
        // originates from user_setting (settings.selectedModel), auto routing,
        // an explicit override, or the forceThinking branch above.
        const tierSource: "user_setting" | "override" | "force_thinking" =
          req.forceThinkingTier === true && forceThinkingNativeSupported
            ? "force_thinking"
            : req.modelOverride
              ? "override"
              : "user_setting";
        logger.log(
          `[stream:${req.chatId}] tier=${contextBudgetTier} ` +
          `source=${tierSource} model=${effectiveModel.provider}/${effectiveModel.name} ` +
          `ephemeral=${isEphemeralWorkspace}`,
        );

        // Surface the tier decision to the UI activity log so the user can see
        // exactly why a turn used `fast` (e.g. "source=user_setting" = manual
        // selection so no auto-routing inspected the prompt). Mirrors the
        // `model_selection` shape so the renderer needs no new render code.
        safeSend(event.sender, "chat:activity", {
          id: `tier-selection-${req.chatId}-${Date.now()}`,
          type: "tier_selection",
          label: tierLabelForActivity(contextBudgetTier),
          detail: tierDetailForActivity({
            tier: contextBudgetTier,
            source: tierSource,
            providerId: effectiveModel.provider,
            modelName: effectiveModel.name,
          }),
          status: "done",
          timestamp: Date.now(),
          chatId: req.chatId,
          modelId: `${effectiveModel.provider}/${effectiveModel.name}`,
        });

        // FIX 5: log the true context window for this dispatch. The first
        // lookup per (provider, model) hits "live" (catalog fetch); subsequent
        // calls in the same process hit "cache" via the module-level memo.
        // "fallback" means the catalog had no contextWindow and we used the
        // 200K default — investigate if this fires for a model we know.
        const budgetDetail = await getContextWindowDetailed(effectiveModel, req.chatId);
        logger.log(
          `[budget] model=${effectiveModel.provider}/${effectiveModel.name} ` +
          `contextWindow=${budgetDetail.contextWindow} source=${budgetDetail.source}`,
        );

        const suppressNativeThinkingForDeepCounsel =
          req.forceThinkingTier === true && !forceThinkingNativeSupported;
        const usedCompassThisStream = modelClient.builtinProviderId === "compass";
        let compassStreamTier: string | undefined;
        let compassStreamTokens: number | undefined;

        if (modelClient.builtinProviderId === "compass") {
          const usagePre = await getCompassUsageFromSupabase();
          if (usagePre.ok) {
            if (usagePre.tier) {
              compassStreamTier = usagePre.tier;
            }
          }
          if (
            usagePre.ok &&
            usagePre.monthlyLimit > 0 &&
            usagePre.tokensUsedThisMonth >= usagePre.monthlyLimit
          ) {
            safeSend(event.sender, "chat:response:error", {
              chatId: req.chatId,
              error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${compassExhaustedUserMessage(usagePre.tier)}`,
            });
            activeStreams.delete(req.chatId);
            return;
          }
        }

        // Workspace: use chat's linked app, or req.appId only when the chat has no app
        // (client binds appId on first stream — no mid-chat sidebar override).
        let effectiveApp = updatedChat.app;
        if (!effectiveApp && req.appId != null) {
          const boundApp = await db.query.apps.findFirst({
            where: eq(apps.id, req.appId),
          });
          if (boundApp) effectiveApp = boundApp;
        }
        const hasWorkspace = !!effectiveApp;
        let appPath = effectiveApp?.path ? resolveAppPath(effectiveApp.path) : "";
        const effectiveAppId = effectiveApp?.id;
        if (effectiveAppId !== lastSkillCacheAppId) {
          lastSkillCacheAppId = effectiveAppId;
          void import("@/lib/skills/skill-loader")
            .then((m) => m.clearSkillCache())
            .catch(() => {});
        }
        logger.log(
          `Using workspace for chat ${req.chatId}: ${appPath || "(none)"} (appId: ${effectiveAppId ?? req.appId ?? "n/a"})`,
        );
        if (hasWorkspace && appPath && !fs.existsSync(appPath)) {
          logger.warn(`Workspace path does not exist on disk: ${appPath}`);
          safeSend(event.sender, "chat:activity", {
            id: `workspace-path-missing-${req.chatId}`,
            type: "orchestrator_blocker",
            label: "Workspace folder not found",
            status: "error",
            timestamp: Date.now(),
            detail: `The project path does not exist on disk: ${appPath}. Re-open the folder or re-clone the repository.`,
            chatId: req.chatId,
          });
        }

        let codebaseInfo = "";
        let files: any[] = [];

        if (hasWorkspace) {
          // PASS1: Blueprint/Diagram context is now tool-driven only.
          // The model calls get_blueprint / query_blueprint (and other tools) to fetch this on demand.
          // Do not re-enable proactive injection.

          // Note: files array kept for backward compatibility with selected components
          // but no longer used for full codebase dump
          files = [];
          codebaseInfo = ""; // Diagram context injected via systemPrompt instead

          // For smart context and selected components, we will mark the selected components' files as focused.
          // This means that we don't do the regular smart context handling, but we'll allow fetching
          // additional files through <atlarix-read> as needed.
          if (
            isSmartContextEnabled &&
            req.selectedComponents &&
            req.selectedComponents.length > 0
          ) {
            const selectedPaths = new Set(
              req.selectedComponents.map((component) => component.relativePath),
            );
            for (const file of files) {
              if (selectedPaths.has(file.path)) {
                file.focused = true;
              }
            }
          }
        }

        // Parse app mentions from the prompt
        const mentionedAppNames = parseAppMentions(req.prompt);

        // Extract codebases for mentioned apps
        const mentionedAppsCodebases = await extractMentionedAppsCodebases(
          mentionedAppNames,
          effectiveAppId ?? 0, // Exclude current effective app
        );

        const isDeepContextEnabled =
          isEngineEnabled &&
          settings.enableProSmartFilesContextMode &&
          // Anything besides balanced will use deep context.
          settings.proSmartContextOption !== "balanced" &&
          mentionedAppsCodebases.length === 0;
        logger.log(`isDeepContextEnabled: ${isDeepContextEnabled}`);

        // Combine current app codebase with mentioned apps' codebases
        let otherAppsCodebaseInfo = "";
        if (mentionedAppsCodebases.length > 0) {
          const mentionedAppsSection = mentionedAppsCodebases
            .map(
              ({ appName, codebaseInfo }) =>
                `\n\n=== Referenced App: ${appName} ===\n${codebaseInfo}`,
            )
            .join("");

          otherAppsCodebaseInfo = mentionedAppsSection;

          logger.log(
            `Added ${mentionedAppsCodebases.length} mentioned app codebases`,
          );
        }

        if (hasWorkspace) {
          logger.log(`Extracted codebase information from ${appPath}`);
          logger.log(
            "codebaseInfo: length",
            codebaseInfo.length,
            "estimated tokens",
            codebaseInfo.length / 4,
          );

          // Prepare message history for the AI
          // Note: For ephemeral messages, sourceCommitHash and commitHash may be undefined
          // We only include them if they have actual values to avoid confusing the AI SDK
          type Msg = { role: string; content?: string; sourceCommitHash?: string; commitHash?: string };
          const messageHistory = updatedChat.messages.map((message: Msg & { modelContent?: string | null }) => {
            const content =
              message.role === "user"
                ? (message.modelContent ?? message.content ?? "")
                : (message.content || "");
            const baseMessage: { role: "user" | "assistant" | "system"; content: string } = {
              role: message.role as "user" | "assistant" | "system",
              content,
            };

            // Only include commit hash fields if they're defined (DB messages have them, ephemeral don't)
            // These are used for Atlarix Pro engine features
            const commitFields: { sourceCommitHash?: string; commitHash?: string } = {};
            if (message.sourceCommitHash) {
              commitFields.sourceCommitHash = message.sourceCommitHash;
            }
            if (message.commitHash) {
              commitFields.commitHash = message.commitHash;
            }

            return { ...baseMessage, ...commitFields };
          });

          logger.log(
            `[stream:${req.chatId}] Prepared message history (len=${messageHistory.length}, ephemeral=${isEphemeralWorkspace})`,
          );

          // Phase 6: Context bar + auto-summarize OR fallback to turn truncation
          const useAutoSummarize =
            settings.enableContextAutoSummarize !== false &&
            req.chatId > 0 &&
            !isEphemeralWorkspace;

          let limitedMessageHistory = messageHistory;
          let contextSummaryForSystem: string | null = null;

          // Next-message auto-summarize.
          // - Mid-turn pressure is handled by `compactAgenticMessagesIfNeeded` inside
          //   the SMART AGENTIC TOOL LOOP (see below), so this path only fires when
          //   the user's *new* turn would otherwise blow the per-tier budget.
          // - The `compress_context` tool remains as the model-triggered escape hatch.
          // - Gated by `useAutoSummarize` so ephemeral / opted-out users skip it.
          // Honors the TokenBar UI copy that says "auto-summarize will run on next message".
          if (useAutoSummarize) {
            const msgList = updatedChat.messages as {
              id: number;
              role: string;
              content: string;
              modelContent?: string | null;
            }[];

            // Check for existing summary
            const existingSummary = (await getContextSummary(req.chatId)) as any;
            if (existingSummary) {
              contextSummaryForSystem = existingSummary.summaryText;
              const afterSummary = msgList.filter((m) => m.id > existingSummary.lastMessageId);
              limitedMessageHistory = afterSummary.map((m) => ({
                role: m.role as "user" | "assistant" | "system",
                content:
                  m.role === "user"
                    ? (m.modelContent ?? m.content ?? "")
                    : (m.content ?? ""),
              }));
              logger.log(
                `Using context summary + ${afterSummary.length} messages (after msg ${existingSummary.lastMessageId})`,
              );
            }
            // Token-percent compaction (55% / 75% / 90%) runs later against
            // `resolveModelContextLimit` + full dispatch estimate — not here.
          }

          logger.log(
            `[stream:${req.chatId}] limitedMessageHistory len=${limitedMessageHistory.length} autoSummarize=${useAutoSummarize} hasSummary=${Boolean(contextSummaryForSystem)}`,
          );

          // Fallback: turn-based truncation (when auto-summarize off or for ephemeral)
          if (!useAutoSummarize) {
            const maxChatTurns = isDeepContextEnabled
              ? 201
              : (settings.maxChatTurnsInContext || MAX_CHAT_TURNS_IN_CONTEXT) + 1;

            if (messageHistory.length > maxChatTurns * 2) {
              let recentMessages = messageHistory
                .filter((msg: Msg) => msg.role !== "system")
                .slice(-maxChatTurns * 2);

              if (recentMessages.length > 0 && recentMessages[0].role !== "user") {
                const firstUserIndex = recentMessages.findIndex((msg: Msg) => msg.role === "user");
                if (firstUserIndex > 0) {
                  recentMessages = recentMessages.slice(firstUserIndex);
                } else if (firstUserIndex === -1) {
                  recentMessages = [];
                }
              }
              limitedMessageHistory = [...recentMessages];
              logger.log(
                `Limiting chat history from ${messageHistory.length} to ${limitedMessageHistory.length} messages (max ${maxChatTurns} turns)`,
              );
            }
          }

          const contextSize = await getContextWindow(effectiveModel, req.chatId);
          const chatMode: "ask" | "build" =
            settings.selectedChatMode === "agent"
              ? "build"
              : (settings.selectedChatMode === "ask" || settings.selectedChatMode === "build" ? settings.selectedChatMode : "ask");

          // PASS8 A2: effectiveWorkMode = UI work mode (ask|plan|build|debug|review).
          // Manual mode picker sets workModePreference; Auto intent maps to ask|build only.
          const effectiveWorkMode: WorkMode = resolveEffectiveWorkMode({
            workModeOverride: req.workModeOverride,
            intentMode: settings.intentMode,
            workModePreference: settings.workModePreference,
            selectedChatMode: settings.selectedChatMode ?? "ask",
          });
          // Streams must always carry the active mode — never fall through to
          // the legacy all-modes block (the model should only see its own mode).
          const modeBlockKey: ModeSystemKey =
            (effectiveWorkMode === "ask" ||
              effectiveWorkMode === "plan" ||
              effectiveWorkMode === "build" ||
              effectiveWorkMode === "debug" ||
              effectiveWorkMode === "review")
              ? (effectiveWorkMode as ModeSystemKey)
              : "ask";

          const modelIdentity = resolveActiveModelIdentity(
            effectiveModel,
            settings,
            buildAtlarixCoreTierCatalog(),
          );
          // Commit authorship reflects the model doing the work for this stream.
          setActiveModelDisplayName(modelIdentity.modelDisplayName);
          // v10 token accuracy: collect sub-agent/compaction usage for this turn.
          resetAuxUsage(req.chatId);
          const promptIdentityOpts = {
            activeModel: effectiveModel,
            modelDisplayName: modelIdentity.modelDisplayName,
            providerBrand: modelIdentity.providerBrand,
            labelWithProvider: modelIdentity.labelWithProvider,
          };

          let baseSystemPrompt: string;
          if (hasWorkspace && appPath && effectiveAppId != null) {
            baseSystemPrompt = await buildSystemPromptWithProjectInstructions({
              workspacePath: appPath,
              workspacePromptContent: null,
              contextSize,
              chatMode,
              effectiveWorkMode: modeBlockKey,
              userPrompt: userPrompt,
              hasAnsweredQuestions: updatedChat?.hasAnsweredQuestions ?? false,
              hasWorkspace: true,
              ...promptIdentityOpts,
            });
          } else {
            baseSystemPrompt = constructSystemPrompt({
              chatMode,
              effectiveWorkMode: modeBlockKey,
              contextSize,
              userPrompt,
              enableTurboEditsV2: isTurboEditsV2Enabled(settings),
              hasAnsweredQuestions: updatedChat?.hasAnsweredQuestions ?? false,
              hasWorkspace,
              ...promptIdentityOpts,
            });
          }
          let contextSections: ContextSection[] = [];

          try {
            const modeSkillName = getSkillNameForMode(effectiveWorkMode);
            const modeSkillBody = await loadSkill(
              modeSkillName,
              hasWorkspace && appPath ? appPath : undefined,
            );
            if (modeSkillBody.trim()) {
              contextSections.push({
                name: "activeSkill",
                priority: -1,
                content: `[Active Skill: ${modeSkillName}]\n${modeSkillBody}`,
              });
            }

            // WORKFORCE Feature 1: repo-scoped priority skills from .atlarix/skills/.
            // Injected ahead of the active mode skill (priority -2). The `priority: true`
            // frontmatter flag only takes effect for Workforce accounts; Free/Pro still
            // load files in the folder as regular local skills.
            if (hasWorkspace && appPath) {
              try {
                const isWorkforce =
                  SubscriptionManager.getEffectiveTier() === "workforce";
                const prioritySkills = await loadPrioritySkillsForWorkspace(
                  appPath,
                  isWorkforce,
                );
                if (prioritySkills.length > 0) {
                  const block = formatPrioritySkillsForPrompt(
                    prioritySkills,
                    effectiveWorkMode,
                  );
                  if (block.trim()) {
                    contextSections.push({
                      name: "repoSkills",
                      priority: -2,
                      content: block,
                    });
                    const priorityCount = prioritySkills.filter((s) => s.priority).length;
                    const localCount = prioritySkills.length - priorityCount;
                    logger.info(
                      `[priority-skills] Injected ${priorityCount} priority + ${localCount} local skill(s) for mode "${effectiveWorkMode}"`,
                    );
                  }
                }
              } catch (repoSkillErr) {
                logger.warn(
                  "[priority-skills] Failed to load repo skills:",
                  repoSkillErr,
                );
              }
            }
          } catch (skillErr) {
            logger.warn("[skills] Failed to load mode skill:", skillErr);
          }

          if (hasWorkspace && appPath && effectiveAppId != null) {
            try {
              const {
                loadWorkspaceCapabilitiesSummary,
                formatWorkspaceCapabilitiesForPrompt,
              } = await import("@/lib/workspace/workspace-capabilities");
              const caps = await loadWorkspaceCapabilitiesSummary({
                workspaceId: effectiveAppId,
                workspacePath: appPath,
              });
              const capsBlock = formatWorkspaceCapabilitiesForPrompt(caps);
              if (capsBlock.trim()) {
                contextSections.push({
                  name: "workspaceCapabilities",
                  priority: -3,
                  content: capsBlock,
                });
              }
            } catch (capsErr) {
              logger.warn("[workspace-capabilities] Failed to load:", capsErr);
            }
          }

          // Pass 7: Installed skills are accessed on-demand via the
          // get_active_skills / list_installed_skills tools (registered in skills-tools.ts).
          // The legacy pre-injection block has been removed.
          const shouldCreateTaskLedger = false;
          if (
            req.workspaceSessionId &&
            hasWorkspace &&
            !req.prompt.startsWith("Summarize from chat-id=") &&
            !req.prompt.startsWith("/security-review")
          ) {
            try {
              const { getLatestPlanArtifact } = await import("@/lib/plans/plan-artifacts");
              const activePlan =
                (await getLatestPlanArtifact(req.workspaceSessionId, "building")) ??
                (await getLatestPlanArtifact(req.workspaceSessionId));
              if (activePlan?.content?.trim()) {
                const snippet =
                  activePlan.content.length > 3000
                    ? `${activePlan.content.slice(0, 3000)}\n\n...(truncated)`
                    : activePlan.content;
                contextSections.push({
                  name: "activePlan",
                  priority: 0.05,
                  content: `Active session plan (planId: ${activePlan.id}, status: ${activePlan.planStatus}) — advance it with update_plan_status("${activePlan.id}", "building" | "built"):\n\n${snippet}`,
                });
              }
            } catch (planCtxErr) {
              logger.warn("[plan-artifact] context inject failed:", planCtxErr);
            }
          }
          if (
            shouldCreateTaskLedger &&
            !req.prompt.startsWith("Summarize from chat-id=") &&
            !req.prompt.startsWith("/security-review")
          ) {
            let shouldEmitPlanCreated = false;
            const wsId = effectiveAppId ?? req.appId ?? undefined;
            let usedWorkspacePlanLedger = false;

            if (typeof wsId === "number" && wsId > 0 && hasWorkspace && appPath) {
              if (hasActivePlanLedger(wsId)) {
                const planTid = planLedgerTurnId(wsId);
                if (planTid != null) {
                  streamTurnIdForLedger = planTid;
                  const planLedger = getWorkspacePlanLedger(wsId)!;
                  planLedger.chatId = req.chatId;
                  planLedger.finishReason = "in_progress";
                  const hasInProg = planLedger.steps.some((s) => s.status === "in_progress");
                  if (!hasInProg) {
                    const firstPending = planLedger.steps.find((s) => s.status === "pending");
                    if (firstPending) {
                      firstPending.status = "in_progress";
                      planLedger.currentStepId = firstPending.id;
                    }
                  }
                  await persistLedgerToDisk(planLedger);
                  const { syncPlanFile } = await import("@/lib/tasks/plan-sync");
                  await syncPlanFile(appPath, planLedger);
                  usedWorkspacePlanLedger = true;
                }
              } else {
                try {
                  const { tryReadPlanDetailed, extractPlanTitle } = await import(
                    "@/lib/tasks/atlarix-plan-steps"
                  );
                  const planResult = await tryReadPlanDetailed(appPath);
                  const planDead =
                    planResult?.status === "COMPLETE" || planResult?.status === "FAILED";
                  const canResumeFromDisk =
                    planResult &&
                    !planDead &&
                    planResult.hasIncompleteSteps &&
                    planResult.steps.length > 0;

                  if (canResumeFromDisk) {
                    const planTid = planLedgerTurnId(wsId);
                    if (planTid != null) {
                      const hydrated = await hydrateLedgerFromDisk(planTid, appPath);
                      if (hydrated) {
                        streamTurnIdForLedger = planTid;
                        hydrated.chatId = req.chatId;
                        hydrated.finishReason = "in_progress";
                        const hip = hydrated.steps.some((s) => s.status === "in_progress");
                        if (!hip) {
                          const fp = hydrated.steps.find((s) => s.status === "pending");
                          if (fp) {
                            fp.status = "in_progress";
                            hydrated.currentStepId = fp.id;
                          }
                        }
                        await persistLedgerToDisk(hydrated);
                        const { syncPlanFile } = await import("@/lib/tasks/plan-sync");
                        await syncPlanFile(appPath, hydrated);
                        usedWorkspacePlanLedger = true;
                      } else {
                        const taskHead = extractPlanTitle(
                          planResult.content,
                          (userPrompt || req.prompt).slice(0, 8000),
                        );
                        createLedger({
                          turnId: planTid,
                          chatId: req.chatId,
                          originalTask: taskHead,
                          chatType: "workspace",
                          workspacePath: appPath,
                          stepDescriptions: planResult.steps,
                        });
                        streamTurnIdForLedger = planTid;
                        usedWorkspacePlanLedger = true;
                        if (planResult.steps.length > 1) {
                          shouldEmitPlanCreated = true;
                        }
                      }
                    }
                  }
                } catch (planErr) {
                  logger.warn("[ledger] Plan resume / hydrate failed:", planErr);
                }
              }
            }

            if (!usedWorkspacePlanLedger) {
              const prefillLen = req.prefillTaskLedger?.steps?.length ?? 0;
              if (prefillLen > 1) {
                shouldEmitPlanCreated = true;
              }
              createLedger({
                turnId: streamTurnIdForLedger,
                chatId: req.chatId,
                originalTask: (userPrompt || req.prompt).slice(0, 8000),
                chatType: hasWorkspace && appPath ? "workspace" : "general",
                workspacePath: hasWorkspace && appPath ? appPath : undefined,
                stepDescriptions: req.prefillTaskLedger?.steps?.map((s) => s.description),
              });
              if (hasWorkspace && appPath) {
                try {
                  const { tryReadPlan, parsePlanToSteps } = await import(
                    "@/lib/tasks/atlarix-plan-steps"
                  );
                  const planBody = await tryReadPlan(appPath);
                  if (planBody) {
                    const planSteps = parsePlanToSteps(planBody);
                    if (planSteps.length > 0) {
                      await setLedgerSteps(streamTurnIdForLedger, planSteps);
                      if (planSteps.length > 1) {
                        shouldEmitPlanCreated = true;
                      }
                    }
                  }
                } catch (planErr) {
                  logger.warn("[ledger] Failed to seed steps from plan file:", planErr);
                }
              }
            }

            const ledgerForUi = getLedger(streamTurnIdForLedger);
            if (ledgerForUi && ledgerForUi.steps.length > 0) {
              const planCardAssistantMessageId = placeholderAssistantMessage.id;
              registerLedgerPlanUiNotifier(req.chatId, (ledger) => {
                emitPlanUpdate(event.sender, ledger, planCardAssistantMessageId);
              });
              emitPlanUpdate(event.sender, ledgerForUi, planCardAssistantMessageId);
              if (shouldEmitPlanCreated && ledgerForUi.steps.length > 1) {
                safeSend(event.sender, "chat:activity", {
                  id: `plan-created-${Date.now()}`,
                  type: "plan_created",
                  label: `Plan created — ${ledgerForUi.steps.length} steps`,
                  status: "done",
                  timestamp: Date.now(),
                  chatId: req.chatId,
                  task: ledgerForUi.originalTask.slice(0, 800),
                  stepCount: ledgerForUi.steps.length,
                });
              }
            }
          }

          const delegationRuntime = getDelegationConfig(settings);
          const shouldInjectTaskProgress =
            settings.selectedChatMode === "build" ||
            settings.selectedChatMode === "agent" ||
            effectiveWorkMode === "build";

          const ledgerRow = getLedger(streamTurnIdForLedger);
          if (shouldInjectTaskProgress && ledgerRow) {
            contextSections.push({
              name: "taskProgress",
              priority: 0,
              content: formatLedgerForPrompt(ledgerRow),
            });
          }

          // PASS5: File system truth only useful in Build mode when files were actually
          // modified. Stale file excerpts from prior turns add noise in other modes.
          // (We don’t currently have a “files modified this turn” signal here, so we gate by build-like mode.)
          const shouldInjectFileSystemTruth =
            settings.selectedChatMode === "build" || settings.selectedChatMode === "agent";
          if (
            shouldInjectFileSystemTruth &&
            hasWorkspace &&
            appPath &&
            !req.prompt.startsWith("Summarize from chat-id=") &&
            !req.prompt.startsWith("/security-review")
          ) {
            try {
              const { buildFileSystemTruthBlock } = await import("@/lib/tasks/filesystem-truth");
              const fsTruth = await buildFileSystemTruthBlock({
                turnId: streamTurnIdForLedger,
                workspacePath: appPath,
              });
              if (fsTruth.trim()) {
                contextSections.push({
                  name: "fileSystemTruth",
                  priority: 0.5,
                  content: fsTruth,
                });
              }
            } catch (fsErr) {
              logger.warn("Failed to build filesystem truth block:", fsErr);
            }
          }

          // Pass 7: Workforce workspace context block deleted along with the
          // Legacy hosted credential store removed; per-extension state lives in MCP server
          // env vars.

          // PASS8: Blueprint is a lazy read-only graph built on demand when get_blueprint
          // is called (NOT deleted — that note from Pass 7 is wrong and superseded by Pass 6).
          // Architecture exploration is tool-driven via get_blueprint + search + read_file.

          // PASS5: SQLite project memory is now tool-driven.
          // The model calls get_project_memory when it needs to recall project context.
          // The underlying DB table and builder function remain intact.
          if (false) {
          if (hasWorkspace && effectiveAppId != null && effectiveAppId > 0) {
            try {
              const { buildProjectMemoryPromptBlock } = await import("@/lib/project-memory/service");
              const pmBlock = await buildProjectMemoryPromptBlock(effectiveAppId);
              if (pmBlock.trim()) {
                contextSections.push({
                  name: "projectMemory",
                  priority: 4,
                  content: pmBlock,
                });
                logger.info("Injected SQLite project memory (Section 2)");
              }
            } catch (pmErr) {
              logger.warn("Failed to inject SQLite project memory:", pmErr);
            }
          }
          }

          // Project-level .atlarix/ATLARIX.md (legacy memory/spec auto-migrated)
          if (hasWorkspace && appPath) {
            try {
              const atlarixMd = await readAtlarixMd(appPath);
              if (atlarixMd) {
                contextSections.push({
                  name: "projectMemory",
                  priority: 4,
                  content: `## Project memory (.atlarix/atlarix.md)\n${atlarixMd}`,
                });
                logger.info("Injected atlarix.md");
              }
            } catch (memErr) {
              logger.warn("Failed to read atlarix.md:", memErr);
            }
          }

          // Phase 6: Inject context summary (compacted earlier conversation)
          if (contextSummaryForSystem) {
            contextSections.push({
              name: "contextSummary",
              priority: 5,
              content: `## Session Summary (earlier conversation)\n${contextSummaryForSystem}`,
            });
            logger.info("Injected context summary from auto-compaction");
          }

          // Inject session memory (last 5 exchanges for conversation continuity)
          // NOTE: Use appId (workspace ID) as key so memory persists across mode switches (Ask → Build)
          try {
            const sessionMemory = getSessionMemory(chat.appId);
            const sessionContext = sessionMemory.getContextForPrompt();
            const SESSION_MEMORY_CHAR_CAP = 2000; // PASS5: keep session memory lightweight
            const cappedSessionContext =
              sessionContext && sessionContext.length > SESSION_MEMORY_CHAR_CAP
                ? sessionContext.slice(-SESSION_MEMORY_CHAR_CAP)
                : sessionContext;
            if (cappedSessionContext) {
              contextSections.push({
                name: "sessionMemory",
                priority: 6,
                content: cappedSessionContext,
              });
              logger.info(`Injected session memory (${sessionMemory.getExchangeCount()} exchanges, ~${sessionMemory.estimateTokens()} tokens)`);
            }
          } catch (error) {
            logger.warn("Failed to inject session memory:", error);
          }

          const isSummarizeIntent = req.prompt.startsWith(
            "Summarize from chat-id=",
          );

          const buildPromptBundle = async (
            sections: ContextSection[],
          ): Promise<{
            systemPrompt: string;
            contextAssemblerBlob: string;
            assembledContext: ReturnType<typeof assembleContextSections>;
            hasInjectedArchitectureContext: boolean;
            codebasePrefix: readonly ModelMessage[];
            otherCodebasePrefix: readonly ModelMessage[];
          }> => {
            const assembledContext = assembleContextSections({
              chatId: req.chatId,
              appId: effectiveAppId ?? null,
              workMode: effectiveWorkMode,
              userPrompt: userPrompt || req.prompt,
              sections,
            });
            let systemPrompt = baseSystemPrompt;
            if (assembledContext.activeSkillAddition?.trim()) {
              systemPrompt = `${assembledContext.activeSkillAddition.trim()}\n\n${systemPrompt}`;
            }
            let blob = "";
            if (assembledContext.finalSystemPromptAddition.trim()) {
              blob = assembledContext.finalSystemPromptAddition;
              systemPrompt += `\n\n${blob}`;
            }
            logger.info(
              `[ContextAssembler] mode=${effectiveWorkMode} cacheHit=${assembledContext.cache.hit} sections=${assembledContext.assembledPromptSections.filter((s) => s.included).length}/${assembledContext.assembledPromptSections.length}`,
            );
            if (assembledContext.trimReport.length > 0) {
              logger.info(`[ContextAssembler] trims: ${assembledContext.trimReport.join(" | ")}`);
            }
            // v10 context meter: surface per-section sizes + trims to the renderer.
            safeSend(event.sender, "chat:context-report", {
              chatId: req.chatId,
              sections: assembledContext.assembledPromptSections.map((s) => ({
                name: s.name,
                tokens: s.tokens,
                included: s.included,
                truncated: s.truncated,
              })),
              trimReport: assembledContext.trimReport,
            } satisfies ChatContextReport);
            const hasInjectedArchitectureContext =
              assembledContext.assembledPromptSections.some(
                (s) =>
                  s.included &&
                  (s.name === "workspaceAnalysis"),
              );
            if (otherAppsCodebaseInfo) {
              const mentionedAppsList = mentionedAppsCodebases
                .map(({ appName }) => appName)
                .join(", ");

              systemPrompt += `\n\n# Referenced Apps\nThe user has mentioned the following apps in their prompt: ${mentionedAppsList}. Their codebases have been included in the context for your reference. When referring to these apps, you can understand their structure and code to provide better assistance, however you should NOT edit the files in these referenced apps. The referenced apps are NOT part of the current app and are READ-ONLY.`;
            }

            const isSecurityReviewIntent =
              req.prompt.startsWith("/security-review");
            if (isSecurityReviewIntent) {
              systemPrompt = SECURITY_REVIEW_SYSTEM_PROMPT;
              try {
                const rulesPath = path.join(appPath, "SECURITY_RULES.md");
                let securityRules = "";

                await fs.promises.access(rulesPath);
                securityRules = await fs.promises.readFile(rulesPath, "utf8");

                if (securityRules && securityRules.trim().length > 0) {
                  systemPrompt +=
                    "\n\n# Project-specific security rules:\n" + securityRules;
                }
              } catch (error) {
                logger.info("Failed to read security rules", error);
              }
            }

            // PASS5: Supabase context is injected by the Supabase tool handler when
            // the model actually calls a Supabase tool. Pre-injecting schema on every
            // turn adds significant token weight even for non-Supabase conversations.
            if (false) {
              if (
                effectiveApp?.supabaseProjectId &&
                settings.supabase?.accessToken?.value
              ) {
                systemPrompt +=
                  "\n\n" +
                  SUPABASE_AVAILABLE_SYSTEM_PROMPT +
                  "\n\n" +
                  (await getSupabaseContext({
                    supabaseProjectId: effectiveApp.supabaseProjectId,
                  }));
              } else if (
                !effectiveApp?.neonProjectId &&
                !isSecurityReviewIntent
              ) {
                systemPrompt += "\n\n" + SUPABASE_NOT_AVAILABLE_SYSTEM_PROMPT;
              }
            }
            if (isSummarizeIntent) {
              systemPrompt = SUMMARIZE_CHAT_SYSTEM_PROMPT;
            }

            const hasImageAttachments =
              req.attachments &&
              req.attachments.some((attachment) =>
                attachment.type.startsWith("image/"),
              );

            const hasUploadedAttachments =
              req.attachments &&
              req.attachments.some(
                (attachment) => attachment.attachmentType === "upload-to-codebase",
              );
            if (hasUploadedAttachments) {
              systemPrompt += `
  
When files are attached to this conversation, upload them to the codebase using this exact format:

<atlarix-write path="path/to/destination/filename.ext" description="Upload file to codebase">
ATLARIX_ATTACHMENT_X
</atlarix-write>

Example for file with id of ATLARIX_ATTACHMENT_0:
<atlarix-write path="src/components/Button.jsx" description="Upload file to codebase">
ATLARIX_ATTACHMENT_0
</atlarix-write>

  `;
            } else if (hasImageAttachments) {
              systemPrompt += `

# Image Analysis Instructions
This conversation includes one or more image attachments. When the user uploads images:
1. If the user explicitly asks for analysis, description, or information about the image, please analyze the image content.
2. Describe what you see in the image if asked.
3. You can use images as references when the user has coding or design-related questions.
4. For diagrams or wireframes, try to understand the content and structure shown.
5. For screenshots of code or errors, try to identify the issue or explain the code.
`;
            }

            // PASS5: Diagram-first prefix messages inject a synthetic user+assistant turn
            // on every dispatch, costing tokens regardless of conversation topic.
            // Removed in favour of the model calling diagram tools when it needs them.
            if (false) {
              const _codebasePrefix = isEngineEnabled
                ? []
                : ([
                    {
                      role: "user",
                      content: createDiagramFirstPrompt(hasInjectedArchitectureContext),
                    },
                    {
                      role: "assistant",
                      content: hasInjectedArchitectureContext
                        ? "Got it. I will use the provided architecture context as the map, then explore folders and read targeted files as needed."
                        : "Understood. I do not currently have a blueprint in context, so I will call get_blueprint and use search + explore_folder to scope the relevant paths.",
                    },
                  ] as const);
              void _codebasePrefix;
            }
            const codebasePrefix: readonly ModelMessage[] = []; // PASS5: always empty now

            const otherCodebasePrefix =
              otherAppsCodebaseInfo && !isEngineEnabled
                ? ([
                    {
                      role: "user",
                      content: createOtherAppsCodebasePrompt(otherAppsCodebaseInfo),
                    },
                    {
                      role: "assistant",
                      content: "OK.",
                    },
                  ] as const)
                : [];

            return {
              systemPrompt,
              contextAssemblerBlob: blob,
              assembledContext,
              hasInjectedArchitectureContext,
              codebasePrefix,
              otherCodebasePrefix,
            };
          };

          let promptBundle = await buildPromptBundle(contextSections);
          let {
            systemPrompt,
            contextAssemblerBlob,
            codebasePrefix,
            otherCodebasePrefix,
          } = promptBundle;

          const modelContextResolved = await resolveModelContextLimit(
            effectiveModel,
            settings,
          );
          // FIX 2 (Compass): capture the underlying model's real context length
          // per chat. OpenRouter's registry returns the abstraction limit
          // (e.g. 128K) for compass/*, but the real underlying model can have
          // 1M+ context — `rawContextLength` reflects that. Subsequent calls
          // to `getContextWindowDetailed(model, chatId)` return this value
          // with source="compass-live" instead of the misleading 128K.
          if (
            modelClient.builtinProviderId === "compass" &&
            modelContextResolved.rawContextLength
          ) {
            setCompassContextWindow(
              req.chatId,
              modelContextResolved.rawContextLength,
            );
          }
          const mapTierLabel = (t: ModelTier): "fast" | "balanced" | "thinking" => {
            if (t === "thinking") return "thinking";
            if (t === "balanced") return "balanced";
            return "fast";
          };

          /** Catalog / heuristic raw context length (not tierLimit × 0.8). */
          const contextWindowTokens =
            modelContextResolved.rawContextLength != null &&
            modelContextResolved.rawContextLength > 0
              ? modelContextResolved.rawContextLength
              : Math.max(1, Math.round(modelContextResolved.tierLimit / 0.8));

          const applyTierEscalation = async (_args: {
            agenticIteration: number;
            iterationInterval: number;
            runningTokens: number;
            mode: string;
          }): Promise<boolean> => false;

          let dispatchEstimate = estimateDispatchTokens({
            systemPrompt,
            history: limitedMessageHistory,
            codebasePrefixMessages: [...codebasePrefix],
            otherCodebasePrefixMessages: [...otherCodebasePrefix],
          });
          let budgetTracker = new ContextBudgetTracker(
            modelContextResolved.tierLimit,
            dispatchEstimate,
            mapTierLabel(contextBudgetTier),
          );
          let contextBudgetPruningApplied = false;
          let workingSections = [...contextSections];
          for (let br = 0; br < 3; br++) {
            if (
              budgetTracker.isHealthy() ||
              dispatchEstimate < modelContextResolved.tierLimit * 0.85
            ) {
              break;
            }
            contextBudgetPruningApplied = true;
            workingSections = pruneContextSectionsForBudget(
              workingSections,
              budgetTracker.getBudgetTier(),
            );
            promptBundle = await buildPromptBundle(workingSections);
            ({
              systemPrompt,
              contextAssemblerBlob,
              codebasePrefix,
              otherCodebasePrefix,
            } = promptBundle);
            dispatchEstimate = estimateDispatchTokens({
              systemPrompt,
              history: limitedMessageHistory,
              codebasePrefixMessages: [...codebasePrefix],
              otherCodebasePrefixMessages: [...otherCodebasePrefix],
            });
            budgetTracker = new ContextBudgetTracker(
              modelContextResolved.tierLimit,
              dispatchEstimate,
              mapTierLabel(contextBudgetTier),
            );
          }

          const tierBudgeted = await enforceTierContextBudget({
            resolvedTier: contextBudgetTier,
            settings,
            effectiveModel,
            userPrompt,
            systemPrompt,
            contextAssemblerBlob,
            limitedMessageHistory,
            codebasePrefixMessages: [...codebasePrefix],
            otherCodebasePrefixMessages: [...otherCodebasePrefix],
          });
          systemPrompt = tierBudgeted.systemPrompt;
          limitedMessageHistory = tierBudgeted.limitedMessageHistory;
          contextAssemblerBlob = tierBudgeted.contextAssemblerBlob;
          const llmCompactionApplied = tierBudgeted.llmCompactionApplied ?? false;

          dispatchEstimate = estimateDispatchTokens({
            systemPrompt,
            history: limitedMessageHistory,
            codebasePrefixMessages: [...codebasePrefix],
            otherCodebasePrefixMessages: [...otherCodebasePrefix],
          });
          budgetTracker = new ContextBudgetTracker(
            modelContextResolved.tierLimit,
            dispatchEstimate,
            mapTierLabel(contextBudgetTier),
          );

          let proactiveContextReminderForStream: string | undefined;
          await (async () => {
            let loggedCompactionRem55 = false;
            let loggedCompactionAuto75 = false;
            let loggedCompactionForced90 = false;
            const logCompactionLine = (
              est: number,
              kind: "reminder" | "auto" | "forced",
              gate: 55 | 75 | 90,
            ) => {
              const pct = (est / contextWindowTokens) * 100;
              if (gate === 55 && loggedCompactionRem55) return;
              if (gate === 75 && loggedCompactionAuto75) return;
              if (gate === 90 && loggedCompactionForced90) return;
              if (gate === 55) loggedCompactionRem55 = true;
              if (gate === 75) loggedCompactionAuto75 = true;
              if (gate === 90) loggedCompactionForced90 = true;
              logger.info(
                `[compaction] Context at ${pct.toFixed(1)}% (${est}tokens / ${contextWindowTokens}tokens) — ${kind}`,
              );
            };

            const runCompressAndRebuild = async (
              compressReason: string,
              canDbR: boolean,
              canEphemeralR: boolean,
            ): Promise<{ ok: boolean; tokensBefore?: number; tokensAfter?: number; status?: string }> => {
              const providerId =
                getEffectiveModelForOptions(settings)?.provider ??
                (settings.selectedModel?.provider ?? undefined);
              const { executeCompressContext } = await import("@/lib/tools/workspace");
              const { getEphemeralChat } = await import("@/lib/ephemeral-chat");
              const msgListR = updatedChat.messages as {
                id: number;
                role: string;
                content: string;
              }[];
              const outcomeR = await executeCompressContext(
                { reason: compressReason },
                {
                  chatId: req.chatId,
                  messages: msgListR.map((m) => ({
                    id: m.id,
                    role: m.role,
                    content: m.content || "",
                  })),
                  systemPromptTokens: 6000,
                  inputTokens: estimateTokens(userPrompt),
                  providerId,
                  sessionStats: { toolCallCount: 0, delegationCount: 0 },
                  turnId: null,
                  ephemeral: canEphemeralR,
                  setMessages: canEphemeralR
                    ? (next) => {
                        updatedChat.messages = next as typeof updatedChat.messages;
                        const ec = getEphemeralChat(req.chatId);
                        if (ec) ec.messages = next as typeof ec.messages;
                      }
                    : undefined,
                },
              );
              if (!(outcomeR.success && outcomeR.status === "completed")) {
                return {
                  ok: false,
                  tokensBefore: outcomeR.tokensBefore,
                  tokensAfter: outcomeR.tokensAfter,
                  status: outcomeR.status,
                };
              }
              if (canEphemeralR) {
                type EphemeralMsgR = {
                  role: string;
                  content?: string;
                  sourceCommitHash?: string;
                  commitHash?: string;
                };
                limitedMessageHistory = (updatedChat.messages as EphemeralMsgR[]).map((message) => {
                  const content = message.content || "";
                  const baseMessage: {
                    role: "user" | "assistant" | "system";
                    content: string;
                  } = {
                    role: message.role as "user" | "assistant" | "system",
                    content,
                  };
                  const commitFields: { sourceCommitHash?: string; commitHash?: string } = {};
                  if (message.sourceCommitHash) {
                    commitFields.sourceCommitHash = message.sourceCommitHash;
                  }
                  if (message.commitHash) {
                    commitFields.commitHash = message.commitHash;
                  }
                  return { ...baseMessage, ...commitFields };
                });
                const maxChatTurnsR = isDeepContextEnabled
                  ? 201
                  : (settings.maxChatTurnsInContext || MAX_CHAT_TURNS_IN_CONTEXT) + 1;
                if (limitedMessageHistory.length > maxChatTurnsR * 2) {
                  let recentMessagesR = limitedMessageHistory
                    .filter((msg: EphemeralMsgR) => msg.role !== "system")
                    .slice(-maxChatTurnsR * 2);
                  if (recentMessagesR.length > 0 && recentMessagesR[0].role !== "user") {
                    const firstUserIndexR = recentMessagesR.findIndex(
                      (msg: EphemeralMsgR) => msg.role === "user",
                    );
                    if (firstUserIndexR > 0) {
                      recentMessagesR = recentMessagesR.slice(firstUserIndexR);
                    } else if (firstUserIndexR === -1) {
                      recentMessagesR = [];
                    }
                  }
                  limitedMessageHistory = [...recentMessagesR];
                }
              }
              contextSections = contextSections.filter((s) => s.name !== "contextSummary");
              if (contextSummaryForSystem) {
                contextSections.push({
                  name: "contextSummary",
                  priority: 5,
                  content: `## Session Summary (earlier conversation)\n${contextSummaryForSystem}`,
                });
              }
              workingSections = [...contextSections];
              promptBundle = await buildPromptBundle(workingSections);
              ({
                systemPrompt,
                contextAssemblerBlob,
                codebasePrefix,
                otherCodebasePrefix,
              } = promptBundle);
              const tierBudgetedR = await enforceTierContextBudget({
                resolvedTier: contextBudgetTier,
                settings,
                effectiveModel,
                userPrompt,
                systemPrompt,
                contextAssemblerBlob,
                limitedMessageHistory,
                codebasePrefixMessages: [...codebasePrefix],
                otherCodebasePrefixMessages: [...otherCodebasePrefix],
              });
              systemPrompt = tierBudgetedR.systemPrompt;
              limitedMessageHistory = tierBudgetedR.limitedMessageHistory;
              contextAssemblerBlob = tierBudgetedR.contextAssemblerBlob;
              dispatchEstimate = estimateDispatchTokens({
                systemPrompt,
                history: limitedMessageHistory,
                codebasePrefixMessages: [...codebasePrefix],
                otherCodebasePrefixMessages: [...otherCodebasePrefix],
              });
              budgetTracker = new ContextBudgetTracker(
                modelContextResolved.tierLimit,
                dispatchEstimate,
                mapTierLabel(contextBudgetTier),
              );
              return {
                ok: true,
                tokensBefore: outcomeR.tokensBefore,
                tokensAfter: outcomeR.tokensAfter,
                status: outcomeR.status,
              };
            };

            const fillRatioBefore = dispatchEstimate / contextWindowTokens;
            if (
              fillRatioBefore >= 0.75 &&
              settings.enableContextAutoSummarize !== false
            ) {
              const canEphemeral = isEphemeralWorkspace && req.chatId < 0;
              const canDb = req.chatId > 0 && !isEphemeralWorkspace;
              if (canEphemeral || canDb) {
                const reason = "proactive-fill-75%";
                logCompactionLine(dispatchEstimate, "auto", 75);
                logger.log(
                  `[stream:${req.chatId}] proactive context compaction (${reason}) fill=${(fillRatioBefore * 100).toFixed(1)}% est=${dispatchEstimate}/${contextWindowTokens}`,
                );
                const activityBase = `proactive-compact-${req.chatId}-${Date.now()}`;
                safeSend(event.sender, "chat:activity", {
                  id: `${activityBase}-run`,
                  type: "compaction",
                  label: "Context compacted automatically",
                  status: "running",
                  timestamp: Date.now(),
                  detail: reason,
                  chatId: req.chatId,
                  modelInitiated: false,
                });
                try {
                  const cr = await runCompressAndRebuild(reason, canDb, canEphemeral);
                  safeSend(event.sender, "chat:activity", {
                    id: `${activityBase}-done`,
                    type: "compaction",
                    label: "Context compacted automatically",
                    status: cr.ok ? "done" : "error",
                    timestamp: Date.now(),
                    detail:
                      typeof cr.tokensBefore === "number" && typeof cr.tokensAfter === "number"
                        ? `${cr.tokensBefore} → ${cr.tokensAfter} est. (${String(cr.status ?? "")})`
                        : String(cr.status ?? "noop"),
                    chatId: req.chatId,
                    modelInitiated: false,
                  });
                } catch (e) {
                  safeSend(event.sender, "chat:activity", {
                    id: `${activityBase}-err`,
                    type: "compaction",
                    label: "Context compacted automatically",
                    status: "error",
                    timestamp: Date.now(),
                    detail: String(e),
                    chatId: req.chatId,
                    modelInitiated: false,
                  });
                  logger.warn(`[stream:${req.chatId}] proactive compaction failed`, e);
                }
              }
            }
            const fillAfter75 = dispatchEstimate / contextWindowTokens;
            if (
              fillAfter75 >= 0.9 &&
              settings.enableContextAutoSummarize !== false
            ) {
              const canEphemeral90 = isEphemeralWorkspace && req.chatId < 0;
              const canDb90 = req.chatId > 0 && !isEphemeralWorkspace;
              if (canEphemeral90 || canDb90) {
                logCompactionLine(dispatchEstimate, "forced", 90);
                const forcedBase = `forced-compact-${req.chatId}-${Date.now()}`;
                safeSend(event.sender, "chat:activity", {
                  id: `${forcedBase}-run`,
                  type: "compaction",
                  label: "Compacting context before continuing...",
                  status: "running",
                  timestamp: Date.now(),
                  detail: "forced-fill-90%",
                  chatId: req.chatId,
                  modelInitiated: false,
                });
                let forcedAny = false;
                try {
                  for (let fi = 0; fi < 3; fi++) {
                    if (dispatchEstimate / contextWindowTokens < 0.9) break;
                    const crF = await runCompressAndRebuild(
                      "forced-fill-90%",
                      canDb90,
                      canEphemeral90,
                    );
                    if (!crF.ok) break;
                    forcedAny = true;
                  }
                } catch (forcedErr) {
                  logger.warn(`[stream:${req.chatId}] forced compaction failed`, forcedErr);
                }
                safeSend(event.sender, "chat:activity", {
                  id: `${forcedBase}-done`,
                  type: "compaction",
                  label: "Compacting context before continuing...",
                  status: forcedAny ? "done" : "error",
                  timestamp: Date.now(),
                  chatId: req.chatId,
                  modelInitiated: false,
                });
              }
            }

            const fillAfterProactive = dispatchEstimate / contextWindowTokens;
            if (fillAfterProactive >= 0.55) {
              logCompactionLine(dispatchEstimate, "reminder", 55);
              proactiveContextReminderForStream =
                "Context is at 55% capacity. Consider calling compress_context before your next heavy tool use.";
            }
          })();

          const ttftStartRef = { ms: null as number | null };
          const ttftShouldLog =
            process.env.NODE_ENV === "development" ||
            process.env.ATLARIX_TTFT_LOG === "1";
          const logTtftOnce = (() => {
            let done = false;
            return () => {
              if (done || !ttftShouldLog || ttftStartRef.ms == null) return;
              done = true;
              const openRouterCompressionApplied =
                (modelClient.builtinProviderId === "openrouter" ||
                  modelClient.builtinProviderId === "compass") &&
                (budgetTracker.isCritical() || budgetTracker.isOverLimit());
              logger.log(
                `[TTFT] tier=${String(contextBudgetTier)} provider=${String(modelClient.builtinProviderId)} model=${String((effectiveModel as { name?: string })?.name ?? "")} contextLength=${modelContextResolved.rawContextLength ?? "unknown"} ttft=${Date.now() - ttftStartRef.ms}ms budgetTier=${budgetTracker.getBudgetTier()} estimatedTokens=${dispatchEstimate} pruningApplied=${contextBudgetPruningApplied} compressionApplied=${openRouterCompressionApplied} compactionApplied=${llmCompactionApplied}`,
              );
            };
          })();

          type HistoryMsg = { role: string; content?: string; sourceCommitHash?: string; commitHash?: string };
          let limitedHistoryChatMessages: ModelMessage[] = limitedMessageHistory.map((msg: HistoryMsg) => {
            const baseMsg: { role: "user" | "assistant" | "system"; content: string; providerOptions?: object } = {
              role: msg.role as "user" | "assistant" | "system",
              // Why remove thinking tags?
              // Thinking tags are generally not critical for the context
              // and eats up extra tokens.
              content: removeAtlarixTags(
                removeNonEssentialTags(msg.content ?? ""),
              ),
            };

            // Only include providerOptions if we have actual commit hash values
            // (ephemeral/incognito messages don't have these)
            if (msg.sourceCommitHash || msg.commitHash) {
              baseMsg.providerOptions = {
                "dyad-engine": {
                  ...(msg.sourceCommitHash && { sourceCommitHash: msg.sourceCommitHash }),
                  ...(msg.commitHash && { commitHash: msg.commitHash }),
                },
              };
            }

            return baseMsg;
          });

          // OpenRouter (Compass + BYOK): last-resort safety cap for balanced/thinking tiers.
          // Tier pre-budget runs first; this only kicks in when history is still very large.
          if (needsOpenRouterContextSafety(modelClient.builtinProviderId, contextBudgetTier)) {
            const nonSystem = limitedHistoryChatMessages.filter((m: ModelMessage) => m.role !== "system");
            const MAX_EXCHANGES = 7;
            const maxMsgs = MAX_EXCHANGES * 2;
            if (nonSystem.length > maxMsgs) {
              let recent = nonSystem.slice(-maxMsgs);
              if (recent.length > 0 && recent[0]?.role !== "user") {
                const firstUser = recent.findIndex((m: ModelMessage) => m.role === "user");
                recent = firstUser >= 0 ? recent.slice(firstUser) : [];
              }
              limitedHistoryChatMessages = recent;
            }
          }


          let chatMessages: ModelMessage[] = [
            ...codebasePrefix,
            ...otherCodebasePrefix,
            ...limitedHistoryChatMessages,
          ];

          // Check if the last message should include attachments (model-only injection)
          if (
            chatMessages.length >= 2 &&
            (attachmentPaths.length > 0 || attachmentInfoForModel.trim().length > 0)
          ) {
            const lastUserIndex = chatMessages.length - 2;
            const lastUserMessage = chatMessages[lastUserIndex];

            if (lastUserMessage.role === "user") {
              chatMessages[lastUserIndex] = await prepareMessageWithAttachments({
                message: lastUserMessage,
                attachmentInfoForModel,
              });
            }
          }

          if (isSummarizeIntent) {
            const priorTransportId = parseInt(req.prompt.split("=")[1], 10);
            const priorEphemeral = Number.isFinite(priorTransportId)
              ? getEphemeralChat(priorTransportId)
              : undefined;
            chatMessages = [
              {
                role: "user",
                content:
                  "Summarize the following chat: " +
                  formatMessagesForSummary(priorEphemeral?.messages ?? []),
              } satisfies ModelMessage,
            ];
          }

          /** Shared cap for length + pending-step continuations per user turn */
          let streamContinuationAttempts = 0;
          const STREAM_CONTINUATION_MAX = 3;
          /** One retry after 1s when the model returns no usable output (cold start / provider flake). */
          const MAX_STREAM_EMPTY_OUTPUT_ATTEMPTS = 2;
          const STREAM_EMPTY_OUTPUT_RETRY_DELAY_MS = 1000;

          const isEmptyOutputStreamError = isNoUsableModelOutputError;

          const getLedgerStateForContinuation = (): string | undefined =>
            getLedgerStateString(streamTurnIdForLedger);

          const simpleStreamText = async ({
            chatMessages,
            modelClient,
            tools,
            systemPromptOverride = systemPrompt,
            // PASS8 A5: When provided, prepended as a system-role message in `messages`
            // so the static `system` field stays cache-eligible across turns.
            dynamicSystemTail,
            dyadDisableFiles = false,
            files,
          }: {
            chatMessages: ModelMessage[];
            modelClient: ModelClient;
            files: CodebaseFile[];
            tools?: ToolSet;
            systemPromptOverride?: string;
            dynamicSystemTail?: string;
            dyadDisableFiles?: boolean;
          }) => {
            if (isEngineEnabled) {
              logger.log(
                "sending AI request to engine with request id:",
                engineRequestId,
              );
            } else {
              logger.log("sending AI request");
            }
            let versionedFiles: VersionedFiles | undefined;
            if (isDeepContextEnabled) {
              versionedFiles = await getVersionedFiles({
                files,
                chatMessages,
                appPath,
              });
            }
            const smartContextMode: SmartContextMode = isDeepContextEnabled
              ? "deep"
              : "balanced";
            const optionsModel = getEffectiveModelForOptions(settings);
            const thinkingTier =
              contextBudgetTier === "thinking" && !suppressNativeThinkingForDeepCounsel;
            const providerOptions: Record<string, any> = {
              "dyad-engine": {
                dyadAppId: effectiveAppId ?? updatedChat.app?.id,
                dyadRequestId: engineRequestId,
                dyadDisableFiles,
                dyadSmartContextMode: smartContextMode,
                dyadFiles: versionedFiles ? undefined : files,
                dyadVersionedFiles: versionedFiles,
                dyadMentionedApps: mentionedAppsCodebases.map(
                  ({ files, appName }) => ({
                    appName,
                    files,
                  }),
                ),
              },
              "dyad-gateway": getExtraProviderOptions(
                modelClient.builtinProviderId,
                settings,
                thinkingTier,
              ),
            };

            const useOpenRouterContextCompression =
              (modelClient.builtinProviderId === "openrouter" ||
                modelClient.builtinProviderId === "compass") &&
              (budgetTracker.isCritical() || budgetTracker.isOverLimit());
            if (useOpenRouterContextCompression) {
              providerOptions.openrouter = {
                plugins: [{ id: "context-compression" }],
              };
            }

            // Reasoning / native thoughts only for the thinking context tier (dynamic per model).
            if (thinkingTier) {
              const catalogModelId = resolveReasoningCatalogModelId(effectiveModel);
              const cap = detectReasoningCapability(
                catalogModelId,
                modelClient.builtinProviderId,
              );
              const reasoningPatch = buildReasoningProviderOptions(cap, true);
              if (reasoningPatch.openrouter) {
                providerOptions.openrouter = {
                  ...providerOptions.openrouter,
                  ...reasoningPatch.openrouter,
                };
              }
              if (reasoningPatch.google) {
                providerOptions.google = reasoningPatch.google;
              }
              if (reasoningPatch.openai) {
                providerOptions.openai = reasoningPatch.openai;
              }
            }

            const isAnthropic = modelClient.builtinProviderId === "anthropic";

            // v10.1: provider-native web search — when the provider ships a
            // built-in search tool, swap out the client-side `web_search` for
            // it (results + citations come back inline in the same stream).
            // Client `web_search` stays the universal fallback elsewhere.
            let effectiveTools = tools;
            if (tools && tools["web_search"]) {
              const nativeWeb = getNativeWebSearchSupport(
                modelClient.builtinProviderId,
                effectiveModel?.name,
              );
              if (nativeWeb?.kind === "tool") {
                const { web_search: _clientWebSearch, ...rest } = tools;
                effectiveTools = { ...rest, [nativeWeb.key]: nativeWeb.tool };
                logger.log(
                  `[native-web-search] using provider tool ${nativeWeb.key} (${modelClient.builtinProviderId})`,
                );
              } else if (nativeWeb?.kind === "openrouter-plugin") {
                providerOptions.openrouter = {
                  ...providerOptions.openrouter,
                  plugins: [
                    ...(providerOptions.openrouter?.plugins ?? []),
                    { id: "web" },
                  ],
                };
                logger.log("[native-web-search] enabled OpenRouter web plugin");
              }
            }

            const maxOutputTokens = await getMaxTokensWithFloor(optionsModel);
            const temperature = await getTemperature(optionsModel);

            ttftStartRef.ms = Date.now();
            // v10.1 perf: time from workspace open to the first prompt dispatch.
            if (effectiveAppId != null) {
              perfReportOnce(
                `workspace-open:${effectiveAppId}`,
                `workspace ${effectiveAppId} open → first prompt dispatch`,
              );
            }

            const history: ModelMessage[] = chatMessages.filter((m) => m.content);
            const tailParts = [proactiveContextReminderForStream, dynamicSystemTail].filter(
              (s): s is string => typeof s === "string" && s.trim().length > 0,
            );

            // v10.1 prompt caching: the per-turn tail no longer merges into the
            // `system` string (that invalidated the provider prompt cache every
            // turn). Leading system messages instead: stable header first —
            // with an Anthropic cache breakpoint covering tools + system —
            // then the dynamic tail as its own (mostly day-stable) block.
            const anthropicCacheControl = {
              anthropic: { cacheControl: { type: "ephemeral" as const } },
            };
            const streamMessages: ModelMessage[] = [
              {
                role: "system",
                content: systemPromptOverride,
                ...(isAnthropic ? { providerOptions: anthropicCacheControl } : {}),
              },
              ...(tailParts.length > 0
                ? [
                    {
                      role: "system" as const,
                      content: mergeSystemPromptParts(tailParts[0], ...tailParts.slice(1)),
                    },
                  ]
                : []),
              // Anthropic: second breakpoint on the previous exchange's last
              // message so the growing history caches incrementally.
              ...(isAnthropic && history.length >= 2
                ? history.map((m, i) =>
                    i === history.length - 2
                      ? {
                          ...m,
                          providerOptions: {
                            ...(m as { providerOptions?: Record<string, unknown> })
                              .providerOptions,
                            ...anthropicCacheControl,
                          },
                        }
                      : m,
                  )
                : history),
            ];
            const streamResult = streamText({
              headers: isAnthropic
                ? {
                  "anthropic-beta": "context-1m-2025-08-07",
                }
                : undefined,
              maxOutputTokens,
              temperature,
              maxRetries:
                tools != null && Object.keys(tools as object).length > 0 ? 0 : 2,
              model: modelClient.model,
              stopWhen: [() => false],
              providerOptions,
              tools: effectiveTools,
              messages: streamMessages,
              onFinish: (response) => {
                const rt = reasoningTokensFromAiUsage(response.usage);
                if (typeof rt === "number") {
                  maxReasoningTokensUsed = Math.max(maxReasoningTokensUsed ?? 0, rt);
                }
                // v10.1 prompt caching: surface cache reads/writes per round.
                {
                  const u = response.usage as { cachedInputTokens?: number } | undefined;
                  const cacheRead = u?.cachedInputTokens;
                  const anthroMeta = response.providerMetadata?.anthropic as
                    | { cacheCreationInputTokens?: number | null }
                    | undefined;
                  const cacheWrite = anthroMeta?.cacheCreationInputTokens;
                  if (
                    (typeof cacheRead === "number" && cacheRead > 0) ||
                    (typeof cacheWrite === "number" && cacheWrite > 0)
                  ) {
                    logger.log(
                      `[prompt-cache] chat ${req.chatId}: read=${cacheRead ?? 0} write=${cacheWrite ?? 0} input=${(response.usage as { inputTokens?: number })?.inputTokens ?? "?"}`,
                    );
                  }
                }
                let totalTokens: number | null = totalTokensFromAiUsage(response.usage);
                if (totalTokens == null && response.usage && typeof response.usage === "object") {
                  const u = response.usage as Record<string, unknown>;
                  const p =
                    typeof u.promptTokens === "number"
                      ? u.promptTokens
                      : typeof u.inputTokens === "number"
                        ? u.inputTokens
                        : null;
                  const c =
                    typeof u.completionTokens === "number"
                      ? u.completionTokens
                      : typeof u.outputTokens === "number"
                        ? u.outputTokens
                        : null;
                  if (p != null || c != null) {
                    totalTokens = Math.round((p ?? 0) + (c ?? 0));
                  }
                }

                if (typeof totalTokens === "number" && totalTokens > 0) {
                  // We use the highest total tokens used (we are *not* accumulating)
                  // since we're trying to figure it out if we're near the context limit.
                  maxTokensUsed = Math.max(maxTokensUsed ?? 0, totalTokens);

                  if (modelClient.builtinProviderId === "compass") {
                    compassStreamTokens = totalTokens;
                    void recordCompassUsageTokens(totalTokens).then((r) => {
                      if (!r.ok && r.error === "limit_exceeded") {
                        logger.warn("[compass] Monthly limit hit while recording usage");
                      }
                    });
                  }

                  logger.log(
                    `Total tokens used (aggregated for message ${placeholderAssistantMessage.id}): ${maxTokensUsed}`,
                  );

                  // PASS2: Compaction is now model-triggered via the compress_context tool.
                  // The model calls compress_context({ reason: "..." }) when it needs more room.
                  // Do not re-enable automatic post-turn compaction — remove this if(false) wrapper
                  // and the tool registration in compress-context-tool.ts together if reverting.
                  if (false) {
                    const builtinPid = modelClient.builtinProviderId;
                    const modelName = optionsModel?.name?.trim();
                    let compactionOpenRouterId: string | null = null;
                    if (
                      builtinPid === "openrouter" ||
                      optionsModel?.provider === "openrouter"
                    ) {
                      compactionOpenRouterId = modelName || null;
                    } else if (builtinPid === "compass" && modelName) {
                      compactionOpenRouterId =
                        getOpenRouterModelIdForCompassTier(modelName) ?? null;
                    }
                    schedulePostTurnCompaction({
                      chatId: req.chatId,
                      totalTokensUsed: maxTokensUsed as number,
                      providerId: modelClient.builtinProviderId ?? optionsModel?.provider,
                      turnId: String(placeholderAssistantMessage.id),
                      openRouterModelId: compactionOpenRouterId,
                    });
                  }
                } else {
                  logger.log(
                    `Total tokens used (aggregated for message ${placeholderAssistantMessage.id}): unavailable (no total or prompt/completion counts from provider)`,
                  );
                }
              },
              onError: (error: any) => {
                if (isNoUsableModelOutputError(error)) {
                  logger.warn(
                    "[stream] onError: empty/no usable model output (handled by consumption/retry or auxiliary handlers)",
                    error,
                  );
                  return;
                }
                // FIX 4: network/transport failures are recoverable by the
                // outer retry wrapper. Don't surface the generic error box —
                // the wrapper will emit `chat:stream:reset-partial` and retry,
                // or eventually emit `chat:stream:disconnected`.
                if (isNetworkStreamError(error)) {
                  logger.warn(
                    "[stream] onError: network/transport failure (will retry silently)",
                    error,
                  );
                  return;
                }
                let errorMessage = (error as any)?.error?.message;
                const responseBody = error?.error?.responseBody;
                if (errorMessage && responseBody) {
                  errorMessage += "\n\nDetails: " + responseBody;
                }
                let message = errorMessage || JSON.stringify(error);
                if (modelClient.builtinProviderId === "compass") {
                  message = COMPASS_REACHABILITY_ERROR;
                } else {
                  message = modelFailureUserMessage(message);
                }
                const requestIdPrefix = isEngineEnabled
                  ? `[Request ID: ${engineRequestId}] `
                  : "";
                logger.error(
                  `AI stream text error for request: ${requestIdPrefix} errorMessage=${errorMessage} error=`,
                  error,
                );
                if (modelClient.builtinProviderId === "compass") {
                  sentryCaptureExceptionSafe(
                    new Error(`${requestIdPrefix}${message}`.slice(0, 500)),
                    {
                      tags: { feature: "compass", source: "main_stream" },
                      extra: { chatId: req.chatId },
                    },
                  );
                }
                event.sender.send("chat:response:error", {
                  chatId: req.chatId,
                  error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${requestIdPrefix}${message}`,
                });
                // Clean up the abort controller
                activeStreams.delete(req.chatId);
              },
              abortSignal: abortController.signal,
            });
            // Best-effort: same-turn .catch on usage/finishReason/response. Node may still
            // print 1–2 "Unhandled rejection" lines around AI SDK flush ordering; main.ts
            // swallows empty-output rejections as a safety net.
            attachEmptyOutputSafeRejectHandlers(
              streamResult,
              logger.warn.bind(logger),
              "chat_stream",
            );
            return {
              fullStream: streamResult.fullStream,
              usage: streamResult.usage,
              finishReason: streamResult.finishReason,
              response: streamResult.response,
            };
          };

          type SimpleStreamTextBundle = Awaited<ReturnType<typeof simpleStreamText>>;

          async function runStreamRoundWithEmptyOutputRetry(params: {
            runSimpleStream: () => Promise<SimpleStreamTextBundle>;
            fullResponse: string;
            abortController: AbortController;
            chatId: number;
            processResponseChunkUpdate: (args: {
              fullResponse: string;
            }) => Promise<string>;
            onFirstModelActivity?: () => void;
            onFirstTextDelta?: () => void;
            onFirstReasoningDelta?: () => void;
            onFirstTextAfterReasoning?: () => void;
            onStreamStall?: () => void;
            sanitizeTextDelta?: (text: string) => string;
            onToolInputProgress?: (info: {
              toolName: string;
              deltaCount: number;
            }) => void;
            onStreamActivityPulse?: () => void;
          }): Promise<{
            bundle: SimpleStreamTextBundle;
            fullResponse: string;
            finishReason: Awaited<SimpleStreamTextBundle["finishReason"]>;
          }> {
            const initialFullResponse = params.fullResponse;
            let fullResponse = params.fullResponse;
            let emptyOutputAttempt = 0;
            let networkAttempt = 0;
            // Bound the loop generously; both retry counters can fire in the
            // same round but each is independently capped.
            const TOTAL_ATTEMPT_CAP =
              MAX_STREAM_EMPTY_OUTPUT_ATTEMPTS + RECONNECT_DELAYS_MS.length + 1;
            for (let loop = 0; loop < TOTAL_ATTEMPT_CAP; loop++) {
              try {
                const bundle = await params.runSimpleStream();
                const chunkResult = await processStreamChunks({
                  fullStream: bundle.fullStream,
                  fullResponse,
                  abortController: params.abortController,
                  chatId: params.chatId,
                  processResponseChunkUpdate: params.processResponseChunkUpdate,
                  onFirstModelActivity: params.onFirstModelActivity,
                  onFirstTextDelta: params.onFirstTextDelta,
                  onFirstReasoningDelta: params.onFirstReasoningDelta,
                  onFirstTextAfterReasoning: params.onFirstTextAfterReasoning,
                  onStreamStall: params.onStreamStall,
                  sanitizeTextDelta: params.sanitizeTextDelta,
                  onToolInputProgress: params.onToolInputProgress,
                  onStreamActivityPulse: params.onStreamActivityPulse,
                });
                fullResponse = chunkResult.fullResponse;
                const finishReason = await bundle.finishReason;
                if (chunkResult.stalled) {
                  throw new Error(
                    "Stream stalled: no chunks from the model for 45 seconds",
                  );
                }
                return { bundle, fullResponse, finishReason };
              } catch (err) {
                // User abort always wins over any retry path.
                if (params.abortController.signal.aborted) {
                  throw err;
                }

                // Empty-output retry (pre-existing behavior).
                if (
                  isEmptyOutputStreamError(err) &&
                  emptyOutputAttempt < MAX_STREAM_EMPTY_OUTPUT_ATTEMPTS - 1
                ) {
                  emptyOutputAttempt++;
                  logger.warn(
                    `[stream] Empty output on attempt ${emptyOutputAttempt}/${MAX_STREAM_EMPTY_OUTPUT_ATTEMPTS}, retrying after ${STREAM_EMPTY_OUTPUT_RETRY_DELAY_MS}ms...`,
                  );
                  sentryAddBreadcrumbSafe({
                    category: "stream_retry",
                    message: `empty_output_retry attempt ${emptyOutputAttempt}/${MAX_STREAM_EMPTY_OUTPUT_ATTEMPTS}`,
                    level: "warning",
                  });
                  fullResponse = initialFullResponse;
                  await new Promise((r) =>
                    setTimeout(r, STREAM_EMPTY_OUTPUT_RETRY_DELAY_MS),
                  );
                  continue;
                }
                if (isEmptyOutputStreamError(err)) {
                  throw new EmptyModelOutputAfterRetryError();
                }

                // FIX 4: silent network retry. On a transient transport failure
                // (terminated socket, fetch failed, APICallError, etc.) reset
                // the in-flight partial — both backend accumulator and the
                // renderer's streaming buffer — then wait with backoff and
                // retry the same streamText call. Three attempts at 2s/5s/10s.
                if (
                  isNetworkStreamError(err) &&
                  networkAttempt < RECONNECT_DELAYS_MS.length
                ) {
                  const delay = RECONNECT_DELAYS_MS[networkAttempt];
                  networkAttempt++;
                  logger.warn(
                    `[stream] Network error on attempt ${networkAttempt}/${RECONNECT_DELAYS_MS.length}, retrying after ${delay}ms: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                  );
                  sentryAddBreadcrumbSafe({
                    category: "stream_retry",
                    message: `network_retry attempt ${networkAttempt}/${RECONNECT_DELAYS_MS.length}`,
                    level: "warning",
                  });
                  safeSend(event.sender, "chat:stream:reset-partial", {
                    chatId: params.chatId,
                  });
                  fullResponse = initialFullResponse;
                  partialResponses.delete(params.chatId);
                  await new Promise((r) => setTimeout(r, delay));
                  if (params.abortController.signal.aborted) throw err;
                  continue;
                }
                if (isNetworkStreamError(err)) {
                  throw new NetworkStreamDisconnectedError(fullResponse);
                }
                throw err;
              }
            }
            throw new Error("runStreamRoundWithEmptyOutputRetry: unreachable");
          }


          const processResponseChunkUpdate = async ({
            fullResponse,
          }: {
            fullResponse: string;
          }) => {
            if (
              fullResponse.includes("$$SUPABASE_CLIENT_CODE$$") &&
              effectiveApp?.supabaseProjectId
            ) {
              const supabaseClientCode = await getSupabaseClientCode({
                projectId: effectiveApp.supabaseProjectId,
              });
              fullResponse = fullResponse.replace(
                "$$SUPABASE_CLIENT_CODE$$",
                supabaseClientCode,
              );
            }
            // Store the current partial response
            partialResponses.set(req.chatId, fullResponse);
            // Update the placeholder assistant message content in the messages array
            const currentMessages = [...updatedChat.messages];
            if (
              currentMessages.length > 0 &&
              currentMessages[currentMessages.length - 1].role === "assistant"
            ) {
              const stripped = stripTaskCompleteTags(fullResponse);
              currentMessages[currentMessages.length - 1].content = stripped;
              if (isEphemeralWorkspace) {
                const lastIdx = updatedChat.messages.length - 1;
                if (
                  lastIdx >= 0 &&
                  updatedChat.messages[lastIdx]?.role === "assistant"
                ) {
                  updatedChat.messages[lastIdx].content = stripped;
                  const { getEphemeralChat } = await import("@/lib/ephemeral-chat");
                  const ec = getEphemeralChat(req.chatId);
                  if (ec) {
                    ec.messages = updatedChat.messages;
                  }
                }
              }
            }

            // Update the assistant message in the database
            safeSend(event.sender, "chat:response:chunk", {
              chatId: req.chatId,
              messages: currentMessages,
            });
            return fullResponse;
          };

          const finalizeAskUserBreakpoint = async () => {
            const segmentA = fullResponse;
            if (!segmentA.trim()) {
              fullResponse = "";
              partialResponses.set(req.chatId, "");
              await processResponseChunkUpdate({ fullResponse: "" });
              return;
            }
            if (isEphemeralWorkspace) {
              const msgs = updatedChat.messages;
              const last = msgs[msgs.length - 1];
              if (last?.role === "assistant") {
                last.content = segmentA;
              }
              const newPh = {
                id: Date.now(),
                chatId: req.chatId,
                role: "assistant" as const,
                content: "",
                createdAt: new Date(),
                sourceCommitHash: null,
                commitHash: null,
              };
              msgs.push(newPh);
              placeholderAssistantMessage = newPh;
              askUserContinuationAssistantIdByChatId.set(req.chatId, newPh.id);
              const { getEphemeralChat } = await import("@/lib/ephemeral-chat");
              const ec = getEphemeralChat(req.chatId);
              if (ec) {
                ec.messages = msgs;
              }
            }
            fullResponse = "";
            partialResponses.set(req.chatId, "");
            await processResponseChunkUpdate({ fullResponse: "" });
          };

          // Pass 7: Blueprint-first blocker fully removed.
          if (settings.selectedChatMode === "agent") {
            // Workspace-aware tool filtering (uses effective workspace from outer scope)
            const workspaceFilteredTools = ToolRegistry.toAISDKFormatForContext(hasWorkspace);

            // Convert to tool set format expected by AI SDK
            const tools: ToolSet = {};
            for (const tool of workspaceFilteredTools) {
              const regName = tool.function.name;
              tools[regName] = {
                description: tool.function.description,
                inputSchema: normalizeToolInputSchemaForAiSdk(
                  tool.function?.parameters ?? { type: "object", properties: {} },
                ) as never,
                execute: async (args: any) => {
                  // Fix: Finding 4
                  safeSend(event.sender, "chat:tool:start", {
                    chatId: req.chatId,
                    toolId: regName,
                    toolName: getToolActivityLabel(regName),
                    toolArgs: args,
                  });
                  try {
                    if (regName === "compress_context") {
                      // PASS2: Compaction is model-triggered via compress_context.
                      // Emit activity + run compaction here (tool handler has no stream scope).
                      const reason =
                        args && typeof args.reason === "string" && args.reason.trim()
                          ? args.reason.trim()
                          : "model-initiated";
                      safeSend(event.sender, "chat:activity", {
                        id: `compress-context-${req.chatId}-${Date.now()}`,
                        type: "compaction",
                        label: "Context compressed",
                        status: "running",
                        timestamp: Date.now(),
                        detail: reason,
                        chatId: req.chatId,
                        modelInitiated: true,
                      });

                      try {
                        const providerId =
                          getEffectiveModelForOptions(settings)?.provider ??
                          (settings.selectedModel?.provider ?? undefined);
                        const { executeCompressContext } = await import("@/lib/tools/workspace");
                        const msgList = updatedChat.messages as { id: number; role: string; content: string }[];
                        const outcome = await executeCompressContext(
                          { reason },
                          {
                            chatId: req.chatId,
                            messages: msgList.map((m) => ({ id: m.id, role: m.role, content: m.content || "" })),
                            systemPromptTokens: 6000,
                            inputTokens: 0,
                            providerId,
                            sessionStats: { toolCallCount: 0, delegationCount: 0 },
                            turnId: String(placeholderAssistantMessage?.id ?? ""),
                          },
                        );

                        safeSend(event.sender, "chat:activity", {
                          id: `compress-context-${req.chatId}-${Date.now()}`,
                          type: "compaction",
                          label: "Context compressed",
                          status: "done",
                          timestamp: Date.now(),
                          // PASS8 F1: tokensBefore/After are estimates, not exact provider counts.
                          detail: `${outcome.tokensBefore} → ${outcome.tokensAfter} est. tokens. ${outcome.status}`,
                          chatId: req.chatId,
                          modelInitiated: true,
                        });

                        return JSON.stringify({
                          success: outcome.success,
                          reason: outcome.reason,
                          tokensBefore: outcome.tokensBefore,
                          tokensAfter: outcome.tokensAfter,
                          summary: outcome.summary,
                          status: outcome.status,
                        });
                      } catch (e) {
                        safeSend(event.sender, "chat:activity", {
                          id: `compress-context-${req.chatId}-${Date.now()}`,
                          type: "compaction",
                          label: "Context compressed",
                          status: "error",
                          timestamp: Date.now(),
                          detail: String(e),
                          chatId: req.chatId,
                          modelInitiated: true,
                        });
                        return JSON.stringify({ success: false, error: String(e), reason });
                      }
                    }

                    const result = await runToolExecute(
                      regName,
                      {
                        ...args,
                        _chatSessionId: req.chatId,
                        workspaceSessionId: req.workspaceSessionId ?? undefined,
                      },
                      event.sender,
                      req.chatId,
                      buildToolStreamOpts(),
                    );
                    // v10.1 fix: this path returned the raw `__ask_user` marker
                    // to the model (no UI question, no pause). Intercept like the
                    // Build/agentic paths do.
                    const askUserResolvedAgentTab = await resolveAskUserToolResult(
                      event,
                      req.chatId,
                      regName,
                      result,
                      { finalizeAskUserBreakpoint },
                    );
                    if (askUserResolvedAgentTab !== null) {
                      return askUserResolvedAgentTab;
                    }
                    return JSON.stringify(result);
                  } finally {
                    safeSend(event.sender, "chat:tool:end", { chatId: req.chatId });
                  }
                },
              };
            }

            // Add generate-code meta-tool
            tools["generate-code"] = {
              description:
                "ALWAYS use this tool whenever generating or editing code for the codebase.",
              inputSchema: aiJsonSchema(PERMISSIVE_TOOL_JSON_SCHEMA),
              execute: async () => "",
            };

            // Pass 7: MCP tools are no longer pre-merged for workspace chats.
            // The model calls list_available_mcps to discover, then mcp_call to invoke.

            let agentStreamMessages: ModelMessage[] = limitedHistoryChatMessages;
            const agentTabStreamLoopStartMs = Date.now();
            while (true) {
              if (Date.now() - agentTabStreamLoopStartMs > STREAM_TOOL_LOOP_DURATION_CAP_MS) {
                logger.warn("[Agent tab stream] Hit duration limit (30 minutes)");
                safeSend(event.sender, "chat:activity", {
                  id: `duration-limit-${Date.now()}`,
                  type: "duration_limit_reached",
                  label: "Task paused after 30 minutes",
                  detail: "Send a message to continue",
                  status: "done",
                  timestamp: Date.now(),
                  chatId: req.chatId,
                });
                break;
              }
              // PASS8 A2 + A5: Build header + dynamic tail; pass header as system,
              // dynamic tail prepended as a system-role message in `messages`.
              const agentParts = constructSystemPromptParts({
                chatMode: "build",
                effectiveWorkMode: "build",
                hasWorkspace,
                ...promptIdentityOpts,
                contextSize: await getContextWindow(effectiveModel, req.chatId),
                enableTurboEditsV2: false,
              });
              const { bundle, fullResponse: agentRoundFull, finishReason: fr } =
                await runStreamRoundWithEmptyOutputRetry({
                  runSimpleStream: async () =>
                    simpleStreamText({
                      chatMessages: agentStreamMessages,
                      modelClient,
                      tools,
                      systemPromptOverride: agentParts.stableHeader,
                      dynamicSystemTail: agentParts.dynamicTail,
                      files: files,
                      dyadDisableFiles: true,
                    }),
                  fullResponse,
                  abortController,
                  chatId: req.chatId,
                  processResponseChunkUpdate,
                  onFirstModelActivity: () => {
                    safeSend(event.sender, "chat:stream:phase", {
                      chatId: req.chatId,
                      phase: "responding",
                      label: "",
                    });
                  },
                  onFirstTextDelta: logTtftOnce,
                  onFirstReasoningDelta: () => {
                    safeSend(event.sender, "chat:activity", {
                      id: `reasoning-started-${req.chatId}-${Date.now()}`,
                      type: "reasoning_started",
                      label: "Thinking deeply...",
                      status: "running",
                      timestamp: Date.now(),
                      chatId: req.chatId,
                    });
                  },
                  onFirstTextAfterReasoning: () => {
                    safeSend(event.sender, "chat:activity", {
                      id: `reasoning-${req.chatId}`,
                      type: "reasoning_complete",
                      label: "Done thinking, writing response...",
                      status: "done",
                      timestamp: Date.now(),
                      chatId: req.chatId,
                    });
                  },
                  onStreamStall: handleStreamStall,
                  onToolInputProgress: handleToolInputProgress,
                  onStreamActivityPulse: handleStreamActivityPulse,
                  sanitizeTextDelta: stripHallucinatedAtlarixToolTagsFromDelta,
                });
              fullResponse = agentRoundFull;
              if (
                !shouldContinue(fr, {
                  attemptCount: streamContinuationAttempts,
                  maxAttempts: STREAM_CONTINUATION_MAX,
                })
              ) {
                break;
              }
              streamContinuationAttempts++;
              const resp = await bundle.response;
              agentStreamMessages = [
                ...agentStreamMessages,
                ...(resp.messages as ModelMessage[]),
                {
                  role: "user",
                  content: buildContinuationPrompt({
                    chatId: req.chatId,
                    turnId: String(placeholderAssistantMessage.id),
                    attemptCount: streamContinuationAttempts,
                    maxAttempts: STREAM_CONTINUATION_MAX,
                    lastContent: stripThinkBlocks(fullResponse),
                    ledgerState: getLedgerStateForContinuation(),
                  }),
                },
              ];

              // PASS8-FIX: Tool results are appended above (3997-4011), THEN
              // prune, THEN compaction. Compaction never runs before the
              // current round's tool results land in the message accumulator.
              // PASS8 D1: Prune large tool outputs between rounds before compaction.
              // PASS8 C1-C4: Compaction mirrored from Build into all agentic loops.
              {
                const agentCompaction = await runMidLoopCompaction({
                  messages: agentStreamMessages,
                  systemPromptEstimate: estimateTokens(agentParts.stableHeader + "\n\n" + agentParts.dynamicTail),
                  tierLimit: modelContextResolved.tierLimit,
                  contextWindowTokens,
                  enabled: settings.enableContextAutoSummarize !== false,
                  chatId: req.chatId,
                  loopLabel: "Agent tab",
                  emitActivity: emitCompactionMirroredActivity(event.sender, req.chatId),
                  onInfo: (msg) => logger.log(msg),
                  onWarn: (msg, err) => logger.warn(msg, err),
                });
                if (agentCompaction.compacted) {
                  agentStreamMessages = agentCompaction.messages;
                }
              }
            }
            chatMessages.push({
              role: "assistant",
              // Strip <think> blocks from the model-facing history. The
              // renderer stream (ThinkingCard) still receives the live tags
              // via chat:response:chunk; only the next-turn context is
              // stripped so the model never re-ingests its own reasoning.
              content: stripThinkBlocks(fullResponse),
            });
            chatMessages.push({
              role: "user",
              content: "OK.",
            });
          }

          // v3.9: Assign in Build block (declared above for use in post-stream update)
          preExchangeSnapshotId = null;
          filesWrittenInThisExchange = [];

          // Ask mode with workspace: read-only tools + ATLARIX_PLAN writes (approval) + exploration
          if (settings.selectedChatMode === "ask" && effectiveApp) {
            logger.log(
              `Ask tier with workspace — read-only${effectiveWorkMode === "plan" ? " + Plan tools" : ""} (approval where required)`,
            );

            const askPermissionInterceptor = new PermissionInterceptor(
              appPath,
              effectiveAppId ?? undefined,
              !isEphemeralWorkspace ? placeholderAssistantMessage.id : undefined,
              req.chatId,
            );
            registerInterceptor(req.chatId, askPermissionInterceptor);

            // Repetition guard for Ask mode — parity with Build mode. Without
            // this, the model could hammer `read_file` / `explore_folder` /
            // `search` indefinitely (the round-cache layer serves them from
            // dedup, but the provider eventually goes silent and the
            // stream-stall watchdog fires after 30s). Catching the loop here
            // surfaces a `loop_detected` activity and injects a correction
            // message back to the model so it self-corrects before the stall.
            const askAgenticRepetition = createAgenticRepetitionState();
            const handleAskAgenticRepetitionOutcome = (
              o: AgenticRepetitionOutcome,
            ) => {
              if (o.kind === "none") return;
              if (o.kind === "loop_detected") {
                safeSend(event.sender, "chat:activity", {
                  id: `loop-detected-${Date.now()}`,
                  type: "loop_detected",
                  label: "Repeated action detected",
                  detail: `${o.toolName} on the same target ${o.count}+ times in a short window — self-correcting`,
                  status: "running",
                  timestamp: Date.now(),
                  chatId: req.chatId,
                  toolName: o.toolName,
                  loopTarget: o.target,
                  loopCount: o.count,
                });
                return;
              }
              safeSend(event.sender, "chat:activity", {
                id: `loop-abort-${Date.now()}`,
                type: "loop_repetition_aborted",
                label: "Task stopped — repeated action",
                detail:
                  "The model kept repeating the same read or search after guidance. Review the activity log and send a message to continue.",
                status: "done",
                timestamp: Date.now(),
                chatId: req.chatId,
                toolName: o.toolName,
                loopTarget: o.target,
                loopCount: o.count,
              });
            };

            const askToolStreamOpts = () => ({
              turnId: streamTurnIdForLedger,
              abortController,
              abortStreamOnLedgerComplete: false,
              toolTurnDedup: toolTurnDedupState,
            });

            const askModeTools = ToolRegistry.getToolsForAskMode();
            const askLoader = getOrCreateToolSessionLoader(req.chatId);
            const modeAllowlist = getModeToolAllowSets();
            const modeAllowNames = getModeToolAllowlist(effectiveWorkMode);
            askLoader.ensureLoaded([
              ...modeAllowNames.filter((n) => n !== "*"),
              ...(hasWorkspace && effectiveAppId != null
                ? WORKSPACE_INTEGRATION_TOOL_NAMES
                : []),
            ]);
            const askLoadedNames = askLoader.getLoadedToolNames();
            const askToolsToInclude = askModeTools.filter((t) =>
              includeToolForSession(t, {
                loaded: askLoadedNames,
                hasWorkspace,
                mode: effectiveWorkMode,
                isCore: isCoreTool,
              }),
            );
            const askProgressiveNote = generateProgressiveRevealNote(
              askToolsToInclude.map((t) => t.name),
              effectiveWorkMode,
            );

            const askTools: ToolSet = {};
            for (const tool of askToolsToInclude) {
              askTools[tool.name] = {
                description: tool.description,
                inputSchema: normalizeToolInputSchemaForAiSdk(
                  tool.parameters ??
                    (tool as { function?: { parameters?: unknown } }).function?.parameters,
                ) as never,
                execute: async (args: any) => {
                  askLoader.onToolCall(tool.name);
                  if (askAgenticRepetition.isEnabled()) {
                    handleAskAgenticRepetitionOutcome(
                      askAgenticRepetition.record(tool.name, args),
                    );
                  }
                  const askIsStream = tool.name === "stream_terminal_output";
                  const toolActivityId = `tool-${tool.name}-${Date.now()}`;
                  let askActivityStatus: "done" | "error" = "done";
                  let toolResultForActivity: unknown;
                  // Fix: Finding 4
                  if (!askIsStream) {
                    safeSend(event.sender, "chat:tool:start", {
                      chatId: req.chatId,
                      toolId: tool.name,
                      toolName: getToolActivityLabel(tool.name),
                      toolArgs: args,
                    });
                    safeSend(event.sender, "chat:activity", {
                      id: toolActivityId,
                      type: "tool_use",
                      label: getToolActivityLabel(tool.name),
                      status: "running",
                      timestamp: Date.now(),
                      chatId: req.chatId,
                      toolName: tool.name,
                      toolArgs: args,
                    });
                  }
                  try {
                    const meta = ToolRegistry.get(tool.name);
                    const liveWorkMode: WorkMode =
                      readSettings().workModePreference ?? effectiveWorkMode;
                    const liveAllowedSet =
                      modeAllowlist[liveWorkMode] ?? modeAllowlist.ask;
                    const askAllowed =
                      liveAllowedSet.has(tool.name) ||
                      meta?.isReadOnly === true ||
                      meta?.allowInAskMode === true;
                    if (!askAllowed) {
                      toolResultForActivity = {
                        success: false,
                        error: `${tool.name} is not available in ${liveWorkMode} mode. Ask the user to switch modes in the UI.`,
                      };
                      return JSON.stringify(toolResultForActivity);
                    }
                    const debugGate = debugWriteGateResult(
                      req.chatId,
                      tool.name,
                      liveWorkMode,
                      args,
                    );
                    if (debugGate) return debugGate;
                    if (tool.name === "compress_context") {
                      const reason =
                        args && typeof args.reason === "string" && args.reason.trim()
                          ? args.reason.trim()
                          : "model-initiated";
                      safeSend(event.sender, "chat:activity", {
                        id: `compress-context-${req.chatId}-${Date.now()}`,
                        type: "compaction",
                        label: "Context compressed",
                        status: "running",
                        timestamp: Date.now(),
                        detail: reason,
                        chatId: req.chatId,
                        modelInitiated: true,
                      });
                      try {
                        const providerId =
                          getEffectiveModelForOptions(settings)?.provider ??
                          (settings.selectedModel?.provider ?? undefined);
                        const { executeCompressContext } = await import("@/lib/tools/workspace");
                        const { getEphemeralChat } = await import("@/lib/ephemeral-chat");
                        const msgList = updatedChat.messages as {
                          id: number;
                          role: string;
                          content: string;
                        }[];
                        const outcome = await executeCompressContext(
                          { reason },
                          {
                            chatId: req.chatId,
                            messages: msgList.map((m) => ({
                              id: m.id,
                              role: m.role,
                              content: m.content || "",
                            })),
                            systemPromptTokens: 6000,
                            inputTokens: 0,
                            providerId,
                            sessionStats: { toolCallCount: 0, delegationCount: 0 },
                            turnId: isEphemeralWorkspace
                              ? null
                              : String(placeholderAssistantMessage?.id ?? ""),
                            ephemeral: isEphemeralWorkspace,
                            setMessages: isEphemeralWorkspace
                              ? (next) => {
                                  updatedChat.messages = next as typeof updatedChat.messages;
                                  const ec = getEphemeralChat(req.chatId);
                                  if (ec) ec.messages = next as typeof ec.messages;
                                }
                              : undefined,
                          },
                        );
                        safeSend(event.sender, "chat:activity", {
                          id: `compress-context-${req.chatId}-${Date.now()}`,
                          type: "compaction",
                          label: "Context compressed",
                          status: "done",
                          timestamp: Date.now(),
                          detail: `${outcome.tokensBefore} → ${outcome.tokensAfter} est. (${outcome.status}). ${reason}`,
                          chatId: req.chatId,
                          modelInitiated: true,
                        });
                        return JSON.stringify({
                          success: outcome.success,
                          reason: outcome.reason,
                          tokensBefore: outcome.tokensBefore,
                          tokensAfter: outcome.tokensAfter,
                          summary: outcome.summary,
                          status: outcome.status,
                        });
                      } catch (e) {
                        safeSend(event.sender, "chat:activity", {
                          id: `compress-context-${req.chatId}-${Date.now()}`,
                          type: "compaction",
                          label: "Context compressed",
                          status: "error",
                          timestamp: Date.now(),
                          detail: String(e),
                          chatId: req.chatId,
                          modelInitiated: true,
                        });
                        return JSON.stringify({ success: false, error: String(e), reason });
                      }
                    }
                    const execArgs: any = {
                      ...args,
                      workspace: appPath,
                      workspaceId: effectiveAppId ?? undefined,
                      agentMode: settings.agentMode ?? "direct",
                      chatMode: toolExecutionChatMode(liveWorkMode),
                      _chatSessionId: req.chatId,
                      workspaceSessionId: req.workspaceSessionId ?? undefined,
                    };
                    attachSearchRoutingActivity(execArgs, event.sender, req.chatId);
                    if (tool.name === "stream_terminal_output") {
                      execArgs.chatId = req.chatId;
                      execArgs._sendToolActivity = (label: string) => {
                        safeSend(event.sender, "chat:tool:start", {
                          chatId: req.chatId,
                          toolId: tool.name,
                          toolName: label,
                          toolArgs: execArgs,
                        });
                        return () => {
                          safeSend(event.sender, "chat:tool:end", { chatId: req.chatId });
                        };
                      };
                    }
                    const result = await runToolExecute(
                      tool.name,
                      execArgs,
                      event.sender,
                      req.chatId,
                      askToolStreamOpts(),
                    );

                    const askUserResolvedEarly = await resolveAskUserToolResult(
                      event,
                      req.chatId,
                      tool.name,
                      result,
                      { finalizeAskUserBreakpoint },
                    );
                    if (askUserResolvedEarly !== null) {
                      return askUserResolvedEarly;
                    }

                    if (tool.name === "write_implementation_plan") {
                      try {
                        const parsed =
                          typeof result === "string" ? JSON.parse(result) : result;
                        if (parsed?.success && parsed?.planId) {
                          const { emitPlanArtifactUpdated } = await import(
                            "@/ipc/utils/emit_plan_artifact"
                          );
                          const {
                            getPlanArtifact,
                            planArtifactMarker,
                          } = await import("@/lib/plans/plan-artifacts");
                          const marker = planArtifactMarker(parsed.planId);
                          if (!fullResponse.includes(marker)) {
                            fullResponse = `${fullResponse.trimEnd()}\n\n${marker}\n`;
                          }
                          const row = await getPlanArtifact(parsed.planId);
                          if (row) {
                            emitPlanArtifactUpdated(event.sender, {
                              planId: row.id,
                              sessionId: row.sessionId,
                              content: row.content,
                              planStatus: row.planStatus,
                            });
                          }
                          safeSend(event.sender, "chat:activity", {
                            id: `plan-saved-${Date.now()}`,
                            type: "tool",
                            label: "Plan saved",
                            status: "done",
                            timestamp: Date.now(),
                            detail: parsed.planId,
                            chatId: req.chatId,
                          });
                        }
                      } catch {
                        /* result may not be JSON */
                      }
                    }

                    if (askPermissionInterceptor.isPermissionRequest(result)) {
                      let permRequest = askPermissionInterceptor.parsePermissionRequest(result);
                      if (permRequest) {
                        if (permRequest.operation === "run_command") {
                          const cmd =
                            (permRequest.preview as { command?: string }).command ?? "";
                          const gate = runCommandGateResult(cmd, liveWorkMode);
                          if (gate) return gate;
                          const categoryBlock = runCommandCategoryGateToolResult(
                            cmd,
                            effectiveAppId,
                            req.chatId,
                            event.sender,
                          );
                          if (categoryBlock) return categoryBlock;
                        }
                        const filePref = await applyFileScopePreflightInStream(
                          permRequest,
                          effectiveAppId,
                          req.chatId,
                          event.sender,
                          askPermissionInterceptor,
                          (label, detail) =>
                            emitFilePermissionActivity(event.sender, req.chatId, label, detail),
                          (message) =>
                            safeSend(event.sender, "file-permission-blocked", {
                              chatId: req.chatId,
                              message,
                            }),
                        );
                        if (filePref.earlyReturn) return filePref.earlyReturn;
                        permRequest = filePref.permRequest;
                        const operationId = askPermissionInterceptor.generateOperationId();
                        const runCmd =
                          permRequest.operation === "run_command"
                            ? ((permRequest.preview as { command?: string }).command ?? "")
                            : "";
                        const skipPermissionWait =
                          filePref.skipPermissionWait ||
                          (permRequest.operation === "run_command" &&
                            shouldSkipPermissionWaitForRunCommand(
                              runCmd,
                              effectiveAppId,
                              req.chatId,
                              event.sender,
                            )) ||
                          shouldAutoApprovePermissions(settings.agentMode, req.chatId) ||
                          askPermissionInterceptor.shouldAlwaysAutoApprove(permRequest);
                        askPermissionInterceptor.bufferOperation(
                          operationId,
                          permRequest,
                          skipPermissionWait,
                        );

                        if (!skipPermissionWait) {
                          safeSend(event.sender, "permission-request", {
                            chatId: req.chatId,
                            operationId,
                            request: enrichPermissionRequestForUi(permRequest, effectiveAppId),
                          });

                          logger.log(`[Ask Mode] Permission request buffered: ${operationId}`);
                        } else if (askPermissionInterceptor.shouldAlwaysAutoApprove(permRequest)) {
                          logger.log(
                            `[Ask Mode] Auto-approved .atlarix internal write: ${operationId}`,
                          );
                        } else {
                          logger.log(`[Ask Mode] Auto-exec: ${operationId}`);
                        }

                        try {
                          let approved: boolean;
                          if (skipPermissionWait) {
                            const execMeta =
                              await askPermissionInterceptor.executeOperation(operationId);
                            approved = execMeta.approved;
                            if (!approved) {
                              const execResultRejected =
                                askPermissionInterceptor.getExecutionResult(operationId);
                              if (execResultRejected.exitCode !== undefined) {
                                logger.log(
                                  `[Ask Mode] Auto-approved op failed: ${operationId} (exit ${execResultRejected.exitCode})`,
                                );
                                return JSON.stringify({
                                  success: false,
                                  error:
                                    execResultRejected.error ||
                                    `Command failed with exit code ${execResultRejected.exitCode}`,
                                  exitCode: execResultRejected.exitCode,
                                  output: execResultRejected.output,
                                  operation: permRequest.operation,
                                  path:
                                    (permRequest.preview as { path?: string; command?: string })
                                      .path ||
                                    (permRequest.preview as { command?: string }).command,
                                });
                              }
                              return JSON.stringify({
                                success: false,
                                error:
                                  execMeta.error ??
                                  execResultRejected.error ??
                                  "Execution failed",
                                operation: permRequest.operation,
                                path: (permRequest.preview as { path?: string }).path,
                              });
                            }
                          } else {
                            approved =
                              await askPermissionInterceptor.waitForApproval(operationId);
                          }

                          if (approved) {
                            const execResult = askPermissionInterceptor.getExecutionResult(operationId);
                            logger.log(`[Ask Mode] Permission approved: ${operationId}`);

                            const preview = permRequest.preview as { path?: string; paths?: string[] };
                            if (permRequest.operation === "write_multiple_files" && preview.paths?.length) {
                              filesWrittenInThisExchange.push(...preview.paths);
                            } else if (preview.path) {
                              filesWrittenInThisExchange.push(preview.path);
                            }

                            const output = execResult.output || "";
                            const hasCompilationErrors =
                              /error:|Error:|ERROR:|failed to|Failed to|Cannot find|cannot find|is not defined|is not a function|SyntaxError|TypeError|ReferenceError/i.test(
                                output,
                              );

                            if (hasCompilationErrors) {
                              logger.log(`[Ask Mode] Command output contains errors: ${operationId}`);
                              return JSON.stringify({
                                success: true,
                                hasErrors: true,
                                warning:
                                  "The command ran but the output shows errors. Please review the output and fix the underlying code issue before running the same command again.",
                                message: "Command started but output shows errors",
                                path: execResult.path,
                                output: output.slice(-2000),
                              });
                            }

                            return JSON.stringify({
                              success: true,
                              message: `Successfully ${permRequest.operation === "write_file" ? "wrote" : "executed"} ${(permRequest.preview as { path?: string }).path || "operation"}`,
                              path: execResult.path,
                              output: execResult.output,
                            });
                          } else {
                            const execResultRejected = askPermissionInterceptor.getExecutionResult(operationId);

                            if (execResultRejected.exitCode !== undefined) {
                              logger.log(
                                `[Ask Mode] Command failed: ${operationId} (exit ${execResultRejected.exitCode})`,
                              );
                              return JSON.stringify({
                                success: false,
                                error:
                                  execResultRejected.error ||
                                  `Command failed with exit code ${execResultRejected.exitCode}`,
                                exitCode: execResultRejected.exitCode,
                                output: execResultRejected.output,
                                operation: permRequest.operation,
                                path:
                                  (permRequest.preview as { path?: string; command?: string }).path ||
                                  (permRequest.preview as { command?: string }).command,
                              });
                            } else {
                              logger.log(`[Ask Mode] Permission denied: ${operationId}`);
                              return JSON.stringify({
                                success: false,
                                error: "Permission denied by user",
                                operation: permRequest.operation,
                                path: (permRequest.preview as { path?: string }).path,
                              });
                            }
                          }
                        } catch (error) {
                          logger.error(`[Ask Mode] Permission error: ${operationId}`, error);
                          return JSON.stringify({
                            success: false,
                            error: `Permission request failed: ${error instanceof Error ? error.message : String(error)}`,
                            timedOut: true,
                          });
                        }
                      }
                    }

                    toolResultForActivity = result;
                    return typeof result === "string" ? result : JSON.stringify(result);
                  } catch (error) {
                    askActivityStatus = "error";
                    toolResultForActivity = error;
                    return JSON.stringify({ success: false, error: String(error) });
                  } finally {
                    if (!askIsStream) {
                      const activityDetail = summarizeToolResultForActivityDetail(
                        tool.name,
                        toolResultForActivity,
                        askActivityStatus === "error" ? "error" : "done",
                      );
                      const resultText = toolResultTextForExpand(toolResultForActivity);
                      safeSend(event.sender, "chat:tool:end", { chatId: req.chatId });
                      safeSend(event.sender, "chat:activity", {
                        id: toolActivityId,
                        type: "tool_use",
                        label: getToolActivityLabel(tool.name),
                        status: askActivityStatus,
                        timestamp: Date.now(),
                        chatId: req.chatId,
                        toolName: tool.name,
                        toolArgs: args,
                        ...(activityDetail ? { detail: activityDetail } : {}),
                        ...(resultText ? { resultText } : {}),
                      });
                    }
                  }
                },
              };
            }

            if (isDelegationAllowedForWorkMode(effectiveWorkMode)) {
              attachDelegationToolsToSet(askTools, {
                sender: event.sender,
                chatId: req.chatId,
                effectiveWorkMode,
                workspacePath: appPath,
                workspaceId: effectiveAppId ?? undefined,
                turnId: streamTurnIdForLedger,
                safeSend,
                recordToolUseForTurn,
                onDelegated: (agentId) => delegatedAgentsThisTurn.push(agentId),
                getDelegationCount: () => delegationsStartedThisTurn,
                onDelegationStart: () => {
                  delegationsStartedThisTurn += 1;
                },
                tryAcquireDedupeKey: (key) => {
                  if (inFlightDelegationKeys.has(key)) return false;
                  inFlightDelegationKeys.add(key);
                  return true;
                },
                releaseDedupeKey: (key) => {
                  inFlightDelegationKeys.delete(key);
                },
                maxConcurrentDelegations: delegationRuntime.maxConcurrentDelegations,
              });
            }

            // Pass 7: MCP tools are no longer pre-merged for workspace Ask chats.
            // The model calls list_available_mcps + mcp_call from the registry on demand.
            logger.log(
              `Ask tier: ${Object.keys(askTools).length} tools (read-only${effectiveWorkMode === "plan" ? " + Plan tools" : ""}; MCP via list_available_mcps + mcp_call)`,
            );

            let askStreamMessages: ModelMessage[] = [...chatMessages];
            const askTierStreamLoopStartMs = Date.now();
            askAgenticRepetition.setEnabled(true);
            let askAgenticIteration = 0;
            while (true) {
              if (abortController.signal.aborted) {
                logger.log(
                  `[Ask tier] AbortController already aborted (reason: ${String(abortController.signal.reason)}), exiting loop`,
                );
                sentryAddBreadcrumbSafe({
                  category: "ask_stream",
                  message: `aborted: ${String(abortController.signal.reason)}`,
                  level: "info",
                });
                break;
              }
              if (Date.now() - askTierStreamLoopStartMs > STREAM_TOOL_LOOP_DURATION_CAP_MS) {
                logger.warn(
                  `[Ask tier stream] Hit duration limit (30 minutes) workMode=${effectiveWorkMode}`,
                );
                safeSend(event.sender, "chat:activity", {
                  id: `duration-limit-${Date.now()}`,
                  type: "duration_limit_reached",
                  label: "Task paused after 30 minutes",
                  detail: "Send a message to continue",
                  status: "done",
                  timestamp: Date.now(),
                  chatId: req.chatId,
                });
                break;
              }
              // PASS8 A4: Removed redundant second constructSystemPrompt assembly.
              // PASS8 A2 + A5: Reuse the already-assembled baseSystemPrompt parts
              // (workspace project layers + active mode block) plus the Ask appendices.
              const askParts = constructSystemPromptParts({
                chatMode: "ask",
                effectiveWorkMode: modeBlockKey,
                contextSize: await getContextWindow(effectiveModel, req.chatId),
                enableTurboEditsV2: false,
                hasWorkspace,
                registeredToolNames: [...askLoadedNames],
                ...promptIdentityOpts,
              });
              const askStableHeader =
                askParts.stableHeader + "\n\n" + askProgressiveNote;
              const {
                bundle: askBundle,
                fullResponse: askRoundFull,
                finishReason: askFr,
              } = await runStreamRoundWithEmptyOutputRetry({
                runSimpleStream: async () =>
                  simpleStreamText({
                    chatMessages: askStreamMessages,
                    modelClient,
                    tools: askTools,
                    systemPromptOverride: askStableHeader,
                    dynamicSystemTail: askParts.dynamicTail,
                    files: files,
                  }),
                fullResponse,
                abortController,
                chatId: req.chatId,
                processResponseChunkUpdate,
                onFirstModelActivity: () => {
                  safeSend(event.sender, "chat:stream:phase", {
                    chatId: req.chatId,
                    phase: "responding",
                    label: "",
                  });
                },
                onFirstTextDelta: logTtftOnce,
                onFirstReasoningDelta: () => {
                  safeSend(event.sender, "chat:activity", {
                    id: `reasoning-${req.chatId}`,
                    type: "reasoning_started",
                    label: "Thinking deeply...",
                    status: "running",
                    timestamp: Date.now(),
                    chatId: req.chatId,
                  });
                },
                onFirstTextAfterReasoning: () => {
                  safeSend(event.sender, "chat:activity", {
                    id: `reasoning-${req.chatId}`,
                    type: "reasoning_complete",
                    label: "Done thinking, writing response...",
                    status: "done",
                    timestamp: Date.now(),
                    chatId: req.chatId,
                  });
                },
                onStreamStall: handleStreamStall,
                onToolInputProgress: handleToolInputProgress,
                onStreamActivityPulse: handleStreamActivityPulse,
              });
              fullResponse = askRoundFull;
              if (
                !shouldContinue(askFr, {
                  attemptCount: streamContinuationAttempts,
                  maxAttempts: STREAM_CONTINUATION_MAX,
                })
              ) {
                break;
              }
              streamContinuationAttempts++;
              const askResp = await askBundle.response;
              askStreamMessages = [
                ...askStreamMessages,
                ...(askResp.messages as ModelMessage[]),
                {
                  role: "user",
                  content: buildContinuationPrompt({
                    chatId: req.chatId,
                    turnId: String(placeholderAssistantMessage.id),
                    attemptCount: streamContinuationAttempts,
                    maxAttempts: STREAM_CONTINUATION_MAX,
                    lastContent: stripThinkBlocks(fullResponse),
                    ledgerState: getLedgerStateForContinuation(),
                  }),
                },
              ];

              // Inject the repetition-guard correction (if any) so the next
              // dispatch nudges the model away from the same read/search.
              // Mirrors Build-mode wiring (chat_stream_handlers `agenticMessages`).
              const askLoopCorrection = askAgenticRepetition.takePendingCorrection();
              if (askLoopCorrection) {
                askStreamMessages.push({
                  role: "user" as const,
                  content: askLoopCorrection,
                });
              }

              // Hard stop after the model ignored the correction twice — Ask
              // mode has nowhere to delegate write/run mitigation, so we
              // break the loop and surface a clear message. Ask mode uses
              // native tool calling exclusively, so the fullResponse never
              // contains text-tool XML (no stripToolCallXML needed here,
              // unlike the Build branch which supports both call shapes).
              if (askAgenticRepetition.consumeLoopBreak()) {
                logger.warn(
                  "[Ask tier] Stopping after repeated read/search (repetition guard)",
                );
                fullResponse =
                  fullResponse +
                  "\n\n[Repeated action — task stopped. Review the activity log and send a message to continue.]";
                break;
              }

              // PASS8-FIX: Tool results are appended above, THEN prune, THEN
              // compaction. Compaction never runs before the current round's
              // tool results land in the message accumulator.
              // PASS8 D1: Prune large tool outputs between rounds before compaction.

              // PASS8 C1-C4: Compaction mirrored from Build into all agentic loops.
              {
                const askCompaction = await runMidLoopCompaction({
                  messages: askStreamMessages,
                  systemPromptEstimate: estimateTokens(askStableHeader + "\n\n" + askParts.dynamicTail),
                  tierLimit: modelContextResolved.tierLimit,
                  contextWindowTokens,
                  enabled: settings.enableContextAutoSummarize !== false,
                  chatId: req.chatId,
                  loopLabel: "Ask tier",
                  emitActivity: emitCompactionMirroredActivity(event.sender, req.chatId),
                  onInfo: (msg) => logger.log(msg),
                  onWarn: (msg, err) => logger.warn(msg, err),
                });
                if (askCompaction.compacted) {
                  askStreamMessages = askCompaction.messages;
                }
              }

              // Mid-stream tier escalation (Auto mode only — manual selections
              // short-circuit inside `maybeEscalateTier`). Reuses the running
              // dispatchEstimate as a cheap token proxy and bumps the loop
              // counter so the gate only fires every N=4 iterations or once
              // we cross 60% of the tier budget. Skipped if the iteration is
              // still pre-counter (i.e. the very first round).
              askAgenticIteration++;
              try {
                const askRunningTokens = estimateTokens(
                  askStableHeader +
                    "\n\n" +
                    askParts.dynamicTail +
                    "\n\n" +
                    askStreamMessages
                      .map((m) =>
                        typeof m.content === "string" ? m.content : "",
                      )
                      .join("\n"),
                );
                await applyTierEscalation({
                  agenticIteration: askAgenticIteration,
                  iterationInterval: 4,
                  runningTokens: askRunningTokens,
                  mode: effectiveWorkMode === "plan" ? "plan" : "ask",
                });
              } catch (escalationErr) {
                logger.warn(
                  `[Ask tier] tier escalation guard failed: ${String(escalationErr)}`,
                );
              }
            }
            askAgenticRepetition.setEnabled(false);
          } else {
            // BUILD MODE - Native tool calling (like Agent mode)
            // AI has access to all workspace tools via function calling
            // Permission interceptor buffers write operations for user approval
            logger.log("Build mode with native tool calling + permission system");

            // v3.9: Snapshot synchronously at exchange start (before any tool runs) for conversation revert
            if (effectiveAppId != null && appPath) {
              try {
                const snap = await createSnapshot(
                  effectiveAppId,
                  "pre-exchange",
                  appPath,
                  updatedChat.messages.map((m: any) => ({ role: m.role, content: m.content ?? "" }))
                );
                preExchangeSnapshotId = snap.id;
                logger.log(`[Build Mode] Created pre-exchange snapshot: ${preExchangeSnapshotId}`);
              } catch (snapErr) {
                logger.warn("Failed to create pre-exchange snapshot:", snapErr);
              }
            }

            const workspacePath = appPath;
            let workspaceOverride: { path: string; id: number } | null = null;
            const buildModeToolsMetadata = ToolRegistry.getToolsForContext(hasWorkspace);
            const buildLoader = getOrCreateToolSessionLoader(req.chatId);
            if (hasWorkspace && effectiveAppId != null) {
              buildLoader.ensureLoaded(WORKSPACE_INTEGRATION_TOOL_NAMES);
            }
            const buildLoadedNames = buildLoader.getLoadedToolNames();
            const buildToolsToInclude = buildModeToolsMetadata.filter(
              (t) =>
                buildLoadedNames.has(t.name) ||
                isCoreTool(t) ||
                (hasWorkspace && isWorkspaceIntegrationTool(t.name)),
            );
            let buildSystemPromptWithManifest =
              systemPrompt +
              "\n\n" +
              generateProgressiveRevealNote(
                buildToolsToInclude.map((t) => t.name),
                effectiveWorkMode,
              );

            // Create permission interceptor for this session
            const permissionInterceptor = new PermissionInterceptor(
              workspacePath,
              effectiveAppId ?? undefined,
              streamTurnIdForLedger,
              req.chatId,
            );

            // Register interceptor for IPC handlers (so UI can approve/reject)
            registerInterceptor(req.chatId, permissionInterceptor);

            const autonomousTurnId = String(placeholderAssistantMessage.id);

            // Listen for terminal output events and forward to frontend; v3.9: also feed to StreamManager for stream_terminal_output
            permissionInterceptor.on('terminal-output', (payload: any) => {
              feedTerminalOutput(req.chatId, payload.output ?? "");
              safeSend(event.sender, "terminal-output", {
                chatId: req.chatId,
                commandId: payload.operationId,
                command: payload.command,
                output: payload.output,
                status: payload.status,
                exitCode: payload.exitCode,
                source: "agent",
                isPermissionBased: true, // Don't force-switch to terminal tab
              });
              logger.log(`[Build Mode] Terminal output sent: ${payload.command} (${payload.status})`);
            });

            const recentCompletedBuildToolNames: string[] = [];

            const agenticRepetition = createAgenticRepetitionState();
            const handleAgenticRepetitionOutcome = (o: AgenticRepetitionOutcome) => {
              if (o.kind === "none") return;
              if (o.kind === "loop_detected") {
                safeSend(event.sender, "chat:activity", {
                  id: `loop-detected-${Date.now()}`,
                  type: "loop_detected",
                  label: "Repeated action detected",
                  detail: `${o.toolName} on the same target ${o.count}+ times in a short window — self-correcting`,
                  status: "running",
                  timestamp: Date.now(),
                  chatId: req.chatId,
                  toolName: o.toolName,
                  loopTarget: o.target,
                  loopCount: o.count,
                });
                return;
              }
              safeSend(event.sender, "chat:activity", {
                id: `loop-abort-${Date.now()}`,
                type: "loop_repetition_aborted",
                label: "Task stopped — repeated action",
                detail:
                  "The model kept repeating the same write or command after guidance. Review the activity log and send a message to continue.",
                status: "done",
                timestamp: Date.now(),
                chatId: req.chatId,
                toolName: o.toolName,
                loopTarget: o.target,
                loopCount: o.count,
              });
            };

            const tools: ToolSet = {};
            for (const toolMeta of buildToolsToInclude) {
              const toolName = toolMeta.name;
              tools[toolName] = {
                description: toolMeta.description,
                inputSchema: aiJsonSchema((toolMeta.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>),
                execute: async (args: any) => {
                  buildLoader.onToolCall(toolName);
                  const buildToolStartMs = Date.now();
                  if (streamDebugLogging) {
                    logger.log(`[Build Tool] start`, {
                      toolName,
                      chatId: req.chatId,
                      argsKeys:
                        args && typeof args === "object"
                          ? Object.keys(args as object)
                          : [],
                    });
                  }
                  const toolActivityId = `tool-${toolName}-${Date.now()}`;
                  let activityStatus: "done" | "error" = "done";
                  let toolResultForActivity: unknown;
                  const isStreamTool = toolName === "stream_terminal_output";
                  // Fix: Finding 4 — status line (stream tools use inner _sendToolActivity only)
                  const uiToolLabel = getToolActivityLabel(toolName);
                  if (!isStreamTool) {
                    safeSend(event.sender, "chat:tool:start", {
                      chatId: req.chatId,
                      toolId: toolName,
                      toolName: uiToolLabel,
                      toolArgs: args,
                    });
                  }
                  safeSend(event.sender, "chat:activity", {
                    id: toolActivityId,
                    type: "tool_use",
                    label: getToolActivityLabel(toolName),
                    status: "running",
                    timestamp: Date.now(),
                    chatId: req.chatId,
                    toolName,
                    toolArgs: args,
                  });
                  try {
                    const buildLiveWorkMode: WorkMode =
                      readSettings().workModePreference ?? effectiveWorkMode;
                    const debugGateBuild = debugWriteGateResult(
                      req.chatId,
                      toolName,
                      buildLiveWorkMode,
                      args,
                    );
                    if (debugGateBuild) return debugGateBuild;
                    if (toolName === "compress_context") {
                      // PASS2: Compaction is model-triggered via compress_context.
                      // Emit activity + run compaction here (tool handler has no stream scope).
                      const reason =
                        args && typeof args.reason === "string" && args.reason.trim()
                          ? args.reason.trim()
                          : "model-initiated";

                      try {
                        const providerId =
                          getEffectiveModelForOptions(settings)?.provider ??
                          (settings.selectedModel?.provider ?? undefined);
                        const { executeCompressContext } = await import("@/lib/tools/workspace");
                        const msgList = updatedChat.messages as { id: number; role: string; content: string }[];
                        const outcome = await executeCompressContext(
                          { reason },
                          {
                            chatId: req.chatId,
                            messages: msgList.map((m) => ({ id: m.id, role: m.role, content: m.content || "" })),
                            systemPromptTokens: 6000,
                            inputTokens: 0,
                            providerId,
                            sessionStats: { toolCallCount: 0, delegationCount: 0 },
                            turnId: String(placeholderAssistantMessage?.id ?? ""),
                          },
                        );

                        safeSend(event.sender, "chat:activity", {
                          id: `compress-context-${req.chatId}-${Date.now()}`,
                          type: "compaction",
                          label: "Context compressed",
                          status: "done",
                          timestamp: Date.now(),
                          // PASS8 F1: tokensBefore/After are estimates, not exact provider counts.
                          detail: `${outcome.tokensBefore} → ${outcome.tokensAfter} est. tokens. ${outcome.status}. ${reason}`,
                          chatId: req.chatId,
                          modelInitiated: true,
                        });

                        return JSON.stringify({
                          success: outcome.success,
                          reason: outcome.reason,
                          tokensBefore: outcome.tokensBefore,
                          tokensAfter: outcome.tokensAfter,
                          summary: outcome.summary,
                          status: outcome.status,
                        });
                      } catch (e) {
                        safeSend(event.sender, "chat:activity", {
                          id: `compress-context-${req.chatId}-${Date.now()}`,
                          type: "compaction",
                          label: "Context compressed",
                          status: "error",
                          timestamp: Date.now(),
                          detail: String(e),
                          chatId: req.chatId,
                          modelInitiated: true,
                        });
                        return JSON.stringify({ success: false, error: String(e), reason });
                      }
                    }

                    const effectivePath = workspaceOverride?.path ?? workspacePath ?? "";
                    const effectiveId = workspaceOverride?.id ?? effectiveAppId ?? undefined;
                    const executeArgs: any = {
                      ...args,
                      workspace: effectivePath || undefined,
                      workspaceId: effectiveId,
                      agentMode: settings.agentMode ?? "direct",
                      chatMode: toolExecutionChatMode(buildLiveWorkMode),
                      _chatSessionId: req.chatId,
                      workspaceSessionId: req.workspaceSessionId ?? undefined,
                    };
                    attachSearchRoutingActivity(executeArgs, event.sender, req.chatId);
                    if (isStreamTool) {
                      executeArgs.chatId = req.chatId;
                      executeArgs._sendToolActivity = (label: string) => {
                        safeSend(event.sender, "chat:tool:start", {
                          chatId: req.chatId,
                          toolId: toolName,
                          toolName: label,
                          toolArgs: executeArgs,
                        });
                        return () => {
                          safeSend(event.sender, "chat:tool:end", { chatId: req.chatId });
                        };
                      };
                    }
                    const result = await runToolExecute(
                      toolName,
                      executeArgs,
                      event.sender,
                      req.chatId,
                      buildToolStreamOpts(),
                    );

                    const askUserResolvedBuild = await resolveAskUserToolResult(
                      event,
                      req.chatId,
                      toolName,
                      result,
                      { finalizeAskUserBreakpoint },
                    );
                    if (askUserResolvedBuild !== null) {
                      return askUserResolvedBuild;
                    }

                    if (
                      toolName === "create_workspace" &&
                      result &&
                      typeof result === "object" &&
                      !permissionInterceptor.isPermissionRequest(result) &&
                      (result as any).workspace_path != null &&
                      (result as any).workspace_id != null
                    ) {
                      const r = result as { workspace_path: string; workspace_id: number };
                      workspaceOverride = { path: r.workspace_path, id: r.workspace_id };
                      permissionInterceptor.setWorkspace(r.workspace_path, r.workspace_id);
                      logger.log(
                        `[Build Mode] Switched to new workspace for this turn: ${r.workspace_path} (id: ${r.workspace_id})`,
                      );
                    }

                    // Check if this is a permission request (object or string)
                  if (permissionInterceptor.isPermissionRequest(result)) {
                    let permRequest = permissionInterceptor.parsePermissionRequest(result);
                    if (permRequest) {
                      if (permRequest.operation === "run_command") {
                        const cmdPreview = permRequest.preview as { command?: string };
                        const cmd = cmdPreview.command ?? "";
                        const gate = runCommandGateResult(
                          cmd,
                          readSettings().workModePreference ?? effectiveWorkMode,
                        );
                        if (gate) return gate;
                        const categoryBlock = runCommandCategoryGateToolResult(
                          cmd,
                          effectiveAppId,
                          req.chatId,
                          event.sender,
                        );
                        if (categoryBlock) return categoryBlock;
                      }
                      const filePref = await applyFileScopePreflightInStream(
                        permRequest,
                        effectiveAppId,
                        req.chatId,
                        event.sender,
                        permissionInterceptor,
                        (label, detail) =>
                          emitFilePermissionActivity(event.sender, req.chatId, label, detail),
                        (message) =>
                          safeSend(event.sender, "file-permission-blocked", {
                            chatId: req.chatId,
                            message,
                          }),
                      );
                      if (filePref.earlyReturn) return filePref.earlyReturn;
                      permRequest = filePref.permRequest;
                      const operationId = permissionInterceptor.generateOperationId();
                      const buildRunCmd =
                        permRequest.operation === "run_command"
                          ? ((permRequest.preview as { command?: string }).command ?? "")
                          : "";
                      const skipPermissionWait =
                        filePref.skipPermissionWait ||
                        (permRequest.operation === "run_command" &&
                          shouldSkipPermissionWaitForRunCommand(
                            buildRunCmd,
                            effectiveAppId,
                            req.chatId,
                            event.sender,
                          )) ||
                        shouldAutoApprovePermissions(settings.agentMode, req.chatId) ||
                        permissionInterceptor.shouldAlwaysAutoApprove(permRequest);
                      permissionInterceptor.bufferOperation(operationId, permRequest, skipPermissionWait);

                      const pushWrittenPaths = () => {
                        if (!permRequest) return;
                        const preview = permRequest.preview as { path?: string; paths?: string[] };
                        if (permRequest.operation === "write_multiple_files" && preview.paths?.length) {
                          filesWrittenInThisExchange.push(...preview.paths);
                        } else if (preview.path) {
                          filesWrittenInThisExchange.push(preview.path);
                        }
                      };

                      const jsonAfterSuccessfulExec = (execResult: {
                        path?: string;
                        output?: string;
                        exitCode?: number;
                        error?: string;
                      }) => {
                        if (!permRequest) return "";
                        pushWrittenPaths();
                        if (
                          agenticRepetition.isEnabled() &&
                          (permRequest.operation === "write_file" ||
                            permRequest.operation === "run_command")
                        ) {
                          const pv = permRequest.preview as { path?: string; command?: string };
                          const permArgs =
                            permRequest.operation === "run_command"
                              ? { command: pv.command ?? "" }
                              : { path: pv.path ?? "" };
                          handleAgenticRepetitionOutcome(
                            agenticRepetition.record(permRequest.operation, permArgs),
                          );
                        }
                        recordBuildToolLedger(permRequest.operation, {
                          path: (permRequest.preview as { path?: string }).path,
                          success: true,
                          output: execResult.output?.slice(0, 200),
                        });
                        const output = execResult.output || "";
                        const hasCompilationErrors =
                          /error:|Error:|ERROR:|failed to|Failed to|Cannot find|cannot find|is not defined|is not a function|SyntaxError|TypeError|ReferenceError/i.test(
                            output,
                          );
                        if (hasCompilationErrors) {
                          logger.log(`[Build Mode] Command output contains errors: ${operationId}`);
                          return JSON.stringify({
                            success: true,
                            hasErrors: true,
                            warning:
                              "The command ran but the output shows errors. Please review the output and fix the underlying code issue before running the same command again.",
                            message: `Command started but output shows errors`,
                            path: execResult.path,
                            output: output.slice(-2000),
                          });
                        }
                        return JSON.stringify({
                          success: true,
                          message: `Successfully ${permRequest.operation === "write_file" ? "wrote" : "executed"} ${(permRequest.preview as { path?: string }).path || "operation"}`,
                          path: execResult.path,
                          output: execResult.output,
                        });
                      };

                      if (skipPermissionWait) {
                        try {
                          logger.log(`[Build Mode] Autonomous auto-exec: ${operationId}`);
                          const execMeta = await permissionInterceptor.executeOperation(operationId);
                          const execResult = permissionInterceptor.getExecutionResult(operationId);
                          appendAutonomousOp(
                            req.chatId,
                            autonomousTurnId,
                            autonomousOpFromPermissionExec(
                              operationId,
                              permRequest.operation,
                              permRequest.preview,
                              execMeta.approved,
                            ),
                          );
                          if (execMeta.approved) {
                            logger.log(`[Build Mode] Autonomous permission executed: ${operationId}`);
                            return jsonAfterSuccessfulExec(execResult);
                          }
                          if (execResult.exitCode !== undefined) {
                            logger.log(
                              `[Build Mode] Autonomous exec command failed: ${operationId} (exit ${execResult.exitCode})`,
                            );
                            return JSON.stringify({
                              success: false,
                              error:
                                execResult.error ||
                                `Command failed with exit code ${execResult.exitCode}`,
                              exitCode: execResult.exitCode,
                              output: execResult.output,
                              operation: permRequest.operation,
                              path:
                                (permRequest.preview as { path?: string; command?: string }).path ||
                                (permRequest.preview as { command?: string }).command,
                            });
                          }
                          return JSON.stringify({
                            success: false,
                            error: execMeta.error ?? execResult.error ?? "Execution failed",
                            operation: permRequest.operation,
                            path: (permRequest.preview as { path?: string }).path,
                          });
                        } catch (error) {
                          logger.error(`[Build Mode] Autonomous permission error: ${operationId}`, error);
                          return JSON.stringify({
                            success: false,
                            error: `Permission request failed: ${error instanceof Error ? error.message : String(error)}`,
                            timedOut: true,
                          });
                        }
                      }

                      // Send permission request to frontend for display
                      safeSend(event.sender, "permission-request", {
                        chatId: req.chatId,
                        operationId,
                        request: enrichPermissionRequestForUi(permRequest, effectiveAppId),
                      });

                      logger.log(`[Build Mode] Permission request buffered: ${operationId}`);

                      try {
                        if (streamDebugLogging) {
                          logger.log(`[Build Tool] waitForApproval start`, {
                            operationId,
                            operation: permRequest.operation,
                            chatId: req.chatId,
                          });
                        }
                        // BLOCKING: Wait for user to approve or reject
                        const approved = await permissionInterceptor.waitForApproval(operationId);
                        if (streamDebugLogging) {
                          logger.log(`[Build Tool] waitForApproval end`, {
                            operationId,
                            approved,
                            chatId: req.chatId,
                          });
                        }

                        if (approved) {
                          // User approved - return success to AI
                          const execResult = permissionInterceptor.getExecutionResult(operationId);
                          logger.log(`[Build Mode] Permission approved: ${operationId}`);

                          return jsonAfterSuccessfulExec(execResult);
                        } else {
                          // Check if this was a command failure vs user rejection
                          const execResult = permissionInterceptor.getExecutionResult(operationId);

                          if (execResult.exitCode !== undefined) {
                            // Command was executed but failed - include error details for AI
                            logger.log(`[Build Mode] Command failed: ${operationId} (exit ${execResult.exitCode})`);
                            return JSON.stringify({
                              success: false,
                              error: execResult.error || `Command failed with exit code ${execResult.exitCode}`,
                              exitCode: execResult.exitCode,
                              output: execResult.output,  // Include terminal output for AI context
                              operation: permRequest.operation,
                              path: (permRequest.preview as any).path || (permRequest.preview as any).command,
                            });
                          } else {
                            // User actually rejected or timeout
                            logger.log(`[Build Mode] Permission denied: ${operationId}`);
                            return JSON.stringify({
                              success: false,
                              error: "Permission denied by user",
                              operation: permRequest.operation,
                              path: (permRequest.preview as any).path,
                            });
                          }
                        }
                      } catch (error) {
                        logger.error(`[Build Mode] Permission error: ${operationId}`, error);
                        return JSON.stringify({
                          success: false,
                          error: `Permission request failed: ${error instanceof Error ? error.message : String(error)}`,
                          timedOut: true,
                        });
                      }
                    }
                  }

                    // Not a permission request - return result directly
                    if (!isStreamTool) {
                    }
                    if (agenticRepetition.isEnabled()) {
                      handleAgenticRepetitionOutcome(agenticRepetition.record(toolName, args));
                    }
                    recordBuildToolLedger(toolName, result);
                    toolResultForActivity = result;
                    return typeof result === "string" ? result : JSON.stringify(result);
                  } catch (err) {
                    activityStatus = "error";
                    toolResultForActivity = err;
                    throw err;
                  } finally {
                    if (!isStreamTool) {
                      recentCompletedBuildToolNames.push(toolName);
                      while (recentCompletedBuildToolNames.length > 3) {
                        recentCompletedBuildToolNames.shift();
                      }
                    }
                    if (!isStreamTool) {
                      const activityDetail = summarizeToolResultForActivityDetail(
                        toolName,
                        toolResultForActivity,
                        activityStatus === "error" ? "error" : "done",
                      );
                      const resultText = toolResultTextForExpand(toolResultForActivity);
                      if (streamDebugLogging) {
                        logger.log(`[Build Tool] end`, {
                          toolName,
                          chatId: req.chatId,
                          ms: Date.now() - buildToolStartMs,
                          status: activityStatus,
                        });
                      }
                      safeSend(event.sender, "chat:tool:end", { chatId: req.chatId });
                      safeSend(event.sender, "chat:activity", {
                        id: toolActivityId,
                        type: "tool_use",
                        label: getToolActivityLabel(toolName),
                        status: activityStatus,
                        timestamp: Date.now(),
                        chatId: req.chatId,
                        toolName,
                        toolArgs: args,
                        ...(activityDetail ? { detail: activityDetail } : {}),
                        ...(resultText ? { resultText } : {}),
                      });
                    }
                  }
                },
              };
            }

            // Pass 7: MCP tools are no longer pre-merged for workspace Build chats.
            // The model calls list_available_mcps + mcp_call from the registry on demand.

            if (isDelegationAllowedForWorkMode(effectiveWorkMode)) {
              attachDelegationToolsToSet(tools, {
                sender: event.sender,
                chatId: req.chatId,
                effectiveWorkMode,
                workspacePath: workspacePath || undefined,
                workspaceId: effectiveAppId ?? undefined,
                turnId: autonomousTurnId,
                safeSend,
                recordToolUseForTurn,
                onDelegated: (agentId) => delegatedAgentsThisTurn.push(agentId),
                getDelegationCount: () => delegationsStartedThisTurn,
                onDelegationStart: () => {
                  delegationsStartedThisTurn += 1;
                },
                tryAcquireDedupeKey: (key) => {
                  if (inFlightDelegationKeys.has(key)) return false;
                  inFlightDelegationKeys.add(key);
                  return true;
                },
                releaseDedupeKey: (key) => {
                  inFlightDelegationKeys.delete(key);
                },
                maxConcurrentDelegations: delegationRuntime.maxConcurrentDelegations,
              });
            }

            logger.log(`Build mode: ${Object.keys(tools).length} tools available`);

            const recordBuildToolLedger = (name: string, payload: unknown) => {
              try {
                if (
                  payload &&
                  typeof payload === "object" &&
                  (payload as { __permission_required?: boolean }).__permission_required === true
                ) {
                  return;
                }
                const summary =
                  typeof payload === "string"
                    ? payload.slice(0, 400)
                    : JSON.stringify(payload).slice(0, 400);
                const fr: string[] = [];
                const fw: string[] = [];
                if (payload && typeof payload === "object") {
                  const o = payload as Record<string, unknown>;
                  if (typeof o.path === "string") {
                    const p = o.path.split(/[/\\]/).join("/");
                    if (
                      /read_file|explore_folder|search|list_files|find_file|read_url|get_/.test(
                        name,
                      )
                    ) {
                      fr.push(p);
                    } else {
                      fw.push(p);
                    }
                  }
                }
                recordToolOnLedger(streamTurnIdForLedger, {
                  toolName: name,
                  summary,
                  filesRead: fr.length ? fr : undefined,
                  filesWritten: fw.length ? fw : undefined,
                });
              } catch {
                /* noop */
              }
            };

            // ═══════════════════════════════════════════════════════════════
            // SMART AGENTIC TOOL LOOP
            // - No artificial iteration ceiling (runs until natural completion)
            // - 30 min wall-clock cap (all work modes & agent modes; see STREAM_TOOL_LOOP_DURATION_CAP_MS)
            // - Completion detection (AI signals when done)
            // - Progress emission to frontend
            // ═══════════════════════════════════════════════════════════════
            const loopStartTime = Date.now();
            let agenticIteration = 0;
            let agenticProseOnlyStreak = 0;
            /** Safety cap when the model keeps replying without tools or <task_complete>. */
            const AGENTIC_PROSE_ONLY_MAX = 5;
            let agenticMessages = [...chatMessages]; // Copy current messages
            let allToolResults: { tool: string; result: string }[] = [];
            let totalToolExecutions = 0; // Track total tools executed across all iterations

            let streamAbortLedgerCompleteCaptured = false;
            const captureStreamAbortLedgerCompleteIfNeeded = () => {
              if (streamAbortLedgerCompleteCaptured) return;
              streamAbortLedgerCompleteCaptured = true;
              captureSafe("stream_abort_ledger_complete", {
                chat_id: req.chatId,
                iterations: agenticIteration,
                tools_executed: totalToolExecutions,
              });
            };

            const { containsTextToolCall, parseTextToolCalls, stripToolCallXML } = await import("../utils/text_tool_parser");
            const useTextToolFallback = shouldUseTextToolFallback(
              modelClient.builtinProviderId,
            );

            try {
              agenticRepetition.setEnabled(true);
              for (;;) {
                if (Date.now() - loopStartTime > STREAM_TOOL_LOOP_DURATION_CAP_MS) {
                  logger.warn(
                    `[Agentic Loop] Hit duration limit (30 minutes) chatMode=${settings.selectedChatMode ?? "?"} agentMode=${settings.agentMode ?? "?"}`,
                  );
                  safeSend(event.sender, "chat:activity", {
                    id: `duration-limit-${Date.now()}`,
                    type: "duration_limit_reached",
                    label: "Task paused after 30 minutes",
                    detail: "Send a message to continue",
                    status: "done",
                    timestamp: Date.now(),
                    chatId: req.chatId,
                  });
                  break;
                }

                // Emit progress to frontend (maxIterations 0 = unbounded in UI)
                safeSend(event.sender, "chat:iteration:progress", {
                  chatId: req.chatId,
                  iteration: agenticIteration + 1,
                  maxIterations: 0,
                  totalToolsExecuted: totalToolExecutions,
                });

                logger.log(`[Agentic Loop] Iteration ${agenticIteration + 1} (unbounded)`);

                buildSystemPromptWithManifest =
                  systemPrompt +
                  "\n\n" +
                  generateProgressiveRevealNote(
                    [...buildLoader.getLoadedToolNames()],
                    effectiveWorkMode,
                  );

                let buildIterMessages: ModelMessage[] = agenticMessages;
                let streamRoundDone = false;
                while (!streamRoundDone) {
                  const {
                    bundle: buildBundle,
                    fullResponse: buildRoundFull,
                    finishReason: buildFr,
                  } = await runStreamRoundWithEmptyOutputRetry({
                    runSimpleStream: async () =>
                      simpleStreamText({
                        chatMessages: buildIterMessages,
                        modelClient,
                        tools,
                        systemPromptOverride: buildSystemPromptWithManifest,
                        files: files,
                      }),
                    fullResponse,
                    abortController,
                    chatId: req.chatId,
                    processResponseChunkUpdate,
                    onFirstModelActivity: () => {
                      safeSend(event.sender, "chat:stream:phase", {
                        chatId: req.chatId,
                        phase: "responding",
                        label: "",
                      });
                    },
                    onFirstTextDelta: logTtftOnce,
                    onFirstReasoningDelta: () => {
                      safeSend(event.sender, "chat:activity", {
                        id: `reasoning-started-${req.chatId}-${Date.now()}`,
                        type: "reasoning_started",
                        label: "Thinking deeply...",
                        status: "running",
                        timestamp: Date.now(),
                        chatId: req.chatId,
                      });
                    },
                    onFirstTextAfterReasoning: () => {
                      safeSend(event.sender, "chat:activity", {
                        id: `reasoning-${req.chatId}`,
                        type: "reasoning_complete",
                        label: "Done thinking, writing response...",
                        status: "done",
                        timestamp: Date.now(),
                        chatId: req.chatId,
                      });
                    },
                    onStreamStall: handleStreamStall,
                    onToolInputProgress: handleToolInputProgress,
                    onStreamActivityPulse: handleStreamActivityPulse,
                    sanitizeTextDelta: stripHallucinatedAtlarixToolTagsFromDelta,
                  });
                  fullResponse = buildRoundFull;
                  const buildResp = await buildBundle.response;
                  const respMsgs = buildResp.messages as ModelMessage[];

                  if (
                    shouldContinue(buildFr, {
                      attemptCount: streamContinuationAttempts,
                      maxAttempts: STREAM_CONTINUATION_MAX,
                    })
                  ) {
                    streamContinuationAttempts++;
                    buildIterMessages = [
                      ...buildIterMessages,
                      ...respMsgs,
                      {
                        role: "user",
                        content: buildContinuationPrompt({
                          chatId: req.chatId,
                          turnId: String(placeholderAssistantMessage.id),
                          attemptCount: streamContinuationAttempts,
                          maxAttempts: STREAM_CONTINUATION_MAX,
                          lastContent: stripThinkBlocks(fullResponse),
                          ledgerState: getLedgerStateForContinuation(),
                        }),
                      },
                    ];
                    continue;
                  }

                  const ledgerNow = getLedger(streamTurnIdForLedger);
                  const pendingForContinue =
                    ledgerNow &&
                    buildFr === "stop" &&
                    !isLedgerTaskComplete(ledgerNow) &&
                    streamContinuationAttempts < STREAM_CONTINUATION_MAX
                      ? getRemainingSteps(ledgerNow)
                      : [];

                  if (pendingForContinue.length > 0) {
                    streamContinuationAttempts++;
                    const ledgerSnap = getLedgerStateString(streamTurnIdForLedger);
                    buildIterMessages = [
                      ...buildIterMessages,
                      ...respMsgs,
                      {
                        role: "user",
                        content:
                          buildPendingStepsContinuationPrompt(pendingForContinue) +
                          (ledgerSnap ? `\n\nCurrent task state:\n${ledgerSnap}` : ""),
                      },
                    ];
                    continue;
                  }

                  streamRoundDone = true;
                }

                // ═══════════════════════════════════════════════════════════
                // OPTION A: Track tool execution (works with ALL providers)
                // ═══════════════════════════════════════════════════════════

                // Check for text-based tool calls (MiniMax, Claude XML, etc.)
                const hasTextToolCalls =
                  useTextToolFallback && containsTextToolCall(fullResponse);

                // Check how many operations were buffered in this iteration
                // (This tracks native function calling - Claude, GPT via OpenRouter)
                const currentOpCount = permissionInterceptor.getAllOperationsCount();
                const executedOpCount = permissionInterceptor.getExecutedOperationsCount();
                logger.log(`[Agentic Loop] Operation counts: total=${currentOpCount}, executed=${executedOpCount}, tracked=${totalToolExecutions}`);

                const hadNativeToolExecution = currentOpCount > totalToolExecutions;

                if (hasTextToolCalls) {
                  logger.log("[Agentic Loop] Detected text-based tool calls, parsing and executing...");
                } else if (hadNativeToolExecution) {
                  const newOps = currentOpCount - totalToolExecutions;
                  logger.log(`[Agentic Loop] Native tool calls detected (${newOps} new operations, ${currentOpCount} total)`);
                  totalToolExecutions = currentOpCount;
                }

                if (streamDebugLogging) {
                  logger.log(`[Agentic Loop] Round summary`, {
                    iteration: agenticIteration + 1,
                    hasTextToolCalls,
                    hadNativeToolExecution,
                    responseTail: fullResponse.slice(-200),
                  });
                }

                // End only on explicit <task_complete> or a completed task ledger
                if (isTaskComplete(fullResponse)) {
                  logger.info(`[Agentic Loop] Task completed at iteration ${agenticIteration + 1}`);
                  break;
                }

                const ledgerAfterRound = getLedger(streamTurnIdForLedger);
                if (ledgerAfterRound && isLedgerTaskComplete(ledgerAfterRound)) {
                  logger.info(
                    `[Agentic Loop] Ledger complete at iteration ${agenticIteration + 1}`,
                  );
                  break;
                }

                // Prose-only round: nudge the model to keep working instead of ending the turn
                if (!hasTextToolCalls && !hadNativeToolExecution) {
                  agenticProseOnlyStreak++;
                  if (agenticProseOnlyStreak >= AGENTIC_PROSE_ONLY_MAX) {
                    logger.warn(
                      `[Agentic Loop] Prose-only cap (${AGENTIC_PROSE_ONLY_MAX}) reached; ending loop`,
                    );
                    break;
                  }
                  const pendingSteps = ledgerAfterRound
                    ? getRemainingSteps(ledgerAfterRound)
                    : [];
                  const ledgerSnap = getLedgerStateString(streamTurnIdForLedger);
                  const nudge =
                    pendingSteps.length > 0
                      ? buildPendingStepsContinuationPrompt(pendingSteps) +
                        (ledgerSnap ? `\n\nCurrent task state:\n${ledgerSnap}` : "")
                      : "You replied without using tools or finishing. Continue the task: call tools as needed, then emit <task_complete> when fully done.";
                  agenticMessages.push({
                    role: "assistant" as const,
                    content: stripAssistantDisplayContent(stripToolCallXML(fullResponse)),
                  });
                  agenticMessages.push({
                    role: "user" as const,
                    content: nudge,
                  });
                  agenticIteration++;
                  logger.log(
                    `[Agentic Loop] Prose-only streak ${agenticProseOnlyStreak}/${AGENTIC_PROSE_ONLY_MAX}; continuing`,
                  );
                  continue;
                }

                agenticProseOnlyStreak = 0;

                // Parse and execute text-based tool calls
                const textToolCalls = hasTextToolCalls ? parseTextToolCalls(fullResponse) : [];

                if (hasTextToolCalls && textToolCalls.length === 0) {
                  logger.log("[Agentic Loop] No parseable tool calls found, ending loop");
                  break;
                }

                // Execute text-based tools. When all are read-only, run in parallel (Phase 5).
                const iterationResults: { tool: string; result: string }[] = [];
                let hasPermissionRequest = hadNativeToolExecution; // Carry forward native tool detection

                const readOnlyNames = new Set(
                  ToolRegistry.getAll().filter((t) => t.isReadOnly).map((t) => t.name)
                );
                const allReadOnly =
                  textToolCalls.length > 1 &&
                  textToolCalls.every((tc) => readOnlyNames.has(tc.toolName));

                if (allReadOnly) {
                  for (const tc of textToolCalls) {
                    safeSend(event.sender, "chat:tool:start", {
                      chatId: req.chatId,
                      toolId: tc.toolName,
                      toolName: getToolActivityLabel(tc.toolName),
                      toolArgs: tc.args,
                    });
                  }
                }
                const toolCallsToProcess = allReadOnly
                  ? await Promise.all(
                      textToolCalls.map(async (tc) => {
                        const argsWithWorkspace = {
                          ...tc.args,
                          workspace: workspacePath || undefined,
                          workspaceId: effectiveAppId ?? undefined,
                          chatMode: "build",
                          _chatSessionId: req.chatId,
                      workspaceSessionId: req.workspaceSessionId ?? undefined,
                        };
                        attachSearchRoutingActivity(argsWithWorkspace, event.sender, req.chatId);
                        try {
                          const r = await runToolExecute(
                            tc.toolName,
                            argsWithWorkspace,
                            event.sender,
                            req.chatId,
                            buildToolStreamOpts(),
                          );
                          return { toolCall: tc, toolResult: r };
                        } catch (e) {
                          return {
                            toolCall: tc,
                            toolResult: `Error: ${e instanceof Error ? e.message : String(e)}`,
                          };
                        }
                      })
                    )
                  : null;

                if (allReadOnly) {
                  logger.log(`[Agentic Loop] Executed ${textToolCalls.length} read-only tools in parallel`);
                }

                const recordAgenticTextToolRepetitionIfTracked = (
                  name: string,
                  args: Record<string, unknown>,
                  resultStr: string,
                ) => {
                  if (!agenticRepetition.isEnabled()) return;
                  if (name !== "write_file" && name !== "run_command") return;
                  if (resultStr.startsWith("Error:")) return;
                  try {
                    const j = JSON.parse(resultStr) as { success?: boolean };
                    if (j.success === false) return;
                  } catch {
                    /* non-JSON: still allow repetition tracking */
                  }
                  handleAgenticRepetitionOutcome(agenticRepetition.record(name, args));
                };

                for (let i = 0; i < textToolCalls.length; i++) {
                  const toolCall = textToolCalls[i];
                  if (!toolCallsToProcess) {
                    safeSend(event.sender, "chat:tool:start", {
                      chatId: req.chatId,
                      toolId: toolCall.toolName,
                      toolName: getToolActivityLabel(toolCall.toolName),
                      toolArgs: toolCall.args,
                    });
                  }
                  let toolResult: unknown;

                  if (toolCallsToProcess) {
                    toolResult = toolCallsToProcess[i].toolResult;
                  } else {
                    try {
                      if (!tools[toolCall.toolName]) {
                        toolResult = `Error: Unknown tool "${toolCall.toolName}"`;
                      } else {
                        const argsWithWorkspace = {
                          ...toolCall.args,
                          workspace: workspacePath || undefined,
                          workspaceId: effectiveAppId ?? undefined,
                          chatMode: "build",
                          _chatSessionId: req.chatId,
                      workspaceSessionId: req.workspaceSessionId ?? undefined,
                        };
                        attachSearchRoutingActivity(argsWithWorkspace, event.sender, req.chatId);
                        toolResult = await runToolExecute(
                          toolCall.toolName,
                          argsWithWorkspace,
                          event.sender,
                          req.chatId,
                          buildToolStreamOpts(),
                        );
                      }
                    } catch (toolError) {
                      toolResult = `Error: ${toolError instanceof Error ? toolError.message : String(toolError)}`;
                    }
                  }
                  safeSend(event.sender, "chat:tool:end", { chatId: req.chatId });

                  try {
                    const askUserAgentic = await resolveAskUserToolResult(
                      event,
                      req.chatId,
                      toolCall.toolName,
                      toolResult,
                      { finalizeAskUserBreakpoint },
                    );
                    if (askUserAgentic !== null) {
                      iterationResults.push({ tool: toolCall.toolName, result: askUserAgentic });
                      continue;
                    }

                    if (typeof toolResult === "string" && toolResult.startsWith("Error:")) {
                      iterationResults.push({ tool: toolCall.toolName, result: toolResult });
                      continue;
                    }

                    // Check if this is a permission request
                    if (permissionInterceptor.isPermissionRequest(toolResult)) {
                      let permRequest = permissionInterceptor.parsePermissionRequest(toolResult);
                      if (permRequest) {
                        if (permRequest.operation === "run_command") {
                          const cmdPreview = permRequest.preview as { command?: string };
                          const cmd = cmdPreview.command ?? "";
                          const gate = runCommandGateResult(
                            cmd,
                            readSettings().workModePreference ?? effectiveWorkMode,
                          );
                          if (gate) {
                            iterationResults.push({ tool: toolCall.toolName, result: gate });
                            continue;
                          }
                          const categoryBlock = runCommandCategoryGateToolResult(
                            cmd,
                            effectiveAppId,
                            req.chatId,
                            event.sender,
                          );
                          if (categoryBlock) {
                            iterationResults.push({
                              tool: toolCall.toolName,
                              result: categoryBlock,
                            });
                            continue;
                          }
                        }
                        const filePref = await applyFileScopePreflightInStream(
                          permRequest,
                          effectiveAppId,
                          req.chatId,
                          event.sender,
                          permissionInterceptor,
                          (label, detail) =>
                            emitFilePermissionActivity(event.sender, req.chatId, label, detail),
                          (message) =>
                            safeSend(event.sender, "file-permission-blocked", {
                              chatId: req.chatId,
                              message,
                            }),
                        );
                        if (filePref.earlyReturn) {
                          iterationResults.push({
                            tool: toolCall.toolName,
                            result: filePref.earlyReturn,
                          });
                          continue;
                        }
                        permRequest = filePref.permRequest;
                        const operationId = permissionInterceptor.generateOperationId();
                        const agenticRunCmd =
                          permRequest.operation === "run_command"
                            ? ((permRequest.preview as { command?: string }).command ?? "")
                            : "";
                        const skipPermissionWait =
                          filePref.skipPermissionWait ||
                          (permRequest.operation === "run_command" &&
                            shouldSkipPermissionWaitForRunCommand(
                              agenticRunCmd,
                              effectiveAppId,
                              req.chatId,
                              event.sender,
                            )) ||
                          shouldAutoApprovePermissions(settings.agentMode, req.chatId) ||
                          permissionInterceptor.shouldAlwaysAutoApprove(permRequest);
                        permissionInterceptor.bufferOperation(operationId, permRequest, skipPermissionWait);
                        const pushAgenticWrittenPaths = () => {
                          if (!permRequest) return;
                          const preview = permRequest.preview as { path?: string; paths?: string[] };
                          if (permRequest.operation === "write_multiple_files" && preview.paths?.length) {
                            filesWrittenInThisExchange.push(...preview.paths);
                          } else if (preview.path) {
                            filesWrittenInThisExchange.push(preview.path);
                          }
                        };
                        if (skipPermissionWait) {
                          hasPermissionRequest = true;
                          try {
                            const execMeta = await permissionInterceptor.executeOperation(operationId);
                            const execResult = permissionInterceptor.getExecutionResult(operationId);
                            appendAutonomousOp(
                              req.chatId,
                              autonomousTurnId,
                              autonomousOpFromPermissionExec(
                                operationId,
                                permRequest.operation,
                                permRequest.preview,
                                execMeta.approved,
                              ),
                            );
                            if (execMeta.approved) {
                              pushAgenticWrittenPaths();
                              const okPermResult = JSON.stringify({
                                success: true,
                                message: `Operation completed`,
                                path: execResult.path,
                                output: execResult.output,
                              });
                              iterationResults.push({
                                tool: toolCall.toolName,
                                result: okPermResult,
                              });
                              recordAgenticTextToolRepetitionIfTracked(
                                toolCall.toolName,
                                toolCall.args as Record<string, unknown>,
                                okPermResult,
                              );
                            } else if (execResult.exitCode !== undefined) {
                              iterationResults.push({
                                tool: toolCall.toolName,
                                result: JSON.stringify({
                                  success: false,
                                  error:
                                    execResult.error ||
                                    `Command failed with exit code ${execResult.exitCode}`,
                                  exitCode: execResult.exitCode,
                                  output: execResult.output,
                                }),
                              });
                            } else {
                              iterationResults.push({
                                tool: toolCall.toolName,
                                result: JSON.stringify({
                                  success: false,
                                  error:
                                    execMeta.error ??
                                    execResult.error ??
                                    "Execution failed",
                                }),
                              });
                            }
                          } catch (error) {
                            iterationResults.push({
                              tool: toolCall.toolName,
                              result: JSON.stringify({
                                success: false,
                                error: `Permission error: ${error instanceof Error ? error.message : String(error)}`,
                              }),
                            });
                          }
                        } else {
                          safeSend(event.sender, "permission-request", {
                            chatId: req.chatId,
                            operationId,
                            request: enrichPermissionRequestForUi(permRequest, effectiveAppId),
                          });
                          logger.log(`[Agentic Loop] Permission request buffered: ${operationId}`);
                          hasPermissionRequest = true;
                          try {
                            const approved = await permissionInterceptor.waitForApproval(operationId);
                            if (approved) {
                              const execResult = permissionInterceptor.getExecutionResult(operationId);
                              pushAgenticWrittenPaths();
                              const okPermResult2 = JSON.stringify({
                                success: true,
                                message: `Operation completed`,
                                path: execResult.path,
                                output: execResult.output,
                              });
                              iterationResults.push({
                                tool: toolCall.toolName,
                                result: okPermResult2,
                              });
                              recordAgenticTextToolRepetitionIfTracked(
                                toolCall.toolName,
                                toolCall.args as Record<string, unknown>,
                                okPermResult2,
                              );
                            } else {
                              const execResult = permissionInterceptor.getExecutionResult(operationId);
                              if (execResult.exitCode !== undefined) {
                                iterationResults.push({
                                  tool: toolCall.toolName,
                                  result: JSON.stringify({
                                    success: false,
                                    error:
                                      execResult.error ||
                                      `Command failed with exit code ${execResult.exitCode}`,
                                    exitCode: execResult.exitCode,
                                    output: execResult.output,
                                  }),
                                });
                              } else {
                                iterationResults.push({
                                  tool: toolCall.toolName,
                                  result: JSON.stringify({
                                    success: false,
                                    error: "Permission denied by user",
                                  }),
                                });
                              }
                            }
                          } catch (error) {
                            iterationResults.push({
                              tool: toolCall.toolName,
                              result: JSON.stringify({
                                success: false,
                                error: `Permission timeout: ${error instanceof Error ? error.message : String(error)}`,
                              }),
                            });
                          }
                        }
                      }
                    } else {
                      const resultStr = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
                      iterationResults.push({ tool: toolCall.toolName, result: resultStr });
                      recordAgenticTextToolRepetitionIfTracked(
                        toolCall.toolName,
                        toolCall.args as Record<string, unknown>,
                        resultStr,
                      );
                      logger.log(`[Agentic Loop] Tool executed: ${toolCall.toolName} ✓`);
                    }
                  } catch (toolError) {
                    logger.error(`[Agentic Loop] Tool error: ${toolCall.toolName}`, toolError);
                    iterationResults.push({
                      tool: toolCall.toolName,
                      result: `Error: ${toolError instanceof Error ? toolError.message : String(toolError)}`,
                    });
                  }
                }

                // Store all tool results
                allToolResults.push(...iterationResults);
                totalToolExecutions += iterationResults.length; // Track total executions

                // Format tool results to feed back to AI
                const toolResultsMessage =
                  iterationResults
                    .map(
                      (r) => `<tool_result tool="${r.tool}">\n${r.result}\n</tool_result>`,
                    )
                    .join("\n\n");

                // Add assistant's response to message history (strip text-tool XML for cleaner follow-up + UI)
                // Also strip <think> blocks so the model doesn't re-ingest
                // its own reasoning on the next turn.
                agenticMessages.push({
                  role: 'assistant' as const,
                  content: stripAssistantDisplayContent(stripToolCallXML(fullResponse)),
                });

                // Add tool results as a user message so AI can continue
                if (iterationResults.length > 0) {
                  agenticMessages.push({
                    role: 'user' as const,
                    content: `Here are the results of the tools you called:\n\n${toolResultsMessage}\n\nPlease continue with your task based on these results.`,
                  });
                } else if (hadNativeToolExecution) {
                  logger.log(
                    "[Agentic Loop] Skipping empty tool-results user message (native tools executed in-stream)",
                  );
                }

                const loopCorrection = agenticRepetition.takePendingCorrection();
                if (loopCorrection) {
                  agenticMessages.push({
                    role: "user" as const,
                    content: loopCorrection,
                  });
                }

                // PASS8-FIX: Tool results are appended above (the assistant
                // strip + synthetic "Here are the results of the tools you
                // called" user message), THEN compaction. Compaction never
                // runs before the current round's tool results land in
                // agenticMessages.
                // PASS8 C1-C4 (+ G2): Mid-turn auto-compaction via shared helper.
                // The agentic loop accumulates one assistant turn + one synthetic
                // user-with-tool-results turn per iteration; without this the
                // history grows unbounded and a few `read_file` calls on big
                // files can push a single dispatch past the per-tier budget
                // (this is what produced the 8K -> 153K jump in the bug report).
                // Honors `settings.enableContextAutoSummarize` so users can opt out.
                {
                  const compaction = await runMidLoopCompaction({
                    messages: agenticMessages,
                    systemPromptEstimate: estimateTokens(buildSystemPromptWithManifest),
                    tierLimit: modelContextResolved.tierLimit,
                    contextWindowTokens,
                    enabled: settings.enableContextAutoSummarize !== false,
                    chatId: req.chatId,
                    loopLabel: "Agentic Loop",
                    emitActivity: emitCompactionMirroredActivity(event.sender, req.chatId),
                    onInfo: (msg) => logger.log(msg),
                    onWarn: (msg, err) => logger.warn(msg, err),
                  });
                  if (compaction.compacted) {
                    agenticMessages = compaction.messages;
                  }
                }

                // Keep fullResponse for UI continuity - don't reset
                // (Conversation history already has the response)
                agenticIteration++;

                // Mid-stream tier escalation (Auto mode only). Build loops are
                // the heaviest agentic workload — by iteration 4-6 we usually
                // know the user is asking for real architectural work. Reuse
                // the same compaction-input estimate so we don't pay a second
                // tokenizer pass.
                try {
                  const buildRunningTokens = estimateTokens(
                    buildSystemPromptWithManifest +
                      "\n\n" +
                      agenticMessages
                        .map((m) =>
                          typeof m.content === "string" ? m.content : "",
                        )
                        .join("\n"),
                  );
                  await applyTierEscalation({
                    agenticIteration,
                    iterationInterval: 4,
                    runningTokens: buildRunningTokens,
                    mode:
                      effectiveWorkMode === "plan"
                        ? "plan"
                        : effectiveWorkMode === "build"
                          ? "build"
                          : "agent",
                  });
                } catch (escalationErr) {
                  logger.warn(
                    `[Agentic Loop] tier escalation guard failed: ${String(escalationErr)}`,
                  );
                }

                // If we hit permission requests, the AI should continue after approval
                if (hasPermissionRequest) {
                  logger.log("[Agentic Loop] Had permission requests, continuing loop...");
                }

                if (loopCorrection) {
                  continue;
                }

                if (agenticRepetition.consumeLoopBreak()) {
                  logger.warn("[Agentic Loop] Stopping after repeated write/command (repetition guard)");
                  fullResponse =
                    stripToolCallXML(fullResponse) +
                    "\n\n[Repeated action — task stopped. Review the activity log and send a message to continue.]";
                  break;
                }

                if (consumeDelegationAbort(req.chatId)) {
                  logger.warn("[Agentic Loop] Stopping after delegation repetition guard");
                  fullResponse =
                    stripToolCallXML(fullResponse) +
                    "\n\n[Delegation loop guard — task stopped. Review the activity log and send a message to continue.]";
                  break;
                }
              }

              fullResponse = stripToolCallXML(fullResponse);

              if (isTaskComplete(fullResponse)) {
                streamStopWasTaskComplete = true;
              }
              if (streamStopWasTaskComplete) {
                captureStreamAbortLedgerCompleteIfNeeded();
              }

              // Structured metrics logging
              logger.info(`[Agentic Loop] Completed:`, {
                chatId: req.chatId,
                iterations: agenticIteration,
                toolsExecuted: totalToolExecutions,
                durationMs: Date.now() - loopStartTime,
                completedNaturally: isTaskComplete(fullResponse),
              });
              hadToolCallsOrPermissions =
                totalToolExecutions > 0 || permissionInterceptor.getAllOperationsCount() > 0;
              // ═══════════════════════════════════════════════════════════════

            } catch (streamError) {
              const ledgerCompleteStop =
                streamStopWasTaskComplete ||
                abortController.signal.reason === TASK_COMPLETE_STREAM_STOP;
              if (abortController.signal.aborted && !ledgerCompleteStop) {
                const chatId = req.chatId;
                const partialResponse = partialResponses.get(req.chatId);
                // If we have a partial response, save it to the database
                if (partialResponse) {
                  try {
                    const cancelledContent = `${partialResponse}

[Response cancelled by user]`;
                    const { addEphemeralMessage } = await import("@/lib/ephemeral-chat");
                    addEphemeralMessage(req.chatId, {
                      role: "assistant",
                      content: stripThinkBlocks(cancelledContent),
                    });
                    logger.log(`Persisted partial response to ephemeral chat ${chatId} after abort`);
                    partialResponses.delete(req.chatId);
                  } catch (error) {
                    logger.error(
                      `Error saving partial response for chat ${chatId}:`,
                      error,
                    );
                  }
                }
                return req.chatId;
              }
              if (abortController.signal.aborted && ledgerCompleteStop) {
                logger.log(
                  `[Agentic Loop] Stream stopped after task ledger complete (chat ${req.chatId})`,
                );
                captureStreamAbortLedgerCompleteIfNeeded();
              } else if (!abortController.signal.aborted) {
                throw streamError;
              }
            } finally {
              agenticRepetition.setEnabled(false);
            }
          } // End of Build mode block
        }

        // Only save the response and process it if we weren't user-aborted (ledger-complete stop still saves)
        if (!abortController.signal.aborted || streamStopWasTaskComplete) {
          const currentSettings = readSettings();
          const intentModeForStructured = currentSettings.intentMode ?? "ask";
          const manualWorkMode =
            intentModeForStructured === "auto"
              ? undefined
              : currentSettings.workModePreference;
          const modeSchemaConfig: {
            schemaName: string;
            schemaHint: string;
            schema: ZodTypeAny;
          } | null =
            manualWorkMode === "plan"
              ? {
                  schemaName: "ArchitectPlanPayload",
                  schemaHint:
                    "{ version: 1, summary: string, phases: [{ id: string, title: string, tasks: string[] }], risks?: string[] }",
                  schema: ArchitectPlanPayloadSchema,
                }
              : manualWorkMode === "debug"
                ? {
                    schemaName: "DebuggerRootCause",
                    schemaHint:
                      "{ version: 1, hypothesis: string, likelyFiles: string[], nextSteps: string[] }",
                    schema: DebuggerRootCauseSchema,
                  }
                : manualWorkMode === "review"
                  ? {
                      schemaName: "ReviewerFindings",
                      schemaHint:
                        "{ version: 1, severity: pass|minor|major|blocker, findings: [{ file?: string, message: string, suggestion?: string }] }",
                      schema: ReviewerFindingsSchema,
                    }
                  : null;

          const isBuildModeForSchema =
            currentSettings.selectedChatMode === "agent" ||
            currentSettings.selectedChatMode === "build";

          if (modeSchemaConfig && fullResponse.trim() && isBuildModeForSchema) {
            const validation = await validateStructuredOutputWithSingleRetry({
              rawText: fullResponse,
              schema: modeSchemaConfig.schema,
              schemaName: modeSchemaConfig.schemaName,
              schemaHint: modeSchemaConfig.schemaHint,
              retry: async (retryPrompt) => {
                const retryResult = await generateText({
                  model: modelClient.model,
                  system: "Return only valid JSON for this response when asked.",
                  messages: [{ role: "user", content: retryPrompt }],
                });
                return retryResult.text?.trim() || "";
              },
            });

            if (validation.status === "ok") {
              if (manualWorkMode === "plan") {
                const v = validation.data as any;
                const tasks = Array.isArray(v?.phases)
                  ? v.phases
                      .map((p: any) => `- **${p.title}** (${p.id}): ${(p.tasks ?? []).join("; ")}`)
                      .join("\n")
                  : "";
                const planCardPayload = {
                  taskGroups: Array.isArray(v?.phases)
                    ? v.phases.map((p: any, idx: number) => ({
                        id: String(p?.id ?? `phase-${idx + 1}`),
                        title: String(p?.title ?? `Phase ${idx + 1}`),
                        tasks: Array.isArray(p?.tasks)
                          ? p.tasks.map((t: any, tIdx: number) => ({
                              id: `${String(p?.id ?? `phase-${idx + 1}`)}-task-${tIdx + 1}`,
                              label: String(t ?? ""),
                              status: "pending",
                            }))
                          : [],
                      }))
                    : [],
                  completed: false,
                };
                fullResponse = [
                  "## Plan Report",
                  "",
                  `**Summary:** ${v?.summary ?? ""}`,
                  "",
                  tasks ? `**Phases**\n${tasks}` : "",
                  "",
                  `<!-- atlarix-plan:${JSON.stringify(planCardPayload)} -->`,
                ]
                  .filter(Boolean)
                  .join("\n\n");
              } else if (manualWorkMode === "debug") {
                const v = validation.data as any;
                fullResponse = [
                  "## Debug Report",
                  "",
                  `**Hypothesis:** ${v?.hypothesis ?? ""}`,
                  "",
                  `**Likely files:** ${(v?.likelyFiles ?? []).join(", ") || "N/A"}`,
                  "",
                  `**Next steps:** ${(v?.nextSteps ?? []).join("; ") || "N/A"}`,
                ].join("\n");
              } else if (manualWorkMode === "review") {
                const v = validation.data as any;
                const findings = Array.isArray(v?.findings)
                  ? v.findings
                      .map(
                        (f: any) =>
                          `- ${f.file ? `\`${f.file}\` — ` : ""}${f.message}${f.suggestion ? ` _(suggestion: ${f.suggestion})_` : ""}`,
                      )
                      .join("\n")
                  : "";
                fullResponse = [
                  "## Review Report",
                  "",
                  `**Severity:** ${v?.severity ?? "unknown"}`,
                  "",
                  findings || "No findings.",
                ].join("\n");
              } else {
                fullResponse = validation.normalizedText;
              }
              if (validation.warning) {
                safeSend(event.sender, "chat:activity", {
                  id: `structured-mode-validation-${Date.now()}`,
                  type: "background",
                  label: `Structured output validation (${manualWorkMode})`,
                  status: "done",
                  timestamp: Date.now(),
                  detail: validation.warning,
                  chatId: req.chatId,
                });
              }
            } else {
              const fallbackWarning = `[Structured output validation warning] ${validation.warning}`;
              fullResponse = `${fullResponse}\n\n${fallbackWarning}`;
              safeSend(event.sender, "chat:activity", {
                id: `structured-mode-validation-${Date.now()}`,
                type: "background",
                label: `Structured output validation (${manualWorkMode})`,
                status: "error",
                timestamp: Date.now(),
                detail: validation.warning,
                chatId: req.chatId,
              });
              if (validation.status === "fallback") {
                sentryAddBreadcrumbSafe({
                  category: "validation",
                  message: `structured_output_fallback schema=${modeSchemaConfig.schemaName}`,
                  level: "warning",
                });
              }
            }
          }

          if (!fullResponse.trim()) {
            fullResponse = AI_STREAM_EMPTY_RESPONSE_FALLBACK;
          }
          let responseToStore = stripQuestionsBlockFromResponse(fullResponse);
          responseToStore = stripTaskCompleteTags(sanitizeAssistantOutput(responseToStore));
          const { ensurePlanMarkersInAssistantContent } = await import(
            "@/lib/plans/plan-artifacts"
          );
          responseToStore = ensurePlanMarkersInAssistantContent(responseToStore);
          {
            const ec = getEphemeralChat(req.chatId);
            const finalContent = stripThinkBlocks(responseToStore);
            const lastInUpdated =
              updatedChat.messages.length > 0
                ? updatedChat.messages[updatedChat.messages.length - 1]
                : null;
            if (lastInUpdated?.role === "assistant") {
              lastInUpdated.content = finalContent;
            } else if (ec) {
              const last = ec.messages[ec.messages.length - 1];
              if (last?.role === "assistant") {
                last.content = finalContent;
              }
            }
            if (ec) {
              ec.messages = updatedChat.messages;
            }
          }

          // Record exchange in session memory for conversation continuity
          // NOTE: Use appId (workspace ID) as key so memory persists across mode switches (Ask → Build)
          try {
            const sessionMemory = getSessionMemory(chat.appId);
            // Strip XML tags and code blocks for the summary
            const cleanResponse = responseToStore
              .replace(/<[^>]*>/g, '')
              .replace(/```[\s\S]*?```/g, '[code]')
              .trim();
            if (req.continueAfterQuestions) {
              sessionMemory.replaceLastExchange(userPrompt, cleanResponse);
            } else {
              sessionMemory.addExchange(userPrompt, cleanResponse);
            }
            logger.log(`Recorded exchange in session memory (now ${sessionMemory.getExchangeCount()} exchanges)`);
          } catch (error) {
            logger.warn("Failed to record session memory exchange:", error);
          }
          const settings = readSettings();
          const isBuildModeTurn =
            settings.selectedChatMode === "agent" || settings.selectedChatMode === "build";
          {
            const newReviewSystemActiveElse =
              streamStopWasTaskComplete ||
              delegatedAgentsThisTurn.includes("reviewer");

            // v2.1: Self-review activity in non-status path (ask/simple)
            const selfReviewElse = settings.aiConfiguration?.selfReview;
            if (
              !newReviewSystemActiveElse &&
              selfReviewElse?.enabled &&
              (selfReviewElse.strategy === "runtime" || selfReviewElse.strategy === "both") &&
              selfReviewElse.showInActivityStream
            ) {
              const id = `self-review-${req.chatId}-${Date.now()}`;
              safeSend(event.sender, "chat:activity", {
                id,
                type: "self_review",
                label: "Self-reviewing response",
                status: "running",
                timestamp: Date.now(),
                chatId: req.chatId,
              });
              safeSend(event.sender, "chat:activity", {
                id,
                type: "self_review",
                label: "Self-reviewing response",
                status: "done",
                timestamp: Date.now(),
                detail: `Score: ${(selfReviewElse.qualityThreshold ?? 0.85).toFixed(2)} (threshold met)`,
                chatId: req.chatId,
              });
            }
            if (
              hasWorkspace &&
              appPath &&
              settings.aiConfiguration?.agentLightning?.collectData
            ) {
              recordTrace(appPath, {
                timestamp: Date.now(),
                chatId: req.chatId,
                requestSnippet: (userPrompt ?? "").slice(0, 500),
                agentMode: settings.agentMode,
                finalSnippet: (fullResponse ?? "").slice(0, 1000),
              }).catch(() => {});
            }
            if (
              isBuildModeTurn &&
              effectiveAppId != null &&
              appPath &&
              filesWrittenInThisExchange.length > 0
            ) {
              const { recordBuildCompleteSnapshot } = await import("@/lib/project-memory/service");
              void recordBuildCompleteSnapshot(
                effectiveAppId,
                appPath,
                userPrompt?.slice(0, 500),
              );
            }
            // Plan-lifecycle safety net: a Build turn that wrote files and finished
            // cleanly marks the session's "building" plan as built if the model
            // didn't call update_plan_status itself.
            if (
              isBuildModeTurn &&
              req.workspaceSessionId &&
              filesWrittenInThisExchange.length > 0 &&
              (!abortController.signal.aborted || streamStopWasTaskComplete)
            ) {
              try {
                const {
                  getLatestPlanArtifact,
                  setPlanArtifactStatus,
                  updatePlanArtifactContent,
                } = await import("@/lib/plans/plan-artifacts");
                const buildingPlan = await getLatestPlanArtifact(req.workspaceSessionId, "building");
                if (buildingPlan) {
                  // v10: close out any checklist steps the model left open.
                  const { markAllChecklistStepsDone } = await import(
                    "@/lib/tasks/plan-checklist"
                  );
                  const closed = markAllChecklistStepsDone(buildingPlan.content);
                  if (closed.changed) {
                    await updatePlanArtifactContent(buildingPlan.id, closed.content);
                  }
                  const updated = await setPlanArtifactStatus(buildingPlan.id, "built");
                  if (updated) {
                    const { emitPlanArtifactUpdated } = await import("../utils/emit_plan_artifact");
                    emitPlanArtifactUpdated(event.sender, {
                      planId: updated.id,
                      sessionId: updated.sessionId,
                      content: updated.content,
                      planStatus: updated.planStatus,
                    });
                    logger.info(`[plan-artifact] safety net marked plan ${buildingPlan.id} built`);
                  }
                }
              } catch (planEndErr) {
                logger.warn("[plan-artifact] build-complete status update failed:", planEndErr);
              }
            }
            if (
              isBuildModeTurn &&
              (!abortController.signal.aborted || streamStopWasTaskComplete)
            ) {
              const tid = String(placeholderAssistantMessage.id);
              const ops = getAutonomousSessionLog(req.chatId, tid);
              const agentActivity = getAgentActivityForTurn(req.chatId, tid);
              if (ops.length > 0 || agentActivity.length > 0) {
                safeSend(event.sender, "autonomous:session-complete", {
                  chatId: req.chatId,
                  turnId: tid,
                  workspaceId: effectiveAppId ?? null,
                  ops,
                  agentActivity,
                });
              }
            }
            markLedgerStreamComplete(streamTurnIdForLedger);
            inFlightDelegationKeys.clear();
            notifyPlanUiForTurnIfPresent(streamTurnIdForLedger);
            {
              const finalLedgerElse = getLedger(streamTurnIdForLedger);
              if (
                finalLedgerElse &&
                isLedgerTaskComplete(finalLedgerElse) &&
                !streamStopWasTaskComplete
              ) {
                streamStopWasTaskComplete = true;
              }
            }
            await maybeAppendAutoMemoryAfterStream({
              settings,
              appPath,
              chatId: req.chatId,
              isEphemeralWorkspace,
              streamTurnIdForLedger,
              isBuildModeTurn,
              sender: event.sender,
            });
            notifyCompactionLedgerSettled(req.chatId, streamTurnIdForLedger);
            // v10 token accuracy: fold sub-agent + compaction usage into this
            // turn's totals so Compass metering and the meter are exact.
            const auxUsage = takeAuxUsage(req.chatId);
            if (auxUsage) {
              logger.log(
                `[usage] auxiliary LLM tokens this turn: ${auxUsage.totalTokens} across ${auxUsage.calls} call(s) — ${Object.entries(
                  auxUsage.byLabel,
                )
                  .map(([k, v]) => `${k}=${v}`)
                  .join(", ")}`,
              );
              if (usedCompassThisStream) {
                compassStreamTokens = (compassStreamTokens ?? 0) + auxUsage.totalTokens;
                void recordCompassUsageTokens(auxUsage.totalTokens).then((r) => {
                  if (!r.ok && r.error === "limit_exceeded") {
                    logger.warn("[compass] Monthly limit hit while recording aux usage");
                  }
                });
              }
            }
            safeSend(event.sender, "chat:response:end", {
              chatId: req.chatId,
              updatedFiles: false,
              hadToolCallsOrPermissions,
              usedCompass: usedCompassThisStream,
              compassTier: compassStreamTier,
              compassTokens: compassStreamTokens,
              ...(auxUsage ? { auxTokens: auxUsage.totalTokens } : {}),
              ...(maxReasoningTokensUsed != null && maxReasoningTokensUsed > 0
                ? { reasoningTokens: maxReasoningTokensUsed }
                : {}),
            } satisfies ChatResponseEnd);
            queuePostTurnSelfCorrection(event.sender, {
              chatId: req.chatId,
              rootAssistantMessageId: placeholderAssistantMessage.id,
              appId: effectiveAppId,
              appPath,
              filesWrittenInThisExchange,
              isBuildModeTurn,
              isEphemeralWorkspace,
              aborted: abortController.signal.aborted && !streamStopWasTaskComplete,
            });
            activeStreams.delete(req.chatId);
            void runAutonomousBuildVerificationAfterTaskComplete({
              sender: event.sender,
              chatId: req.chatId,
              streamStopWasTaskComplete,
              agentMode: settings.agentMode,
              appPath,
              workspaceId: effectiveAppId ?? undefined,
              streamTurnIdForLedger,
              rootAssistantMessageId: placeholderAssistantMessage.id,
              isEphemeralWorkspace,
              settings,
            }).catch((buildVerifyErr) => {
              logger.warn("[build-verify] Post-turn verification failed:", buildVerifyErr);
            });
          }
        }

        // Clean up any temporary files
        if (attachmentPaths.length > 0) {
          for (const filePath of attachmentPaths) {
            try {
              // We don't immediately delete files because they might be needed for reference
              // Instead, schedule them for deletion after some time
              setTimeout(
                async () => {
                  if (fs.existsSync(filePath)) {
                    await unlink(filePath);
                    logger.log(`Deleted temporary file: ${filePath}`);
                  }
                },
                30 * 60 * 1000,
              ); // Delete after 30 minutes
            } catch (error) {
              logger.error(`Error scheduling file deletion: ${error}`);
            }
          }
        }
      }

        // Stream completed successfully; cleanup is done by chat:cancel/chat:abort or response:end
      } catch (error) {
        logger.error("Error calling LLM:", error);
        // FIX 4: silent retries exhausted — surface a reconnect prompt instead
        // of the generic error box. The renderer keeps the partial visible
        // until the user picks [Reconnect] or [Continue].
        if (error instanceof NetworkStreamDisconnectedError) {
          safeSend(event.sender, "chat:stream:disconnected", {
            chatId: req.chatId,
            partialResponse: error.partialResponse,
            reason: "network",
            canResume: true,
          });
          activeStreams.delete(req.chatId);
          streamTerminated = true;
          FileUploadsState.getInstance().clear(req.chatId);
          return;
        }
        if (error instanceof EmptyModelOutputAfterRetryError) {
          safeSend(event.sender, "chat:response:error", {
            chatId: req.chatId,
            error: MODEL_EMPTY_RESPONSE_USER_MESSAGE,
          });
          safeSend(event.sender, "chat:response:end", {
            chatId: req.chatId,
            updatedFiles: false,
            hadToolCallsOrPermissions: false,
          } satisfies ChatResponseEnd);
          activeStreams.delete(req.chatId);
          FileUploadsState.getInstance().clear(req.chatId);
          return;
        }
        if (
          error instanceof TypeError &&
          (error.message === "terminated" || error.message === "fetch failed")
        ) {
          safeSend(event.sender, "chat:response:error", {
            chatId: req.chatId,
            error: "Connection interrupted. Please try again.",
          });
          safeSend(event.sender, "chat:response:end", {
            chatId: req.chatId,
            updatedFiles: false,
            hadToolCallsOrPermissions: false,
          } satisfies ChatResponseEnd);
          activeStreams.delete(req.chatId);
          streamTerminated = true;
          FileUploadsState.getInstance().clear(req.chatId);
          return;
        }
        if (error instanceof ChatPromptSafetyError) {
          safeSend(event.sender, "chat:response:error", {
            chatId: req.chatId,
            error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${SAFETY_FILTER_BLOCKED_MESSAGE}`,
          });
          safeSend(event.sender, "chat:response:end", {
            chatId: req.chatId,
            updatedFiles: false,
            hadToolCallsOrPermissions: false,
          } satisfies ChatResponseEnd);
          activeStreams.delete(req.chatId);
          streamTerminated = true;
          FileUploadsState.getInstance().clear(req.chatId);
          return;
        }
        if (
          error instanceof Error &&
          /maximum length|Invalid prompt/i.test(error.message)
        ) {
          safeSend(event.sender, "chat:response:error", {
            chatId: req.chatId,
            error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${error.message}`,
          });
          safeSend(event.sender, "chat:response:end", {
            chatId: req.chatId,
            updatedFiles: false,
            hadToolCallsOrPermissions: false,
          } satisfies ChatResponseEnd);
          activeStreams.delete(req.chatId);
          streamTerminated = true;
          FileUploadsState.getInstance().clear(req.chatId);
          return;
        }
        const errMessage = isNoUsableModelOutputError(error)
          ? AI_STREAM_EMPTY_RESPONSE_FALLBACK
          : modelFailureUserMessage(
              error instanceof Error ? error.message : String(error),
            );
        safeSend(event.sender, "chat:response:error", {
          chatId: req.chatId,
          error: errMessage,
        });
        safeSend(event.sender, "chat:response:end", {
          chatId: req.chatId,
          updatedFiles: false,
          hadToolCallsOrPermissions: false,
        } satisfies ChatResponseEnd);
        activeStreams.delete(req.chatId);
        streamTerminated = true;
        FileUploadsState.getInstance().clear(req.chatId);
      } finally {
        toolTurnDedupState.dedupeByKey.clear();
        toolTurnDedupState.callCountByTool.clear();
        stopAgentOrchestrator?.();
        unregisterLedgerPlanUiNotifier(req.chatId);
        clearActiveModelDisplayName();
        ensureTerminal();
      }
    };

    void runStream();
    return undefined; // Reply immediately so renderer does not get "reply was never sent"
  };

  ipcMain.handle("chat:stream", chatStreamHandler);

  // Handler to cancel an ongoing stream
  ipcMain.handle("chat:cancel", async (event, chatId: number) => {
    const abortController = activeStreams.get(chatId);

    if (abortController) {
      // Abort the stream
      abortController.abort();
      activeStreams.delete(chatId);
      logger.log(`Aborted stream for chat ${chatId}`);
    } else {
      logger.warn(`No active stream found for chat ${chatId}`);
    }

    // Send the end event to the renderer
    safeSend(event.sender, "chat:response:end", {
      chatId,
      updatedFiles: false,
      hadToolCallsOrPermissions: false,
    } satisfies ChatResponseEnd);

    // Clean up uploads state for this chat
    try {
      FileUploadsState.getInstance().clear(chatId);
    } catch { }

    return true;
  });

  // ═══════════════════════════════════════════════════════════
  // ABORT STREAM - User can cancel AI stream to save tokens
  // ═══════════════════════════════════════════════════════════
  ipcMain.handle("chat:abort", async (_, chatId: number) => {
    const controller = activeStreams.get(chatId);
    if (controller) {
      logger.log(`[chat:abort] User cancelled stream for chat ${chatId}`);
      controller.abort();
      activeStreams.delete(chatId);
      // Do NOT delete partialResponses here — the stream's catch block will persist
      // the partial response to the DB and then clear it, so the user keeps the
      // cancelled response when they send a follow-up.
      return { success: true, message: 'AI response cancelled' };
    }
    return { success: false, message: 'No active stream for this chat' };
  });

  // FIX 4: explicit "reconnect" after the auto-retry sequence gave up. The
  // renderer holds onto the partial; we just re-dispatch the same turn.
  // Asks the renderer to clear its in-flight stream buffer first, then runs
  // the chat-stream handler again with the cached request.
  ipcMain.handle(
    "chat:stream:reconnect",
    async (event, params: { chatId: number }) => {
      const chatId = params?.chatId;
      if (typeof chatId !== "number") {
        return { success: false, message: "Invalid chatId" };
      }
      const cached = lastStreamRequest.get(chatId);
      if (!cached) {
        return {
          success: false,
          message: "No prior stream request to reconnect",
        };
      }
      safeSend(event.sender, "chat:stream:reset-partial", { chatId });
      try {
        await chatStreamHandler(event, cached);
        return { success: true };
      } catch (error) {
        logger.error("[chat:stream:reconnect] re-dispatch failed:", error);
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  // v3.9: Edit user message — truncate messages after it, update content, clear has_answered_questions
  ipcMain.handle(
    "chat:edit-message",
    async (
      _event,
      payload: { chatId: number; userMessageId: number; newContent: string }
    ) => {
      const { chatId, userMessageId, newContent } = payload;
      // Ephemeral chats (chatId < 0) live only in-memory (ephemeral-chat transport).
      const { editEphemeralUserMessage, getEphemeralChat } = await import(
        "@/lib/ephemeral-chat"
      );
      // Capture the message's ordinal BEFORE the edit truncates the tail, so the
      // persisted session row can be located (ids don't correlate across stores).
      const chat = getEphemeralChat(chatId);
      const ephCount = chat?.messages.length ?? 0;
      const ephIdx =
        chat?.messages.findIndex(
          (m) => m.id === userMessageId && m.role === "user",
        ) ?? -1;

      const ok = editEphemeralUserMessage(chatId, userMessageId, newContent);
      if (!ok) {
        throw new Error("Ephemeral user message not found");
      }

      // Persist the edit + tail truncation to the saved session (was previously
      // only in-memory, so edits vanished on session switch).
      try {
        const { persistEditedSessionMessage } = await import(
          "./workspace_session_handlers"
        );
        await persistEditedSessionMessage(chatId, ephIdx, ephCount, newContent);
      } catch (e) {
        logger.warn("Failed to persist edited session message:", e);
      }
      return { success: true };
    }
  );

  ipcMain.handle(
    "snapshot:exists",
    async (_event, payload: { appId: number; turnId: string }) => {
      const { appId, turnId } = payload;
      if (!turnId || appId == null || Number.isNaN(Number(appId))) {
        return false;
      }
      const app = await db.query.apps.findFirst({
        where: eq(apps.id, appId),
      });
      if (!app) return false;
      const workspacePath = getAtlarixAppPath(app.path);
      // v10: shadow-git store first, legacy .bak dirs second.
      return snapshotExists(workspacePath, String(turnId));
    },
  );

  // v3.9 / v4.0: Revert conversation to an assistant message — restore workspace snapshot (if any), truncate messages, clear has_answered_questions
  ipcMain.handle(
    "chat:revert-to-message",
    async (
      _event,
      payload: { chatId: number; assistantMessageId: number }
    ) => {
      const { chatId, assistantMessageId } = payload;
      const ec = getEphemeralChat(chatId);
      const msg = ec?.messages.find((m) => m.id === assistantMessageId);
      if (!msg || msg.role !== "assistant") {
        throw new Error("Assistant message not found");
      }
      const appId = getEphemeralChatAppId(chatId) ?? null;
      const turnId = String(assistantMessageId);
      if (appId != null) {
        const app = await db.query.apps.findFirst({ where: eq(apps.id, appId) });
        if (app) {
          const appPath = resolveAppPath(app.path);
          const result = await performFullRevert({
            chatId,
            turnId,
            assistantMessageId,
            workspacePath: appPath,
            workspaceId: appId,
          });
          if (!result.success && result.error) {
            logger.warn("Revert: performFullRevert:", result.error);
          }
          return { success: true };
        }
      }
      return { success: true };
    }
  );

  ipcMain.handle(
    "autonomous:revert-op",
    async (
      _event,
      payload: { chatId: number; turnId: string; operationId: string },
    ) => {
      const { findAutonomousOp, markAutonomousOpReverted } = await import("./autonomous-session-state");
      const op = findAutonomousOp(payload.chatId, payload.turnId, payload.operationId);
      if (!op?.path) {
        return { success: false, error: "No file path for this operation" };
      }
      const workspaceId = getEphemeralChatAppId(payload.chatId);
      if (workspaceId == null) {
        return { success: false, error: "Chat has no workspace" };
      }
      const app = await db.query.apps.findFirst({ where: eq(apps.id, workspaceId) });
      if (!app?.path) {
        return { success: false, error: "Chat has no workspace" };
      }
      const workspacePath = resolveAppPath(app.path);
      const rel = op.path.split(path.sep).join("/");
      const assistantMessageId = Number(payload.turnId);
      if (!Number.isFinite(assistantMessageId)) {
        return { success: false, error: "Invalid turnId" };
      }
      const result = await performFullRevert({
        chatId: payload.chatId,
        turnId: payload.turnId,
        assistantMessageId,
        workspacePath,
        workspaceId,
        options: {
          filesFilter: [rel],
          skipMessageFlags: true,
        },
      });
      if (result.success) {
        markAutonomousOpReverted(payload.chatId, payload.turnId, payload.operationId);
      }
      return result;
    },
  );

  ipcMain.handle(
    "autonomous:accept-all",
    async (_event, payload: { chatId: number; turnId: string }) => {
      const { clearAutonomousSession } = await import("./autonomous-session-state");
      clearAutonomousSession(payload.chatId, payload.turnId);
      return { success: true };
    },
  );

  ipcMain.handle(
    "revert:snapshot",
    async (_event, payload: { chatId: number; turnId: string }) => {
      const { chatId, turnId } = payload;
      const assistantMessageId = Number(turnId);
      if (!Number.isFinite(assistantMessageId)) {
        return { success: false, error: "Invalid turnId" };
      }
      const ec = getEphemeralChat(chatId);
      const msg = ec?.messages.find((m) => m.id === assistantMessageId);
      if (!msg || msg.role !== "assistant") {
        return {
          success: false,
          error: "Assistant message not found for this chat and turnId",
        };
      }
      const workspaceId = getEphemeralChatAppId(chatId);
      if (workspaceId == null) {
        return { success: false, error: "No workspace attached" };
      }
      const app = await db.query.apps.findFirst({ where: eq(apps.id, workspaceId) });
      if (!app?.path) {
        return { success: false, error: "No workspace attached" };
      }
      const workspacePath = resolveAppPath(app.path);
      return performFullRevert({
        chatId,
        turnId,
        assistantMessageId,
        workspacePath,
        workspaceId,
      });
    },
  );
}

export function formatMessagesForSummary(
  messages: { role: string; content: string | undefined }[],
) {
  if (messages.length <= 8) {
    // If we have 8 or fewer messages, include all of them
    return messages
      .map((m) => `<message role="${m.role}">${m.content}</message>`)
      .join("\n");
  }

  // Take first 2 messages and last 6 messages
  const firstMessages = messages.slice(0, 2);
  const lastMessages = messages.slice(-6);

  // Combine them with an indicator of skipped messages
  const combinedMessages = [
    ...firstMessages,
    {
      role: "system",
      content: `[... ${messages.length - 8} messages omitted ...]`,
    },
    ...lastMessages,
  ];

  return combinedMessages
    .map((m) => `<message role="${m.role}">${m.content}</message>`)
    .join("\n");
}


// Helper function to convert traditional message with attachments
// v8.0: Images and files are now accessed via read_attachment tool, not content blocks
async function prepareMessageWithAttachments({
  message,
  attachmentInfoForModel,
}: {
  message: ModelMessage;
  attachmentInfoForModel: string;
}): Promise<ModelMessage> {
  const textContent = message.content;
  if (typeof textContent !== "string") {
    logger.warn(
      "Message content is not a string - shouldn't happen but using message as-is",
    );
    return message;
  }

  // IMPORTANT: Attachment context must be provided to the model, but must NOT be persisted
  // into the user-visible message content in SQLite. We inject it here at dispatch time.
  const injected =
    attachmentInfoForModel && attachmentInfoForModel.trim().length > 0
      ? `${textContent}${attachmentInfoForModel}`
      : textContent;

  return {
    role: "user",
    content: injected,
  };
}

function removeNonEssentialTags(text: string): string {
  return removeProblemReportTags(removeThinkingTags(text));
}

export { removeThinkingTags };

export function removeProblemReportTags(text: string): string {
  const problemReportRegex =
    /<atlarix-problem-report[^>]*>[\s\S]*?<\/atlarix-problem-report>/g;
  return text.replace(problemReportRegex, "").trim();
}

export function removeAtlarixTags(text: string): string {
  const legacyDyadBlock = /<dyad-[^>]*>[\s\S]*?<\/dyad-[^>]*>/g;
  // Keep user paste/terminal attachments — ask mode needs these bodies for the model.
  const atlarixBlock =
    /<atlarix-(?!text-attachment|terminal-attachment)[^>]*>[\s\S]*?<\/atlarix-[^>]*>/g;
  return text.replace(legacyDyadBlock, "").replace(atlarixBlock, "").trim();
}

export function hasUnclosedAtlarixWrite(text: string): boolean {
  // Find the last opening atlarix-write tag
  const openRegex = /<atlarix-write[^>]*>/g;
  let lastOpenIndex = -1;
  let match;

  while ((match = openRegex.exec(text)) !== null) {
    lastOpenIndex = match.index;
  }

  // If no opening tag found, there's nothing unclosed
  if (lastOpenIndex === -1) {
    return false;
  }

  // Look for a closing tag after the last opening tag
  const textAfterLastOpen = text.substring(lastOpenIndex);
  const hasClosingTag = /<\/atlarix-write>/.test(textAfterLastOpen);

  return !hasClosingTag;
}

/**
 * Diagram-First Context Prompt
 * Instead of dumping 168K tokens of codebase, instruct AI to use tools
 */
function createDiagramFirstPrompt(hasArchitectureContext: boolean): string {
  if (hasArchitectureContext) {
    return `# Workspace Context

I have provided architecture context for this project in the prompt.

Use this deterministic flow:
1. High-level map from architecture context
2. Explore likely folders/files
3. Deep-dive only relevant code

## Recommended tool sequence
- **get_blueprint**: structural slice (files, functions, edges) for a folder or path
- **explore_folder** / **list_files** / **find_file**: navigate the tree
- **search** (mode: auto | text | semantic | structural): locate symbols, patterns, concepts, or graph relationships
- **get_file_outline**: list functions/classes/types in a file before reading it
- **read_file**: read exact files (use start_line/end_line for slices)
`;
  }
  return `# Workspace Context

You currently do not have a Blueprint slice in context for this turn.

Your first actions should be:
1. Call **get_blueprint** or **search** to locate relevant areas.
2. Use **explore_folder** + **read_file** to drill in once you have a target.

Use inline \`\`\`graph\`\`\` JSON fences (nodes + edges) in your reply when a visual helps explain a flow.
`;
}

function createOtherAppsCodebasePrompt(otherAppsCodebaseInfo: string): string {
  return `
# Referenced Apps

These are the other apps that I've mentioned in my prompt. These other apps' codebases are READ-ONLY.

${otherAppsCodebaseInfo}
`;
}

// `normalizeToolInputSchemaForAiSdk` + `PERMISSIVE_TOOL_JSON_SCHEMA` were moved
// to `@/lib/ai/normalize-tool-schema` so that delegation sub-agents
// (`src/lib/tools/agent.ts`) can reuse the exact same wiring.

