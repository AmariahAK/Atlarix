import { v4 as uuidv4 } from "uuid";
import { ipcMain, IpcMainInvokeEvent, type WebContents } from "electron";
import {
  ModelMessage,
  TextPart,
  ImagePart,
  streamText,
  generateText,
  ToolSet,
  TextStreamPart,
  jsonSchema as aiJsonSchema,
  zodSchema,
} from "ai";
import type { JSONSchema7 } from "json-schema";

import { db } from "../../db";
import { apps, chats, messages, diagrams } from "../../db/schema";
import { and, desc, eq, isNotNull, isNull, or } from "drizzle-orm";
import type { SmartContextMode, UserSettings, WorkMode } from "../../lib/schemas";
import {
  constructSystemPrompt,
  buildSystemPromptWithProjectInstructions,
} from "../../prompts/system_prompt";
import {
  SUPABASE_AVAILABLE_SYSTEM_PROMPT,
  SUPABASE_NOT_AVAILABLE_SYSTEM_PROMPT,
} from "../../prompts/supabase_prompt";
import { getAtlarixAppPath, resolveAppPath } from "../../paths/paths";
import { readSettings } from "../../main/settings";
import type { ChatResponseEnd, ChatStreamParams } from "../ipc_types";
import {
  CodebaseFile,
  extractCodebase,
  readFileWithCache,
} from "../../utils/codebase";
import {
  dryRunSearchReplace,
  processFullResponseActions,
} from "../processors/response_processor";
import { streamTestResponse } from "./testing_chat_handlers";
import { getTestResponse } from "./testing_chat_handlers";
import { getModelClient, getEffectiveModel, getEffectiveModelForOptions, ModelClient, isDiagramModelNotFoundError, type GetModelClientOptions } from "../utils/get_model_client";
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
import { readFile, writeFile, unlink, access } from "fs/promises";
import {
  getMaxTokensWithFloor,
  getTemperature,
} from "../utils/token_utils";
import {
  MAX_CHAT_TURNS_IN_CONTEXT,
  STREAM_TOOL_LOOP_DURATION_CAP_MS,
} from "@/constants/settings_constants";
import { validateChatContext } from "../utils/context_paths_utils";
import { mcpServers } from "../../db/schema";
import { requireMcpToolConsent } from "../utils/mcp_consent";

import { getExtraProviderOptions } from "../utils/thinking_utils";

import { safeSend } from "../utils/safe_sender";
import {
  clearToolsUsedForTurn,
  getToolsUsedThisTurn,
  recordToolUseForTurn,
} from "./turn-tool-tracking";
import { cleanFullResponse, parseQuestions } from "../utils/cleanFullResponse";
import { removeThinkingTags } from "../utils/thinking_tags";
import { generateProblemReport } from "../processors/tsc";
import { AsyncVirtualFileSystem } from "../../../shared/VirtualFilesystem";
import {
  getAtlarixWriteTags,
  getAtlarixDeleteTags,
  getAtlarixRenameTags,
} from "../utils/atlarix_tag_parser";
import { fileExists } from "../utils/file_utils";
import { FileUploadsState } from "../utils/file_uploads_state";
import { extractMentionedAppsCodebases } from "../utils/mention_apps";
import { parseAppMentions } from "@/shared/parse_mention_apps";
import { prompts as promptsTable } from "../../db/schema";
import { inArray, asc } from "drizzle-orm";
import { replacePromptReference } from "../utils/replacePromptReference";
import { mcpManager } from "../utils/mcp_manager";
import { logMcpError } from "./mcp_handlers";
import z from "zod";
import type { ZodTypeAny } from "zod";
import { isTurboEditsV2Enabled } from "@/lib/schemas";
import {
  AI_STREAMING_ERROR_MESSAGE_PREFIX,
  AI_STREAM_EMPTY_RESPONSE_FALLBACK,
  SAFETY_FILTER_BLOCKED_MESSAGE,
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
import { escapeAtlarixTags } from "../utils/escape_atlarix_tags";
import { getRecentAssistantRoutingTiers } from "@/lib/routing/auto-router-context";
import { getCurrentCommitHash } from "../utils/git_utils";
import { createSnapshot } from "../../lib/workspace-snapshots";
import { revertSnapshot, revertSnapshotFiles } from "../../lib/snapshot/snapshot-manager";
import { atlasDir } from "../../lib/snapshot/workspace-hash";
import { feedTerminalOutput } from "../../lib/streams/StreamManager";
import {
  processChatMessagesWithVersionedFiles as getVersionedFiles,
  VersionedFiles as VersionedFiles,
} from "../utils/versioned_codebase_context";
import {
  generateSimpleChatName,
  generateAIChatName,
  shouldTriggerAINaming,
} from "../../utils/chat_naming";
import { ToolRegistry } from "../../lib/tools";
import { generateManifest, isCoreTool } from "../../lib/tools/ToolManifest";
import { ToolSessionLoader } from "../../lib/tools/ToolSessionLoader";
import {
  buildContinuationPrompt,
  shouldContinue,
} from "../../lib/streaming/continuation-handler";
import {
  createAgenticRepetitionState,
  type AgenticRepetitionOutcome,
} from "../../lib/streaming/agentic-loop-repetition";
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
import { clearSelfCorrectionAttemptsForChat } from "./self_correction_followup";
import {
  isTaskComplete as isLedgerTaskComplete,
  getRemainingSteps,
  buildPendingStepsContinuationPrompt,
} from "@/lib/tasks/completion-detector";
import { assembleContextSections, type ContextSection } from "@/lib/context/ContextAssembler";
import { loadSkill } from "@/lib/skills/skill-loader";
import { getSkillNameForMode } from "@/lib/skills/skill-registry";
import {
  ArchitectPlanPayloadSchema,
  DebuggerRootCauseSchema,
  ReviewerFindingsSchema,
} from "@/lib/agents/agent-handoff-schemas";
import { validateStructuredOutputWithSingleRetry } from "@/lib/agents/structured-output-validation";
import { handleChatOnlyStream, type McpToolSet } from "./chat_only_handlers";
import {
  requireAuthSession,
  formatAuthRequiredIpcError,
  AuthRequiredError,
} from "../../lib/auth/require_auth_session";
import * as Sentry from "@sentry/electron/main";
import { getWorkspaceContext } from "./chat_stream/workspace-context";
import { buildWorkforceWorkspaceContextBlock } from "../../lib/workforce/WorkspaceContext";
import { PermissionInterceptor } from "./permissions/interceptor";
import { registerInterceptor } from "./permissions/handlers";
import { shouldAutoApprovePermissions } from "./autonomous-permissions";
import {
  appendAutonomousOp,
  autonomousOpFromPermissionExec,
  appendAgentActivitySnapshot,
  getAutonomousSessionLog,
  getAgentActivityForTurn,
} from "./autonomous-session-state";
import { getSessionMemory, clearSessionMemory } from "../../lib/session-memory";
import {
  shouldCompact,
  runCompaction,
  getContextSummary,
  schedulePostTurnCompaction,
  notifyCompactionLedgerSettled,
  pruneToolOutputsInMessages,
} from "../../lib/context-compaction";
import { readAtlarixMd, writeAtlarixMd } from "../../lib/project-memory";
import { estimateTokens, getContextWindow } from "../utils/token_utils";
import { recordTrace } from "../../lib/agents/agent-lightning";
import { writeSettings } from "../../main/settings";
import { settingsPatchForWorkMode } from "../../lib/work-mode";
import { getToolActivityLabel } from "../../lib/tool-activity-labels";
import { captureSafe } from "../../main/lib/analytics";

type AsyncIterableStream<T> = AsyncIterable<T> & ReadableStream<T>;

const logger = log.scope("chat_stream_handlers");

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
const MODE_CHANGE_USER_WAIT_MS = 120_000;
const pendingWorkspacePermissionResolvers = new Map<
  string,
  { resolve: (result: { dismissed: boolean; grantedServices: string[] }) => void }
>();

export function waitForModeChangeResponse(chatId: number): Promise<boolean> {
  return new Promise((resolve) => {
    const superseded = pendingModeChangeResolvers.get(chatId);
    if (superseded) {
      superseded.finish(false);
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (approved: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      pendingModeChangeResolvers.delete(chatId);
      resolve(approved);
    };
    timer = setTimeout(() => {
      logger.warn(
        `[mode-change] User approval wait timed out after ${MODE_CHANGE_USER_WAIT_MS}ms (chat ${chatId}); treating as declined.`,
      );
      finish(false);
    }, MODE_CHANGE_USER_WAIT_MS);
    pendingModeChangeResolvers.set(chatId, { finish });
  });
}

export function resolveModeChange(chatId: number, approve: boolean): void {
  const r = pendingModeChangeResolvers.get(chatId);
  if (r) {
    r.finish(approve);
  }
}

/** Unwrap ToolRegistry.execute payload when the registry wraps `{ success, result, cost }`. */
function unwrapRegistryToolResult(execResult: unknown): unknown {
  if (!execResult || typeof execResult !== "object") return execResult;
  const o = execResult as Record<string, unknown>;
  if (
    o.__permission_required ||
    o.__workspace_permissions_requested ||
    o.__workforce_session_scope_needed
  ) {
    return execResult;
  }
  if (o.success === true && o.result != null && typeof o.result === "object") {
    return o.result;
  }
  return execResult;
}

function shouldEmitModeChangedAfterModeTool(inner: unknown): boolean {
  if (!inner || typeof inner !== "object") return false;
  const p = inner as Record<string, unknown>;
  if (p.success === false || typeof p.error === "string") return false;
  if (p.message === "Already in that mode.") return false;
  return true;
}

function emitModeChangedIfApplied(
  sender: WebContents,
  chatId: number,
  newMode: string | undefined,
  inner: unknown,
): void {
  if (!shouldEmitModeChangedAfterModeTool(inner)) return;
  const settingsSnapshot = readSettings();
  safeSend(sender, "mode:changed", {
    chatId,
    newMode: (newMode ?? settingsSnapshot.workModePreference) as string,
    settings: settingsSnapshot,
  });
}

function workspacePermissionKey(chatId: number, requestId: string): string {
  return `${chatId}:${requestId}`;
}

export function waitForWorkspacePermissionResponse(
  chatId: number,
  requestId: string,
): Promise<{ dismissed: boolean; grantedServices: string[] }> {
  return new Promise((resolve) => {
    pendingWorkspacePermissionResolvers.set(workspacePermissionKey(chatId, requestId), { resolve });
  });
}

export function resolveWorkspacePermissionResponse(
  chatId: number,
  requestId: string,
  result: { dismissed: boolean; grantedServices: string[] },
): void {
  const key = workspacePermissionKey(chatId, requestId);
  const r = pendingWorkspacePermissionResolvers.get(key);
  if (r) {
    pendingWorkspacePermissionResolvers.delete(key);
    r.resolve(result);
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
    const agentOk = settings.agentMode === "autonomous" || isBuildModeTurn;
    if (!agentOk) return;
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
    agentMode,
    appPath,
    workspaceId,
    streamTurnIdForLedger,
    rootAssistantMessageId,
    isEphemeralWorkspace,
    settings,
  } = params;
  if (
    !streamStopWasTaskComplete ||
    agentMode !== "autonomous" ||
    !appPath ||
    chatId < 0 ||
    isEphemeralWorkspace
  ) {
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

/** Fix: Workforce-2 — prompt UI for session scope, then re-run tool. */
async function runToolExecuteWithWorkforceSessionGate(
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

  let result: unknown = await ToolRegistry.execute(toolName, executeArgs);
  if (streamOpts?.turnId) {
    recordToolUseForTurn(streamOpts.turnId, toolName);
  }
  maybeStopStreamForCompleteLedger();
  if (
    result &&
    typeof result === "object" &&
    (result as { __workforce_session_scope_needed?: boolean }).__workforce_session_scope_needed === true
  ) {
    const { waitForWorkforceSessionScope } = await import("./workforce_session_handlers");
    safeSend(sender, "workforce:prompt-session-scope", { chatId });
    const ok = await waitForWorkforceSessionScope(chatId, 600_000);
    if (!ok) {
      return {
        success: false,
        error: "Workforce session scope was not set (cancelled or timed out).",
      };
    }
    result = await ToolRegistry.execute(toolName, executeArgs);
    if (streamOpts?.turnId) {
      recordToolUseForTurn(streamOpts.turnId, toolName);
    }
    maybeStopStreamForCompleteLedger();
  }
  return result;
}

async function resolveAskUserToolResult(
  event: IpcMainInvokeEvent,
  chatId: number,
  toolName: string,
  result: unknown,
  hooks?: { finalizeAskUserBreakpoint?: () => void | Promise<void> },
): Promise<string | null> {
  if (toolName !== "ask_user") return null;
  if (!result || typeof result !== "object" || (result as { __ask_user?: boolean }).__ask_user !== true) {
    return null;
  }
  const q = result as { question: string; options?: string[] };
  const { waitForUserQuestionAnswer } = await import("./user_question_wait");
  await hooks?.finalizeAskUserBreakpoint?.();
  const questionId = `uq_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  safeSend(event.sender, "user-question-request", {
    chatId,
    questionId,
    question: q.question ?? "",
    options: Array.isArray(q.options) && q.options.length > 0 ? q.options : undefined,
  });
  logger.log(`[ask_user] Waiting for UI answer (${questionId})`);
  const answer = await waitForUserQuestionAnswer(chatId, questionId, 30 * 60 * 1000);
  return JSON.stringify({ success: true, answer });
}

/**
 * Detect if AI signals task completion.
 * Checks for explicit <task_complete> tag OR natural language patterns in the end of response.
 */
function isTaskComplete(response: string): boolean {
  // Explicit completion signal
  if (response.includes('<task_complete>')) return true;

  // Natural language patterns (must appear near end of response)
  const completionPatterns = [
    /task (is |has been )?completed successfully/i,
    /i('ve| have) completed (the |all )/i,
    /all done/i,
    /everything (is |has been )?(set up|ready|working)/i,
    /implementation (is )?complete/i,
    /successfully (created|built|implemented|set up)/i,
  ];

  const endOfResponse = response.slice(-500);
  return completionPatterns.some(pattern => pattern.test(endOfResponse));
}

// Track active streams for cancellation
const activeStreams = new Map<number, AbortController>();

/** Clear skill file cache when switching workspace (see `loadSkill`). */
let lastSkillCacheAppId: number | undefined;

// Track partial responses for cancelled streams
const partialResponses = new Map<number, string>();

/** DB: assistant placeholder row receiving post–ask_user continuation (for ordering injected user Q+A). */
const askUserContinuationAssistantIdByChatId = new Map<number, number>();


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
const TEMP_DIR = path.join(os.tmpdir(), "dyad-attachments");

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

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Safely parse an MCP tool key that combines server and tool names.
// We split on the LAST occurrence of "__" to avoid ambiguity if either
// side contains "__" as part of its sanitized name.
function parseMcpToolKey(toolKey: string): {
  serverName: string;
  toolName: string;
} {
  const separator = "__";
  const lastIndex = toolKey.lastIndexOf(separator);
  if (lastIndex === -1) {
    return { serverName: "", toolName: toolKey };
  }
  const serverName = toolKey.slice(0, lastIndex);
  const toolName = toolKey.slice(lastIndex + separator.length);
  return { serverName, toolName };
}

// Ensure the temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/** Abort when the model has an unfinished tool call and no stream chunks arrive for this long. */
const STREAM_TOOL_STALL_MS = 30_000;

// Helper function to process stream chunks
async function processStreamChunks({
  fullStream,
  fullResponse,
  abortController,
  chatId,
  processResponseChunkUpdate,
  onFirstModelActivity,
}: {
  fullStream: AsyncIterableStream<TextStreamPart<ToolSet>>;
  fullResponse: string;
  abortController: AbortController;
  chatId: number;
  processResponseChunkUpdate: (params: {
    fullResponse: string;
  }) => Promise<string>;
  /** Fix: Finding 4 — clear "Thinking…" once the model emits text or tool activity */
  onFirstModelActivity?: () => void;
}): Promise<{ fullResponse: string; incrementalResponse: string }> {
  let incrementalResponse = "";
  let inThinkingBlock = false;
  let firstModelActivitySent = false;
  const markFirstModelActivity = () => {
    if (firstModelActivitySent || !onFirstModelActivity) return;
    firstModelActivitySent = true;
    onFirstModelActivity();
  };

  const applyEmptyFallback = async () => {
    const fb = AI_STREAM_EMPTY_RESPONSE_FALLBACK;
    fullResponse += fb;
    incrementalResponse += fb;
    fullResponse = cleanFullResponse(fullResponse);
    fullResponse = await processResponseChunkUpdate({
      fullResponse,
    });
  };

  let lastStreamProgress = Date.now();
  let pendingToolCallDepth = 0;
  let loggedFirstStreamPart = false;
  let loggedReasoningDelta = false;
  const stallInterval = setInterval(() => {
    if (abortController.signal.aborted) return;
    if (
      pendingToolCallDepth > 0 &&
      Date.now() - lastStreamProgress >= STREAM_TOOL_STALL_MS
    ) {
      logger.warn(
        `[stream-stall] No stream progress for ${STREAM_TOOL_STALL_MS}ms with pending tool call(s); aborting chat ${chatId}`,
      );
      abortController.abort();
    }
  }, 1000);

  try {
    try {
      for await (const part of fullStream) {
    lastStreamProgress = Date.now();
    if (!loggedFirstStreamPart) {
      loggedFirstStreamPart = true;
    }
    let chunk = "";
    if (
      inThinkingBlock &&
      !["reasoning-delta", "reasoning-start"].includes(part.type)
    ) {
      chunk = "</think>";
      inThinkingBlock = false;
    }
    if (part.type === "text-delta") {
      if (part.text) markFirstModelActivity();
      chunk += part.text;
    } else if (part.type === "reasoning-delta") {
      if (!loggedReasoningDelta) {
        loggedReasoningDelta = true;
      }
      if (!inThinkingBlock) {
        chunk = "<think>";
        inThinkingBlock = true;
      }

      chunk += escapeAtlarixTags(part.text);
    } else if (part.type === "tool-call") {
      pendingToolCallDepth += 1;
      markFirstModelActivity();
      const { serverName, toolName } = parseMcpToolKey(part.toolName);
      const content = escapeAtlarixTags(JSON.stringify(part.input));
      // Use native tags for non-MCP tools (serverName is empty or matches toolName)
      if (!serverName || serverName === toolName) {
        // Native tool (from ToolRegistry - Ask mode)
        chunk = `<atlarix-tool-call tool="${toolName}" status="running">\n${content}\n</atlarix-tool-call>\n`;
      } else {
        // MCP tool (from external MCP server)
        chunk = `<atlarix-mcp-tool-call server="${serverName}" tool="${toolName}">\n${content}\n</atlarix-mcp-tool-call>\n`;
      }
    } else if (part.type === "tool-result") {
      pendingToolCallDepth = Math.max(0, pendingToolCallDepth - 1);
      markFirstModelActivity();
      const { serverName, toolName } = parseMcpToolKey(part.toolName);
      const content = escapeAtlarixTags(part.output);
      // Use native tags for non-MCP tools
      if (!serverName || serverName === toolName) {
        // Native tool result
        chunk = `<atlarix-tool-result tool="${toolName}" status="complete">\n${content}\n</atlarix-tool-result>\n`;
      } else {
        // MCP tool result
        chunk = `<atlarix-mcp-tool-result server="${serverName}" tool="${toolName}">\n${content}\n</atlarix-mcp-tool-result>\n`;
      }
    }

    if (!chunk) {
      continue;
    }

    fullResponse += chunk;
    incrementalResponse += chunk;
    fullResponse = cleanFullResponse(fullResponse);
    fullResponse = await processResponseChunkUpdate({
      fullResponse,
    });

    // If the stream was aborted, exit early
    if (abortController.signal.aborted) {
      logger.log(`Stream for chat ${chatId} was aborted`);
      break;
    }
    }
    } catch (err) {
      const isNoUsableOutput = isNoUsableModelOutputError(err);
      if (isNoUsableOutput && !abortController.signal.aborted) {
        logger.warn(
          `Stream for chat ${chatId} produced no usable text (mapped to fallback):`,
          err,
        );
        if (!fullResponse.trim()) {
          await applyEmptyFallback();
        }
      } else {
        throw err;
      }
    }

    if (inThinkingBlock) {
      const flushChunk = "</think>";
      fullResponse += flushChunk;
      incrementalResponse += flushChunk;
      inThinkingBlock = false;
      fullResponse = cleanFullResponse(fullResponse);
      fullResponse = await processResponseChunkUpdate({
        fullResponse,
      });
    }

    if (!abortController.signal.aborted && !fullResponse.trim()) {
      await applyEmptyFallback();
    }

    return { fullResponse, incrementalResponse };
  } finally {
    clearInterval(stallInterval);
  }
}

async function getRecentAutoRoutedTiersFromDb(chatId: number): Promise<ModelTier[]> {
  const rows = await db
    .select({ tier: messages.autoRoutedTier })
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        eq(messages.role, "assistant"),
        isNotNull(messages.autoRoutedTier),
      ),
    )
    .orderBy(desc(messages.id))
    .limit(3);
  return rows
    .map((r) => r.tier)
    .filter((t): t is ModelTier => t === "fast" || t === "balanced" || t === "thinking");
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
  const { chatId, turnId, assistantMessageId, workspacePath, workspaceId } =
    params;
  const skipMessageFlags = params.options?.skipMessageFlags ?? false;
  const filesFilter = params.options?.filesFilter;

  const snap =
    filesFilter != null && filesFilter.length > 0
      ? await revertSnapshotFiles({
          workspacePath,
          turnId,
          relativePaths: filesFilter,
          workspaceId,
        })
      : await revertSnapshot({
          workspacePath,
          turnId,
          workspaceId,
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

  const chatMessages = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(asc(messages.createdAt));
  const idx = chatMessages.findIndex((m) => m.id === assistantMessageId);
  if (idx < 0) {
    return {
      success: false,
      error: "Message not in chat",
      restoredFiles: snap.restoredFiles,
    };
  }
  const idsToMark = chatMessages.slice(idx).map((m) => m.id);
  await db.update(messages).set({ isReverted: false }).where(eq(messages.chatId, chatId));
  if (idsToMark.length > 0) {
    await db
      .update(messages)
      .set({ isReverted: true })
      .where(inArray(messages.id, idsToMark));
  }
  await db
    .update(chats)
    .set({ hasAnsweredQuestions: false })
    .where(eq(chats.id, chatId));

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
    "respond-workspace-permissions",
    async (
      _event,
      payload: { chatId: number; requestId: string; dismissed: boolean; grantedServices?: string[] },
    ): Promise<{ ok: boolean }> => {
      resolveWorkspacePermissionResponse(payload.chatId, payload.requestId, {
        dismissed: payload.dismissed,
        grantedServices: Array.isArray(payload.grantedServices) ? payload.grantedServices : [],
      });
      return { ok: true };
    },
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
      } = await import("./chat_only_handlers");
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

      const contAssistantId = askUserContinuationAssistantIdByChatId.get(payload.chatId);
      let insertCreatedAt = new Date();
      if (contAssistantId != null) {
        const contRow = await db.query.messages.findFirst({
          where: eq(messages.id, contAssistantId),
        });
        if (contRow?.createdAt) {
          insertCreatedAt = new Date(contRow.createdAt.getTime() - 1);
        }
      } else {
        const anchor = await db.query.messages.findFirst({
          where: and(eq(messages.chatId, payload.chatId), eq(messages.role, "assistant")),
          orderBy: [desc(messages.createdAt)],
        });
        if (anchor?.createdAt) {
          insertCreatedAt = new Date(anchor.createdAt.getTime() + 1);
        }
      }

      await db.insert(messages).values({
        chatId: payload.chatId,
        role: "user",
        content,
        createdAt: insertCreatedAt,
      });

      const rowsAfter = await db
        .select()
        .from(messages)
        .where(eq(messages.chatId, payload.chatId))
        .orderBy(asc(messages.createdAt));

      const tail = partialResponses.get(payload.chatId) ?? "";
      const chunkMsgs = rowsAfter.map((row) => {
        const base = {
          id: row.id,
          chatId: row.chatId,
          role: row.role as "user" | "assistant" | "system",
          content: row.content ?? "",
          createdAt: row.createdAt ?? new Date(),
        };
        if (contAssistantId != null && row.id === contAssistantId && tail.length > 0) {
          return { ...base, content: tail };
        }
        return base;
      });

      safeSend(event.sender, "chat:response:chunk", {
        chatId: payload.chatId,
        messages: chunkMsgs as import("../ipc_types").Message[],
      });
      return { success: true };
    },
  );

  ipcMain.handle("workspace:prewarm-cache", async (_event, workspacePath: string) => {
    const { prewarmWorkspaceCache } = await import("./chat_stream/workspace-context");
    await prewarmWorkspaceCache(workspacePath);
    return { ok: true };
  });

  ipcMain.handle("chat:stream", async (event, req: ChatStreamParams) => {
    const abortController = new AbortController();
    activeStreams.set(req.chatId, abortController);
    askUserContinuationAssistantIdByChatId.delete(req.chatId);

    const runStream = async () => {
      let stopAgentOrchestrator: (() => void) | undefined;
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
        let dyadRequestId: string | undefined;
        let hadToolCallsOrPermissions = false;
        let autoRoutedTierForTurn: ModelTier | null = null;

        // Check if this is an ephemeral (incognito) chat BEFORE querying database
        const { isEphemeralChatId, getEphemeralChatAppId } = await import("./chat_only_handlers");

        if (isEphemeralChatId(req.chatId)) {
          // Check if this ephemeral chat is associated with a workspace
          const ephemeralAppId = getEphemeralChatAppId(req.chatId);

          if (ephemeralAppId) {
            // This is an ephemeral WORKSPACE chat - has workspace context
            logger.log(`Chat ${req.chatId} is ephemeral workspace chat for app: ${ephemeralAppId}`);
            // Continue below to use workspace-aware handler with the ephemeral appId
          } else {
            // This is a pure chat-only (no workspace) - use simplified handler with global MCP tools
            logger.log(`Chat ${req.chatId} is ephemeral chat-only mode (incognito)`);
            const mcpTools = await getMcpTools(event, null, req.chatId);
            await handleChatOnlyStream(event, req, abortController, mcpTools as McpToolSet);
            return;
          }
        }

      // Get app for ephemeral workspace chats or regular DB chats
      let chat: any;
      let appData: any;

      if (isEphemeralChatId(req.chatId)) {
        // Ephemeral workspace chat - get app from DB using the stored appId
        const ephemeralAppId = getEphemeralChatAppId(req.chatId);
        const { getEphemeralChat } = await import("./chat_only_handlers");
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
      } else {
        // Get the chat from database (for regular chats)
        chat = await db.query.chats.findFirst({
          where: eq(chats.id, req.chatId),
          with: {
            messages: {
              orderBy: (messages, { asc }) => [asc(messages.createdAt)],
            },
            app: true, // Include app information
          },
        });

        if (!chat) {
          throw new Error(`Chat not found: ${req.chatId}`);
        }

        // Chat-only mode: route to simplified handler (no workspace/codebase) with global MCP tools
        if (!chat.app) {
          logger.log(`Chat ${req.chatId} is chat-only mode (no workspace)`);
          const mcpTools = await getMcpTools(event, null, req.chatId);
          await handleChatOnlyStream(event, req, abortController, mcpTools as McpToolSet);
          return;
        }

        appData = chat.app;
      }

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

      // Handle redo option: remove the most recent messages if needed
      if (req.redo) {
        // Get the most recent messages
        const chatMessages = [...chat.messages];

        // Find the most recent user message
        let lastUserMessageIndex = chatMessages.length - 1;
        while (
          lastUserMessageIndex >= 0 &&
          chatMessages[lastUserMessageIndex].role !== "user"
        ) {
          lastUserMessageIndex--;
        }

        if (lastUserMessageIndex >= 0) {
          // Delete the user message
          await db
            .delete(messages)
            .where(eq(messages.id, chatMessages[lastUserMessageIndex].id));

          // If there's an assistant message after the user message, delete it too
          if (
            lastUserMessageIndex < chatMessages.length - 1 &&
            chatMessages[lastUserMessageIndex + 1].role === "assistant"
          ) {
            await db
              .delete(messages)
              .where(
                eq(messages.id, chatMessages[lastUserMessageIndex + 1].id),
              );
          }
        }
      }

      // v3.9: Continue after clarifying questions — use last user message (already updated with Q/A block)
      let userPrompt: string = "";
      if (req.continueAfterQuestions) {
        const {
          isEphemeralChatId,
          getEphemeralChat,
          buildContinueAfterQuestionsPrompt,
        } = await import("./chat_only_handlers");
        if (isEphemeralChatId(req.chatId)) {
          const ephemeral = getEphemeralChat(req.chatId);
          if (!ephemeral) throw new Error("Chat not found");
          const composed = buildContinueAfterQuestionsPrompt(ephemeral.messages);
          if (!composed.trim()) {
            throw new Error("Continue after questions: no user message content found");
          }
          userPrompt = prepareUserChatTurnInput(composed);
        } else {
          const freshChat = await db.query.chats.findFirst({
            where: eq(chats.id, req.chatId),
            with: {
              messages: { orderBy: (messages, { asc }) => [asc(messages.createdAt)] },
              app: true,
            },
          });
          if (!freshChat) throw new Error("Chat not found");
          const composed = buildContinueAfterQuestionsPrompt(freshChat.messages as { role: string; content?: string | null }[]);
          if (!composed.trim()) {
            throw new Error("Continue after questions: no user message content found");
          }
          userPrompt = prepareUserChatTurnInput(composed);
        }
      }

      // Process attachments if any (skip when continuing after questions)
      let attachmentInfo = "";
      let attachmentPaths: string[] = [];

      if (!req.continueAfterQuestions && req.attachments && req.attachments.length > 0) {
        attachmentInfo = "\n\nAttachments:\n";

        for (const [index, attachment] of req.attachments.entries()) {
          // Generate a unique filename
          const hash = crypto
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

          if (attachment.attachmentType === "upload-to-codebase") {
            // For upload-to-codebase, create a unique file ID and store the mapping
            const fileId = `DYAD_ATTACHMENT_${index}`;

            fileUploadsState.addFileUpload(
              { chatId: req.chatId, fileId },
              {
                filePath,
                originalName: attachment.name,
              },
            );

            // Add instruction for AI to use atlarix-write tag
            attachmentInfo += `\n\nFile to upload to codebase: ${attachment.name} (file id: ${fileId})\n`;
          } else {
            // For chat-context, use the existing logic
            attachmentInfo += `- ${attachment.name} (${attachment.type})\n`;
            // If it's a text-based file, try to include the content
            if (await isTextFile(filePath)) {
              try {
                attachmentInfo += `<atlarix-text-attachment filename="${attachment.name}" type="${attachment.type}" path="${filePath}">
                </atlarix-text-attachment>
                \n\n`;
              } catch (err) {
                logger.error(`Error reading file content: ${err}`);
              }
            }
          }
        }
      }

      // Add user message to database with attachment info (skip when continueAfterQuestions)
      if (!req.continueAfterQuestions) {
        userPrompt = req.prompt + (attachmentInfo ? attachmentInfo : "");
      }
      // Inline referenced prompt contents for mentions like @prompt:<id> (skip when continueAfterQuestions)
      if (!req.continueAfterQuestions) {
        try {
          const matches = Array.from(userPrompt.matchAll(/@prompt:(\d+)/g));
          if (matches.length > 0) {
            const ids = Array.from(new Set(matches.map((m) => Number(m[1]))));
            const referenced = await db
              .select()
              .from(promptsTable)
              .where(inArray(promptsTable.id, ids));
            if (referenced.length > 0) {
              const promptsMap: Record<number, string> = {};
              for (const p of referenced) {
                promptsMap[p.id] = p.content;
              }
              userPrompt = replacePromptReference(userPrompt, promptsMap);
            }
          }
        } catch (e) {
          logger.error("Failed to inline referenced prompts:", e);
        }
      }

      const componentsToProcess = req.continueAfterQuestions ? [] : (req.selectedComponents || []);

      if (componentsToProcess.length > 0) {
        userPrompt += "\n\nSelected components:\n";

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

          userPrompt += `\n${componentsToProcess.length > 1 ? `${componentsToProcess.indexOf(component) + 1}. ` : ""}Component: ${component.name} (file: ${component.relativePath})

Snippet:
\`\`\`
${componentSnippet}
\`\`\`
`;
        }
      }

      // Check if this is an ephemeral workspace chat (skip DB writes)
      const isEphemeralWorkspace = isEphemeralChatId(req.chatId);

      // Only save user message to database for non-ephemeral chats (skip when continueAfterQuestions — user message already updated)
      if (!isEphemeralWorkspace && !req.continueAfterQuestions) {
        clearSelfCorrectionAttemptsForChat(req.chatId);
        await db
          .insert(messages)
          .values({
            chatId: req.chatId,
            role: "user",
            content: userPrompt,
          })
          .returning();
      }
      const settingsBase = readSettings();
      const settings =
        req.streamChatModeOverride != null
          ? { ...settingsBase, selectedChatMode: req.streamChatModeOverride }
          : settingsBase;
      // Only Atlarix Pro requests have request ids.
      if (settings.enableAtlarixPro) {
        // Generate requestId early so it can be saved with the message
        dyadRequestId = uuidv4();
      }

      // Add a placeholder assistant message immediately
      // For ephemeral chats, we'll use a placeholder ID
      let placeholderAssistantMessage: any = { id: Date.now() }; // Default for ephemeral
      let updatedChat: any = chat; // Use the existing chat object for ephemeral

      if (!isEphemeralWorkspace) {
        // v3.9: 0-based exchange index = number of assistant messages before this one
        const exchangeIndex =
          chat.messages.filter((m: any) => m.role === "assistant").length;
        // Regular DB chat - save to database
        const [dbPlaceholder] = await db
          .insert(messages)
          .values({
            chatId: req.chatId,
            role: "assistant",
            content: "", // Start with empty content
            requestId: dyadRequestId,
            sourceCommitHash: await getCurrentCommitHash({
              path: resolveAppPath(chat.app.path),
            }),
            exchangeIndex,
          })
          .returning();
        placeholderAssistantMessage = dbPlaceholder;

        // Fetch updated chat data after possible deletions and additions
        const fetchedChat = await db.query.chats.findFirst({
          where: eq(chats.id, req.chatId),
          with: {
            messages: {
              orderBy: (messages, { asc }) => [asc(messages.createdAt)],
            },
            app: true, // Include app information
          },
        });

        if (!fetchedChat) {
          throw new Error(`Chat not found: ${req.chatId}`);
        }
        updatedChat = fetchedChat;

        // Update lastUsedAt timestamp for chat activity
        await db
          .update(chats)
          .set({ lastUsedAt: new Date() })
          .where(eq(chats.id, req.chatId));

        // Hybrid Chat Naming Logic
        const messageCount = updatedChat.messages.length;

        // On first user message (2 messages total: user + assistant placeholder)
        // Generate simple keyword-based name
        if (messageCount === 2 && !chat.title) {
          const firstUserMessage = updatedChat.messages.find((m: any) => m.role === "user");
          if (firstUserMessage) {
            const simpleName = generateSimpleChatName(firstUserMessage.content);
            await db
              .update(chats)
              .set({ title: simpleName })
              .where(eq(chats.id, req.chatId));
            logger.info(`Generated simple chat name: "${simpleName}" for chat ${req.chatId}`);
          }
        }

        // After 2 user-assistant exchanges (4+ messages), trigger AI naming
        // This will replace the simple keyword-based name with an AI-generated one
        if (shouldTriggerAINaming(messageCount)) {
          try {
            const currentTitle = chat.title || "New chat";
            const conversationMessages = updatedChat.messages.map((m: any) => ({
              role: m.role,
              content: m.content,
            }));

            const aiName = await generateAIChatName(conversationMessages, currentTitle);

            if (aiName !== currentTitle) {
              await db
                .update(chats)
                .set({ title: aiName })
                .where(eq(chats.id, req.chatId));
              logger.info(`Updated chat ${req.chatId} with AI name: "${aiName}"`);
            }
          } catch (error) {
            logger.error(`Failed to generate AI chat name: ${error}`);
            // Fallback to keeping the simple keyword-based name
          }
        }
      } else {
        // Ephemeral workspace chat - no DB operations
        logger.log(`Ephemeral workspace chat ${req.chatId} - skipping DB operations`);
        const { addEphemeralMessage, getEphemeralChat } = await import("./chat_only_handlers");
        // Build from current store WITHOUT adding the new user message yet to avoid duplication
        const ephemeralChat = getEphemeralChat(req.chatId);
        const existingMessages = ephemeralChat?.messages || [];

        const newUserMessage = {
          id: Date.now(),
          chatId: req.chatId,
          role: "user",
          content: userPrompt,
          createdAt: new Date(),
          sourceCommitHash: null,
          commitHash: null,
        };
        const placeholderMessage = {
          id: Date.now() + 1,
          chatId: req.chatId,
          role: "assistant",
          content: "", // Empty - will be filled by streaming
          createdAt: new Date(),
          sourceCommitHash: null,
          commitHash: null,
        };

        updatedChat.messages = [...existingMessages, newUserMessage, placeholderMessage];
        placeholderAssistantMessage = placeholderMessage;
        if (ephemeralChat) {
          ephemeralChat.messages = updatedChat.messages;
        }
      }

      let streamTurnIdForLedger = String(placeholderAssistantMessage.id);
      let streamStopWasTaskComplete = false;
      const delegatedAgentsThisTurn: string[] = [];
      const buildToolStreamOpts = () => ({
        turnId: streamTurnIdForLedger,
        abortController,
        onTaskLedgerComplete: () => {
          streamStopWasTaskComplete = true;
        },
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
          agentMode: settings.agentMode ?? "guided",
          delegationRole: "main",
        };
        let effectiveModel = getEffectiveModel(settings);
        if (req.modelOverride) {
          effectiveModel = req.modelOverride;
        } else if (settings.autoModelRouting && effectiveModel.provider === "auto") {
          const { runAutoRouterAsync, recommendModeRoute } = await import("../../lib/routing/auto-router");
          const hasPlanHint = (updatedChat.messages ?? []).some((m: any) =>
            String(m?.content ?? "").includes("ATLARIX_PLAN.md"),
          );
          const routingMsgs = (updatedChat.messages ?? []).map((m: any) => ({
            role: m.role,
            content: String(m.content ?? ""),
            autoRoutedTier: m.autoRoutedTier as ModelTier | null | undefined,
          }));
          const recentAssistantTiers =
            !isEphemeralWorkspace && req.chatId > 0
              ? await getRecentAutoRoutedTiersFromDb(req.chatId)
              : getRecentAssistantRoutingTiers(routingMsgs, 3);
          const lastTier = recentAssistantTiers[0] ?? null;
          const messageIndex = (updatedChat.messages ?? []).filter((m: any) => m.role === "user").length;
          const prov = settings.autoProviderId;
          const ids = settings.autoModelIds;
          const forceThinking =
            req.forceThinkingTier === true &&
            prov &&
            Array.isArray(ids) &&
            Boolean(ids[0]) &&
            Boolean(ids[1]) &&
            Boolean(ids[2]);
          if (forceThinking) {
            effectiveModel = { provider: prov, name: ids[2]! };
            autoRoutedTierForTurn = "thinking";
            if (settings.autoRoutingShowReasoning !== false) {
              safeSend(event.sender, "chat:activity", {
                id: `routing-${req.chatId}-${Date.now()}`,
                type: "routing_decision",
                label: `Auto → thinking tier (Deep think)`,
                status: "done",
                timestamp: Date.now(),
                chatId: req.chatId,
              });
            }
          } else {
          const { decision, model, classifierMeta } = await runAutoRouterAsync(
            req.prompt,
            settings,
            mainOptions,
            {
              messages: routingMsgs,
              taskState: {
                currentMode: settings.selectedChatMode ?? "ask",
                workModePreference: settings.workModePreference ?? "ask",
                agentMode: settings.agentMode ?? "guided",
                hasActivePlan: hasPlanHint,
                lastTier,
                messageIndex,
                recentAssistantTiers,
              },
            },
          );
          const modeRoute = recommendModeRoute({
            prompt: req.prompt,
            hasPlan: hasPlanHint,
            activeBuild: settings.selectedChatMode === "build",
            lastMode: settings.workModePreference,
          });
          effectiveModel = model;
          autoRoutedTierForTurn = decision.tier;
          if (settings.autoRoutingShowReasoning !== false) {
            const srcLabel =
              classifierMeta.source === "groq"
                ? "groq"
                : classifierMeta.source === "fast-model"
                  ? "fast-model"
                  : "fallback";
            const pctPart =
              classifierMeta.confidence != null
                ? ` (${Math.round(classifierMeta.confidence * 100)}%)`
                : "";
            safeSend(event.sender, "chat:activity", {
              id: `classifier-${req.chatId}-${Date.now()}`,
              type: "classifier_routing",
              label: `Classifier → ${classifierMeta.tier}${pctPart} via ${srcLabel}`,
              status: "done",
              timestamp: Date.now(),
              chatId: req.chatId,
            });
            const agentHint = decision.recommendedAgent
              ? ` · delegate: ${String(decision.recommendedAgent).replace(/^./, (c) => c.toUpperCase())}`
              : "";
            safeSend(event.sender, "chat:activity", {
              id: `routing-${req.chatId}-${Date.now()}`,
              type: "routing_decision",
              label: `Auto → ${decision.targetModel} (${decision.category})${agentHint}`,
              status: "done",
              timestamp: Date.now(),
              chatId: req.chatId,
              detail: `${modeRoute.recommended_mode}: ${modeRoute.reason}`,
            });
          }
          }
        }
        const { modelClient, isEngineEnabled, isSmartContextEnabled } =
          await getModelClient(effectiveModel, settings, mainOptions);
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

        let deepThinkCounselPromptBlock: string | null = null;
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

        // Resolve effective workspace: sidebar selection (req.appId) overrides when present and different from chat's app
        let effectiveApp = updatedChat.app;
        if (req.appId != null && req.appId !== updatedChat.app?.id) {
          const overrideApp = await db.query.apps.findFirst({
            where: eq(apps.id, req.appId),
          });
          if (overrideApp) effectiveApp = overrideApp;
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

        if (
          req.forceThinkingTier === true &&
          !forceThinkingNativeSupported &&
          settings.counsel?.enabled !== false
        ) {
          try {
            const { runCounselPipeline } = await import("@/lib/counsel/counsel-runner");
            const cleanQ = (userPrompt || req.prompt).slice(0, 12000);
            deepThinkCounselPromptBlock = await runCounselPipeline({
              chatId: req.chatId,
              turnId: streamTurnIdForLedger,
              trigger: "deep_think_fallback",
              mode: hasWorkspace && appPath ? "workspace" : "general",
              question: cleanQ,
              settings,
              sendActivity: (payload) => {
                safeSend(event.sender, "chat:activity", payload);
              },
              workspacePath: hasWorkspace && appPath ? appPath : undefined,
              workspaceId: hasWorkspace ? (effectiveAppId ?? undefined) : undefined,
              toolActivity: { webContents: event.sender, chatId: req.chatId },
              onCounselStreamLifecycle: (phase) => {
                safeSend(event.sender, "chat:stream:phase", {
                  chatId: req.chatId,
                  phase,
                  label: phase === "counsel_start" ? "Consulting the counsel..." : "",
                });
              },
            });
          } catch (deepCounselErr) {
            logger.warn("[counsel] Deep-think substitute counsel failed:", deepCounselErr);
            deepThinkCounselPromptBlock = null;
          }
        }

        let codebaseInfo = "";
        let files: any[] = [];
        let chatContext: any = { contextPaths: [], smartContextAutoIncludes: [] };

        if (hasWorkspace) {
          // When we don't have smart context enabled, we
          // only include the selected components' files for codebase context.
          //
          // If we have selected components and smart context is enabled,
          // we handle this specially below.
          chatContext =
            req.selectedComponents &&
              req.selectedComponents.length > 0 &&
              !isSmartContextEnabled
              ? {
                contextPaths: req.selectedComponents.map((component) => ({
                  globPath: component.relativePath,
                })),
                smartContextAutoIncludes: [],
              }
              : validateChatContext(effectiveApp!.chatContext);

          // --- DIAGRAM-FIRST CONTEXT SYSTEM ---
          // Instead of extracting full codebase (168K+ tokens), we:
          // 1. Inject diagram context via getWorkspaceContext() (below at line ~700)
          // 2. Let AI use file tools (read_file, search_code, list_files) on demand
          // This reduces context from ~168K to ~3-4K tokens (97% reduction)

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

          // ═══════════════════════════════════════════════════════════════
          // COLD START: Background diagram generation for new workspaces
          // Start non-blocking generation if no diagram exists yet
          // ═══════════════════════════════════════════════════════════════
          const workspaceId = effectiveAppId;
          if (workspaceId) {
            try {
              const { DiagramManager } = await import("../../lib/DiagramManager");
              const hasDiagram = await DiagramManager.hasAnyDiagram(workspaceId);

              if (!hasDiagram && !DiagramManager.isGenerating(workspaceId)) {
                logger.info(
                  `[Cold Start] Deferring background diagram generation 5s for workspace ${workspaceId} (workspace may close; generation is best-effort)`,
                );

                const coldWorkspaceId = workspaceId;
                const coldAppPath = appPath;
                const coldSender = event.sender;
                setTimeout(() => {
                  void (async () => {
                    try {
                      const { DiagramManager: DM } = await import("../../lib/DiagramManager");
                      if (DM.isGenerating(coldWorkspaceId)) return;
                      if (await DM.hasAnyDiagram(coldWorkspaceId)) return;
                      logger.info(
                        `[Cold Start] Starting background diagram generation for workspace ${coldWorkspaceId}`,
                      );
                      const diagram = await DM.generateInitialDiagram(coldWorkspaceId, coldAppPath);
                      logger.info(`[Cold Start] Initial diagram ready for workspace ${coldWorkspaceId}`);
                      safeSend(coldSender, "diagram:initial-ready", {
                        workspaceId: coldWorkspaceId,
                        diagramId: diagram.id,
                        title: diagram.title,
                      });
                    } catch (err) {
                      logger.error(`[Cold Start] Background diagram generation failed:`, err);
                    }
                  })();
                }, 5000);
              } else if (DiagramManager.isGenerating(workspaceId)) {
                logger.info(`[Cold Start] Diagram generation already in progress for workspace ${workspaceId}`);
              }
            } catch (coldStartError) {
              logger.warn("[Cold Start] Failed to check/start diagram generation:", coldStartError);
            }
          }

          // Prepare message history for the AI
          // Note: For ephemeral messages, sourceCommitHash and commitHash may be undefined
          // We only include them if they have actual values to avoid confusing the AI SDK
          type Msg = { role: string; content?: string; sourceCommitHash?: string; commitHash?: string };
          const messageHistory = updatedChat.messages.map((message: Msg) => {
            const content = message.content || "";
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


          // Phase 6: Context bar + auto-summarize OR fallback to turn truncation
          const useAutoSummarize =
            settings.enableContextAutoSummarize !== false &&
            req.chatId > 0 &&
            !isEphemeralWorkspace;

          let limitedMessageHistory = messageHistory;
          let contextSummaryForSystem: string | null = null;

          if (useAutoSummarize) {
            const msgList = updatedChat.messages as { id: number; role: string; content: string }[];
            const messageHistoryTokens = msgList.reduce(
              (acc, m) => acc + estimateTokens(m.content || ""),
              0
            );
            const systemPromptEstimate = 6000; // Conservative: base + diagram + session memory
            const inputTokens = estimateTokens(userPrompt);

            // Check for existing summary
            const existingSummary = await getContextSummary(req.chatId);
            if (existingSummary) {
              contextSummaryForSystem = existingSummary.summaryText;
              const afterSummary = msgList.filter((m) => m.id > existingSummary.lastMessageId);
              limitedMessageHistory = afterSummary.map((m) => ({
                role: m.role as "user" | "assistant" | "system",
                content: m.content || "",
              }));
              logger.log(
                `Using context summary + ${afterSummary.length} messages (after msg ${existingSummary.lastMessageId})`,
              );
            } else {
              const toolCallsInLast6 = msgList
                .slice(-6)
                .filter((m) => (m.content || "").includes("tool_result") || (m.content || "").includes("tool_use"))
                .length;
              const toolCallCount = msgList.filter(
                (m) => (m.content || "").includes("tool_result") || (m.content || "").includes("tool_use")
              ).length;
              const delegationCount = msgList.filter(
                (m) => (m.content || "").includes("delegate_to_agent") || (m.content || "").includes("delegation")
              ).length;
              const shouldRun = await shouldCompact({
                chatId: req.chatId,
                messageHistoryTokens,
                systemPromptTokens: systemPromptEstimate,
                inputTokens,
                providerId: getEffectiveModelForOptions(settings)?.provider,
                exchangeCount: msgList.length,
                toolCallsInLast6,
                hasWorkspace: !!hasWorkspace,
              });
              if (shouldRun) {
              // Emit "running" so frontend can show summarization progress above input
              safeSend(event.sender, "chat:activity", {
                id: `compaction-start-${req.chatId}-${Date.now()}`,
                type: "background",
                label: "Summarizing conversation",
                status: "running",
                timestamp: Date.now(),
                chatId: req.chatId,
              });
              // Run compaction when over threshold
              const compactionResult = await runCompaction({
                chatId: req.chatId,
                chatMessages: msgList.map((m) => ({ id: m.id, role: m.role, content: m.content || "" })),
                systemPromptTokens: systemPromptEstimate,
                inputTokens,
                providerId: getEffectiveModelForOptions(settings)?.provider,
                sessionStats: { toolCallCount, delegationCount },
              });
              if (compactionResult.status === "completed") {
                contextSummaryForSystem = compactionResult.summaryText;
                limitedMessageHistory = compactionResult.messagesAfterSummary.map((m) => ({
                  role: m.role as "user" | "assistant" | "system",
                  content: m.content || "",
                }));
                logger.log(
                  `Compaction complete: ${compactionResult.messagesAfterSummary.length} messages after summary`,
                );
                safeSend(event.sender, "chat:activity", {
                  id: `compaction-${req.chatId}-${Date.now()}`,
                  type: "background",
                  label: "Summarizing conversation",
                  status: "done",
                  timestamp: Date.now(),
                  detail: `Compacted to ${compactionResult.messagesAfterSummary.length} messages`,
                  chatId: req.chatId,
                });
                // Persist to .atlarix/ATLARIX.md for cross-session memory
                if (hasWorkspace && appPath) {
                  writeAtlarixMd(appPath, compactionResult.summaryText).catch((err) =>
                    logger.warn("Failed to write .atlarix/ATLARIX.md:", err)
                  );
                }
              }
              }
            }
          }

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

          const contextSize = Math.min(await getContextWindow(), 128_000);
          const chatMode: "ask" | "build" =
            settings.selectedChatMode === "agent"
              ? "build"
              : (settings.selectedChatMode === "ask" || settings.selectedChatMode === "build" ? settings.selectedChatMode : "ask");
          let baseSystemPrompt: string;
          let contextAssemblerBlob = "";
          let blueprintRequiredBlockMessage: string | null = null;
          if (hasWorkspace && appPath && effectiveAppId != null) {
            const workspacePromptRow = await db.query.prompts.findFirst({
              where: and(
                eq(promptsTable.type, "workspace"),
                eq(promptsTable.workspaceId, effectiveAppId),
              ),
            });
            baseSystemPrompt = await buildSystemPromptWithProjectInstructions({
              workspacePath: appPath,
              workspacePromptContent: workspacePromptRow?.content ?? null,
              contextSize,
              chatMode,
              userPrompt: userPrompt,
              hasAnsweredQuestions: updatedChat?.hasAnsweredQuestions ?? false,
            });
          } else {
            baseSystemPrompt = constructSystemPrompt({
              chatMode,
              contextSize,
              userPrompt,
              enableTurboEditsV2: isTurboEditsV2Enabled(settings),
              hasAnsweredQuestions: updatedChat?.hasAnsweredQuestions ?? false,
            });
          }

          const intentModeForContext = settings.intentMode ?? chatMode;
          const effectiveWorkMode: WorkMode =
            intentModeForContext === "auto"
              ? (chatMode === "build" ? "build" : "ask")
              : (settings.workModePreference ?? (chatMode === "build" ? "build" : "ask"));
          const contextSections: ContextSection[] = [];

          const resolvedTierForCounsel = autoRoutedTierForTurn ?? contextBudgetTier;
          if (
            settings.counsel?.enabled !== false &&
            req.forceThinkingTier !== true &&
            !req.prompt.startsWith("Summarize from chat-id=") &&
            !req.prompt.startsWith("/security-review")
          ) {
            try {
              const { detectCounselTrigger, stripCounselCommand } = await import(
                "@/lib/counsel/counsel-trigger",
              );
              const trigger = detectCounselTrigger(req.prompt, resolvedTierForCounsel, {
                autoTriggerOnThinking: settings.counsel?.autoTriggerOnThinking !== false,
                selectedChatMode: settings.selectedChatMode ?? "ask",
              });
              if (trigger) {
                const cleanQ = stripCounselCommand(userPrompt || req.prompt).slice(0, 12000);
                captureSafe("counsel_triggered", {
                  trigger_type: trigger,
                  chat_mode: settings.selectedChatMode ?? "unknown",
                  has_workspace: Boolean(hasWorkspace && appPath),
                });
                const { runCounselPipeline } = await import("@/lib/counsel/counsel-runner");
                const { storeCounselSynthesisForNextTurn } = await import(
                  "@/lib/counsel/counsel-next-turn-cache",
                );
                const counselTimeoutMs = Math.min(
                  120_000,
                  Math.max(5_000, (settings.counsel?.timeoutSeconds ?? 30) * 1000),
                );
                /** Non-blocking: stream does not wait; synthesis available for the following turn (real chats only). */
                void Promise.race([
                  runCounselPipeline({
                    chatId: req.chatId,
                    turnId: streamTurnIdForLedger,
                    trigger,
                    mode: hasWorkspace && appPath ? "workspace" : "general",
                    question: cleanQ,
                    settings,
                    sendActivity: (payload) => {
                      safeSend(event.sender, "chat:activity", payload);
                    },
                    workspacePath: hasWorkspace && appPath ? appPath : undefined,
                    workspaceId: hasWorkspace ? (effectiveAppId ?? undefined) : undefined,
                    toolActivity: { webContents: event.sender, chatId: req.chatId },
                    onCounselStreamLifecycle: (phase) => {
                      safeSend(event.sender, "chat:stream:phase", {
                        chatId: req.chatId,
                        phase,
                        label: phase === "counsel_start" ? "Consulting the counsel..." : "",
                      });
                    },
                  }),
                  new Promise<string>((_, reject) =>
                    setTimeout(() => reject(new Error("counsel_timeout")), counselTimeoutMs),
                  ),
                ])
                  .then((synthesis) => {
                    if (req.chatId > 0 && synthesis.trim()) {
                      storeCounselSynthesisForNextTurn(req.chatId, synthesis);
                    }
                  })
                  .catch((counselErr) => {
                    logger.warn("[counsel] Pipeline failed or timed out:", counselErr);
                    sentryCaptureExceptionSafe(counselErr, {
                      tags: { feature: "counsel" },
                    });
                  });
              }
            } catch (counselErr) {
              logger.warn("[counsel] Trigger detection failed:", counselErr);
            }
          }

          try {
            const modeKey =
              settings.selectedChatMode === "agent"
                ? "build"
                : (settings.selectedChatMode ?? "ask");
            const modeSkillName = getSkillNameForMode(modeKey);
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
          } catch (skillErr) {
            logger.warn("[skills] Failed to load mode skill:", skillErr);
          }
          const shouldCreateTaskLedger =
            settings.selectedChatMode === "build" ||
            settings.selectedChatMode === "agent" ||
            settings.agentMode === "autonomous" ||
            effectiveWorkMode === "plan";
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
                  const { tryReadPlanDetailed, parsePlanToSteps, extractPlanTitle } = await import(
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

          let parallelPrefetchContext = "";
          if (
            settings.agentMode === "autonomous" &&
            hasWorkspace &&
            appPath &&
            shouldCreateTaskLedger &&
            !req.prompt.startsWith("Summarize from chat-id=") &&
            !req.prompt.startsWith("/security-review")
          ) {
            try {
              const { tryReadPlan } = await import("@/lib/tasks/atlarix-plan-steps");
              const planBody = await tryReadPlan(appPath);
              const hasExistingPlan = !!(planBody && planBody.trim().length > 0);
              const {
                classifyOrchestration,
                runAgentsInParallel,
                buildParallelContext,
              } = await import("@/lib/agents/parallel-runner");
              const pattern = classifyOrchestration(userPrompt || req.prompt, hasExistingPlan);
              if (pattern === "research_then_build") {
                safeSend(event.sender, "chat:activity", {
                  id: `parallel-${Date.now()}`,
                  type: "parallel_prefetch_start",
                  label: "Research + planning (parallel)",
                  status: "running",
                  timestamp: Date.now(),
                  chatId: req.chatId,
                  detail: "Running in background — stream is not waiting",
                });
                const taskText = (userPrompt || req.prompt).slice(0, 8000);
                const common = {
                  turnId: streamTurnIdForLedger,
                  depth: 0 as const,
                  chatId: req.chatId,
                  workspacePath: appPath,
                  workspaceId: effectiveAppId ?? undefined,
                  recordOnParentLedger: false as const,
                };
                const prefetchSender = event.sender;
                const prefetchChatId = req.chatId;
                parallelPrefetchContext = [
                  "[Orchestration: research_then_build_inflight]",
                  "Research and architect specialists were started in parallel in the background.",
                  "Their combined markdown will be injected on your **next** message in this chat when ready (consume-once cache).",
                  "This turn: answer from the current user request and normal context; do not assume specialist prefetch output is available yet.",
                ].join("\n");
                void import("@/lib/agents/parallel-prefetch-next-turn-cache")
                  .then(({ storeParallelPrefetchForNextTurn }) =>
                    runAgentsInParallel(
                      [
                        {
                          agentId: "research",
                          task: `Research context for: ${taskText}`,
                          ...common,
                        },
                        {
                          agentId: "architect",
                          task: `Plan implementation for: ${taskText}`,
                          ...common,
                        },
                      ],
                      120_000,
                    ).then((results) => {
                      const raCtx = buildParallelContext(results);
                      if (prefetchChatId > 0) {
                        storeParallelPrefetchForNextTurn(prefetchChatId, raCtx);
                      }
                      safeSend(prefetchSender, "chat:activity", {
                        id: `parallel-done-${Date.now()}`,
                        type: "parallel_prefetch_complete",
                        label: "Research + planning complete",
                        status: "done",
                        timestamp: Date.now(),
                        chatId: prefetchChatId,
                        detail: `${results.length} specialist runs finished`,
                        stepCount: results.length,
                      });
                    }),
                  )
                  .catch((parallelBgErr) => {
                    logger.warn(
                      "[parallel] Background research+architect prefetch failed:",
                      parallelBgErr,
                    );
                  });
              } else if (pattern === "build_then_verify") {
                parallelPrefetchContext = [
                  "[Orchestration: build_then_verify]",
                  "A plan exists. Execute it step by step.",
                  "Reviewer and Debugger will verify automatically when complete.",
                ].join("\n");
              }
            } catch (parallelErr) {
              logger.warn("[parallel] Autonomous prefetch failed:", parallelErr);
            }
          }
          if (parallelPrefetchContext.trim()) {
            const prefetchTail = parallelPrefetchContext.includes(
              "[Orchestration: build_then_verify]",
            )
              ? "\n\nExecute the existing plan step by step. Reviewer and Debugger will run automatically after the task completes."
              : parallelPrefetchContext.includes(
                    "[Orchestration: research_then_build_inflight]",
                  )
                ? "\n\nParallel research + architect are running in the background; their combined output will be injected on your **next** message in this chat when ready. This turn: proceed from the current user request without assuming that output is already available."
                : "\n\nThe above steps already ran. Continue from the current user request without redoing the same research, planning, or implementation unless something failed or the user changed scope.";
            contextSections.push({
              name: "parallelPrefetch",
              priority: 0.25,
              content: parallelPrefetchContext + prefetchTail,
            });
          }

          const ledgerRow = getLedger(streamTurnIdForLedger);
          if (ledgerRow) {
            contextSections.push({
              name: "taskProgress",
              priority: 0,
              content: formatLedgerForPrompt(ledgerRow),
            });
          }

          // Filesystem truth: last completed step’s on-disk file excerpts (protected system prefix; not chat history).
          if (
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

          try {
            const im = settings.intentMode ?? chatMode;
            if (im !== "auto" && settings.workModePreference) {
              const { workModeSystemHint } = await import("@/lib/agents/work-mode-agents");
              const hint = workModeSystemHint(settings.workModePreference);
              contextSections.push({
                name: "workModeHint",
                priority: 1,
                content: `## Work mode\n${hint}`,
              });
            }
          } catch {
            /* non-fatal */
          }

          // Inject workspace analysis context (diagram-first analysis)
          // This prevents AI hallucination by providing accurate structure info
          try {
            const workspaceContext = await getWorkspaceContext(appPath);
            if (workspaceContext) {
              contextSections.push({
                name: "workspaceAnalysis",
                priority: 3,
                content: workspaceContext.systemPromptAddition,
              });
              logger.info(`Injected workspace context (fromCache: ${workspaceContext.fromCache})`);

              // Send diagram to renderer for RightPanel display
              safeSend(event.sender, "chat:workspace-diagram", {
                chatId: req.chatId,
                diagram: workspaceContext.diagram,
                summary: workspaceContext.summary,
              });

              // Save diagram to database for Diagrams page (only if not from cache to avoid duplicates)
              if (!workspaceContext.fromCache && workspaceContext.diagram) {
                try {
                  // For ephemeral chats (negative IDs), don't save chatId (FK constraint would fail)
                  const isEphemeralChat = req.chatId < 0;
                  const workspaceId = effectiveAppId ?? req.appId ?? null;
                  if (workspaceId != null) {
                    const existing = await db.query.diagrams.findFirst({
                      where: eq(diagrams.workspaceId, workspaceId),
                    });

                    if (existing) {
                      await db
                        .update(diagrams)
                        .set({
                          chatId: isEphemeralChat ? null : req.chatId,
                          diagramType: "architecture",
                          title: `Architecture - ${workspaceContext.summary}`,
                          content: workspaceContext.diagram,
                          metadata: { summary: workspaceContext.summary },
                          updatedAt: new Date(),
                        })
                        .where(eq(diagrams.id, existing.id));
                      logger.info(`Updated workspace diagram in database for appId: ${workspaceId}`);
                    } else {
                      await db.insert(diagrams).values({
                        workspaceId,
                        chatId: isEphemeralChat ? null : req.chatId,
                        diagramType: "architecture",
                        title: `Architecture - ${workspaceContext.summary}`,
                        content: workspaceContext.diagram,
                        metadata: { summary: workspaceContext.summary },
                      });
                      logger.info(`Saved workspace diagram to database for appId: ${workspaceId}`);
                    }
                  }
                } catch (dbError) {
                  logger.warn("Failed to save diagram to database:", dbError);
                }
              }
            }

            // v4.0 Workforce: inject Workspace Context block (connected extensions) for Workforce tier only
            try {
              const workforceBlock = await buildWorkforceWorkspaceContextBlock(
                req.chatId < 0 ? null : req.chatId,
              );
              if (workforceBlock) {
                contextSections.push({
                  name: "workspaceAnalysis",
                  priority: 3,
                  content: workforceBlock,
                });
                logger.info("Injected Workforce workspace context block");
              }
            } catch (workforceErr) {
              logger.warn("Failed to build Workforce workspace context:", workforceErr);
            }
          } catch (error) {
            logger.warn("Failed to inject workspace context:", error);
          }

          if (hasWorkspace && effectiveAppId != null && effectiveAppId > 0 && appPath) {
            try {
              const { getBlueprintForWorkspace } = await import("./blueprint_handlers");
              const {
                resolveBlueprintInjectionMode,
                buildBlueprintSystemPromptInjection,
                isBlueprintEffectivelyEmpty,
                blueprintFirstBlockedMessage,
              } = await import("@/lib/blueprint/blueprintPromptTiers");
              const bp = await getBlueprintForWorkspace(effectiveAppId);
              const bpPref = settings.blueprintInjectionModePreference ?? "auto";
              const explicitFromPreference =
                bpPref === "auto"
                  ? undefined
                  : (bpPref as "ask" | "plan" | "build" | "debug");
              const effectiveExplicitBlueprintMode =
                req.blueprintInjectionMode ?? explicitFromPreference;
              const injectionMode = resolveBlueprintInjectionMode({
                chatMode,
                userPrompt: userPrompt || req.prompt,
                explicitBlueprintMode: effectiveExplicitBlueprintMode,
              });
              const debugTraceForBlueprint =
                injectionMode === "debug"
                  ? (req.blueprintDebugTrace?.trim() ||
                      settings.blueprintDebugTrace?.trim() ||
                      undefined)
                  : undefined;
              const debugFileForBlueprint =
                injectionMode === "debug"
                  ? (req.blueprintDebugFile?.trim() ||
                      settings.blueprintDebugFile?.trim() ||
                      undefined)
                  : undefined;
              const emptyBp = isBlueprintEffectivelyEmpty(bp);
              if ((injectionMode === "plan" || injectionMode === "build") && emptyBp) {
                const blocked = blueprintFirstBlockedMessage();
                contextSections.push({
                  name: "blueprint",
                  priority: 2,
                  content: blocked,
                });
                blueprintRequiredBlockMessage = blocked;
                logger.info("Injected blueprint-first blocker (empty blueprint; plan/build tier)");
              } else if (!emptyBp) {
                const { body } = await buildBlueprintSystemPromptInjection({
                  mode: injectionMode,
                  workspaceId: effectiveAppId,
                  blueprint: bp,
                  workspacePath: appPath,
                  userPrompt: userPrompt || req.prompt,
                  errorTrace: debugTraceForBlueprint,
                  bugFilePath: debugFileForBlueprint,
                });
                if (body) {
                  contextSections.push({
                    name: "blueprint",
                    priority: 2,
                    content: `## Blueprint (Diagram tab)\n\n${body}`,
                  });
                  logger.info(`Injected tiered blueprint into system prompt (mode=${injectionMode})`);
                }
              }
            } catch (bpErr) {
              logger.warn("Failed to inject blueprint into system prompt:", bpErr);
            }
          }

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

          // Project-level .atlarix/ATLARIX.md (legacy memory/spec auto-migrated)
          if (hasWorkspace && appPath) {
            try {
              const atlarixMd = await readAtlarixMd(appPath);
              if (atlarixMd) {
                contextSections.push({
                  name: "projectMemory",
                  priority: 4,
                  content: `## Project memory (.atlarix/ATLARIX.md)\n${atlarixMd}`,
                });
                logger.info("Injected .atlarix/ATLARIX.md");
              }
            } catch (memErr) {
              logger.warn("Failed to read .atlarix/ATLARIX.md:", memErr);
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
            if (sessionContext) {
              contextSections.push({
                name: "sessionMemory",
                priority: 6,
                content: sessionContext,
              });
              logger.info(`Injected session memory (${sessionMemory.getExchangeCount()} exchanges, ~${sessionMemory.estimateTokens()} tokens)`);
            }
          } catch (error) {
            logger.warn("Failed to inject session memory:", error);
          }

          if (req.chatId > 0) {
            const { consumeCounselSynthesisForNextTurn } = await import(
              "@/lib/counsel/counsel-next-turn-cache",
            );
            const priorCounsel = consumeCounselSynthesisForNextTurn(req.chatId);
            if (priorCounsel?.trim()) {
              contextSections.push({
                name: "counsel",
                priority: -0.75,
                content: [
                  "## Counsel (prior turn)",
                  "The following multi-perspective synthesis was produced after your previous message finished. Use it as grounding; the **current** user message is the source of truth.",
                  "",
                  priorCounsel.trim(),
                ].join("\n"),
              });
            }
            const { consumeParallelPrefetchForNextTurn } = await import(
              "@/lib/agents/parallel-prefetch-next-turn-cache",
            );
            const priorPrefetch = consumeParallelPrefetchForNextTurn(req.chatId);
            if (priorPrefetch?.trim()) {
              contextSections.push({
                name: "parallelPrefetch",
                priority: -0.7,
                content: [
                  "## Parallel prefetch (prior turn)",
                  "Research + architect ran in parallel after your previous message; the combined output below is for grounding only — the **current** user message is the source of truth.",
                  "",
                  priorPrefetch.trim(),
                ].join("\n"),
              });
            }
          }

          if (deepThinkCounselPromptBlock?.trim()) {
            contextSections.push({
              name: "counselDeepThinkSubstitute",
              priority: -0.8,
              content: deepThinkCounselPromptBlock.trim(),
            });
          }

          const assembledContext = assembleContextSections({
            chatId: req.chatId,
            appId: effectiveAppId ?? null,
            workMode: effectiveWorkMode,
            userPrompt: userPrompt || req.prompt,
            sections: contextSections,
          });
          let systemPrompt = baseSystemPrompt;
          if (assembledContext.activeSkillAddition?.trim()) {
            systemPrompt = `${assembledContext.activeSkillAddition.trim()}\n\n${systemPrompt}`;
          }
          if (assembledContext.taskProgressAddition?.trim()) {
            systemPrompt += `\n\n${assembledContext.taskProgressAddition}`;
          }
          if (assembledContext.fileSystemTruthAddition?.trim()) {
            systemPrompt += `\n\n${assembledContext.fileSystemTruthAddition}`;
          }
          if (assembledContext.finalSystemPromptAddition.trim()) {
            contextAssemblerBlob = assembledContext.finalSystemPromptAddition;
            systemPrompt += `\n\n${contextAssemblerBlob}`;
          } else {
            contextAssemblerBlob = "";
          }
          logger.info(
            `[ContextAssembler] mode=${effectiveWorkMode} cap=${assembledContext.modeCap} cacheHit=${assembledContext.cache.hit} sections=${assembledContext.assembledPromptSections.filter((s) => s.included).length}/${assembledContext.assembledPromptSections.length}`,
          );
          if (assembledContext.trimReport.length > 0) {
            logger.info(`[ContextAssembler] trims: ${assembledContext.trimReport.join(" | ")}`);
          }
          const hasInjectedArchitectureContext =
            assembledContext.assembledPromptSections.some(
              (s) =>
                s.included &&
                (s.name === "blueprint" || s.name === "workspaceAnalysis"),
            );
          // Add information about mentioned apps if any
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
              // Best-effort: if reading rules fails, continue without them
              logger.info("Failed to read security rules", error);
            }
          }

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
            // Neon projects don't need Supabase.
            !effectiveApp?.neonProjectId &&
            // If in security review mode, we don't need to mention supabase is available.
            !isSecurityReviewIntent
          ) {
            systemPrompt += "\n\n" + SUPABASE_NOT_AVAILABLE_SYSTEM_PROMPT;
          }
          const isSummarizeIntent = req.prompt.startsWith(
            "Summarize from chat-id=",
          );
          if (isSummarizeIntent) {
            systemPrompt = SUMMARIZE_CHAT_SYSTEM_PROMPT;
          }

          // Update the system prompt for images if there are image attachments
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
          // If there's mixed attachments (e.g. some upload to codebase attachments and some upload images as chat context attachemnts)
          // we will just include the file upload system prompt, otherwise the AI gets confused and doesn't reliably
          // print out the atlarix-write tags.
          // Usually, AI models will want to use the image as reference to generate code (e.g. UI mockups) anyways, so
          // it's not that critical to include the image analysis instructions.
          if (hasUploadedAttachments) {
            systemPrompt += `
  
When files are attached to this conversation, upload them to the codebase using this exact format:

<atlarix-write path="path/to/destination/filename.ext" description="Upload file to codebase">
DYAD_ATTACHMENT_X
</atlarix-write>

Example for file with id of DYAD_ATTACHMENT_0:
<atlarix-write path="src/components/Button.jsx" description="Upload file to codebase">
DYAD_ATTACHMENT_0
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

          // --- DIAGRAM-FIRST CONTEXT SYSTEM ---
          // Instead of dumping full codebase, we provide:
          // 1. Diagram context (already in systemPrompt via getWorkspaceContext)
          // 2. Instructions to use file exploration tools on demand
          const codebasePrefix = isEngineEnabled
            ? // No codebase prefix if engine is set, we will take of it there.
            []
            : ([
              {
                role: "user",
                content: createDiagramFirstPrompt(hasInjectedArchitectureContext),
              },
              {
                role: "assistant",
                content: hasInjectedArchitectureContext
                  ? "Got it. I will use the provided architecture context as the map, then explore folders and read targeted files as needed."
                  : "Understood. I do not currently have a diagram/blueprint in context, so I will discover scope with explore_folder and then request get_blueprint_slice for the relevant paths.",
              },
            ] as const);

          // If engine is enabled, we will send the other apps codebase info to the engine
          // and process it with smart context.
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

          // Prune long tool outputs to prevent context bloat (OpenCode style)
          limitedMessageHistory = pruneToolOutputsInMessages(limitedMessageHistory);

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

          type HistoryMsg = { role: string; content?: string; sourceCommitHash?: string; commitHash?: string };
          let limitedHistoryChatMessages: ModelMessage[] = limitedMessageHistory.map((msg: HistoryMsg) => {
            const baseMsg: { role: "user" | "assistant" | "system"; content: string; providerOptions?: object } = {
              role: msg.role as "user" | "assistant" | "system",
              // Why remove thinking tags?
              // Thinking tags are generally not critical for the context
              // and eats up extra tokens.
              content:
                settings.selectedChatMode === "ask"
                  ? removeAtlarixTags(removeNonEssentialTags(msg.content ?? ""))
                  : removeNonEssentialTags(msg.content ?? ""),
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

          // Check if the last message should include attachments
          if (chatMessages.length >= 2 && attachmentPaths.length > 0) {
            const lastUserIndex = chatMessages.length - 2;
            const lastUserMessage = chatMessages[lastUserIndex];

            if (lastUserMessage.role === "user") {
              // Replace the last message with one that includes attachments
              chatMessages[lastUserIndex] = await prepareMessageWithAttachments(
                lastUserMessage,
                attachmentPaths,
              );
            }
          }

          if (isSummarizeIntent) {
            const previousChat = await db.query.chats.findFirst({
              where: eq(chats.id, parseInt(req.prompt.split("=")[1])),
              with: {
                messages: {
                  orderBy: (messages, { asc }) => [asc(messages.createdAt)],
                },
              },
            });
            chatMessages = [
              {
                role: "user",
                content:
                  "Summarize the following chat: " +
                  formatMessagesForSummary(previousChat?.messages ?? []),
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
            dyadDisableFiles = false,
            files,
          }: {
            chatMessages: ModelMessage[];
            modelClient: ModelClient;
            files: CodebaseFile[];
            tools?: ToolSet;
            systemPromptOverride?: string;
            dyadDisableFiles?: boolean;
          }) => {
            if (isEngineEnabled) {
              logger.log(
                "sending AI request to engine with request id:",
                dyadRequestId,
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
                dyadRequestId,
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

            // OpenRouter context compression fallback (balanced/thinking: Compass + BYOK).
            if (needsOpenRouterContextSafety(modelClient.builtinProviderId, contextBudgetTier)) {
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

            const maxOutputTokens = await getMaxTokensWithFloor(optionsModel);
            const temperature = await getTemperature(optionsModel);

            const streamResult = streamText({
              headers: isAnthropic
                ? {
                  "anthropic-beta": "context-1m-2025-08-07",
                }
                : undefined,
              maxOutputTokens,
              temperature,
              maxRetries: 2,
              model: modelClient.model,
              stopWhen: [() => false],
              providerOptions,
              system: systemPromptOverride,
              tools,
              messages: chatMessages.filter((m) => m.content),
              onFinish: (response) => {
                const rt = reasoningTokensFromAiUsage(response.usage);
                if (typeof rt === "number") {
                  maxReasoningTokensUsed = Math.max(maxReasoningTokensUsed ?? 0, rt);
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

                  // Persist the aggregated token usage on the placeholder assistant message
                  // Only for non-ephemeral chats
                  if (!isEphemeralWorkspace) {
                    void db
                      .update(messages)
                      .set({ maxTokensUsed: maxTokensUsed })
                      .where(eq(messages.id, placeholderAssistantMessage.id))
                      .catch((error) => {
                        logger.error(
                          "Failed to save total tokens for assistant message",
                          error,
                        );
                      });
                  }

                  logger.log(
                    `Total tokens used (aggregated for message ${placeholderAssistantMessage.id}): ${maxTokensUsed}`,
                  );

                  // Post-turn compaction (OpenCode style): compact proactively so next user message is instant
                  if (!isEphemeralWorkspace && req.chatId > 0 && typeof maxTokensUsed === "number") {
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
                      totalTokensUsed: maxTokensUsed,
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
                const modelNotFoundUserMessage = "The selected model was not found for any provider. Please choose a different model in Settings.";
                let errorMessage = (error as any)?.error?.message;
                const responseBody = error?.error?.responseBody;
                if (errorMessage && responseBody) {
                  errorMessage += "\n\nDetails: " + responseBody;
                }
                let message = errorMessage || JSON.stringify(error);
                if (modelClient.builtinProviderId === "compass") {
                  message = COMPASS_REACHABILITY_ERROR;
                } else if (isDiagramModelNotFoundError(error)) {
                  message = modelNotFoundUserMessage;
                }
                const requestIdPrefix = isEngineEnabled
                  ? `[Request ID: ${dyadRequestId}] `
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
          }): Promise<{
            bundle: SimpleStreamTextBundle;
            fullResponse: string;
            finishReason: Awaited<SimpleStreamTextBundle["finishReason"]>;
          }> {
            let fullResponse = params.fullResponse;
            for (let attempt = 1; attempt <= MAX_STREAM_EMPTY_OUTPUT_ATTEMPTS; attempt++) {
              const snapshot = fullResponse;
              try {
                const bundle = await params.runSimpleStream();
                const chunkResult = await processStreamChunks({
                  fullStream: bundle.fullStream,
                  fullResponse,
                  abortController: params.abortController,
                  chatId: params.chatId,
                  processResponseChunkUpdate: params.processResponseChunkUpdate,
                  onFirstModelActivity: params.onFirstModelActivity,
                });
                fullResponse = chunkResult.fullResponse;
                const finishReason = await bundle.finishReason;
                return { bundle, fullResponse, finishReason };
              } catch (err) {
                if (
                  isEmptyOutputStreamError(err) &&
                  attempt < MAX_STREAM_EMPTY_OUTPUT_ATTEMPTS &&
                  !params.abortController.signal.aborted
                ) {
                  logger.warn(
                    `[stream] Empty output on attempt ${attempt}/${MAX_STREAM_EMPTY_OUTPUT_ATTEMPTS}, retrying after ${STREAM_EMPTY_OUTPUT_RETRY_DELAY_MS}ms...`,
                  );
                  sentryAddBreadcrumbSafe({
                    category: "stream_retry",
                    message: `empty_output_retry attempt ${attempt}/${MAX_STREAM_EMPTY_OUTPUT_ATTEMPTS}`,
                    level: "warning",
                  });
                  fullResponse = snapshot;
                  await new Promise((r) =>
                    setTimeout(r, STREAM_EMPTY_OUTPUT_RETRY_DELAY_MS),
                  );
                  continue;
                }
                if (
                  isEmptyOutputStreamError(err) &&
                  !params.abortController.signal.aborted
                ) {
                  throw new EmptyModelOutputAfterRetryError();
                }
                throw err;
              }
            }
            throw new Error("runStreamRoundWithEmptyOutputRetry: unreachable");
          }

          let lastDbSaveAt = 0;

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
            // Save to DB (in case user is switching chats during the stream)
            // Only for non-ephemeral chats
            const now = Date.now();
            if (now - lastDbSaveAt >= 150 && !isEphemeralWorkspace) {
              await db
                .update(messages)
                .set({ content: fullResponse })
                .where(eq(messages.id, placeholderAssistantMessage.id));

              lastDbSaveAt = now;
            }

            // Update the placeholder assistant message content in the messages array
            const currentMessages = [...updatedChat.messages];
            if (
              currentMessages.length > 0 &&
              currentMessages[currentMessages.length - 1].role === "assistant"
            ) {
              currentMessages[currentMessages.length - 1].content = fullResponse;
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
              const { getEphemeralChat } = await import("./chat_only_handlers");
              const ec = getEphemeralChat(req.chatId);
              if (ec) {
                ec.messages = msgs;
              }
            } else {
              await db
                .update(messages)
                .set({ content: segmentA })
                .where(eq(messages.id, placeholderAssistantMessage.id));
              const exchangeIndex = updatedChat.messages.filter((m: any) => m.role === "assistant").length;
              const appPathForHash = chat.app?.path ?? appData?.path;
              const commitHash =
                appPathForHash != null
                  ? await getCurrentCommitHash({
                      path: resolveAppPath(appPathForHash),
                    })
                  : null;
              const [newPh] = await db
                .insert(messages)
                .values({
                  chatId: req.chatId,
                  role: "assistant",
                  content: "",
                  requestId: dyadRequestId,
                  sourceCommitHash: commitHash,
                  exchangeIndex,
                })
                .returning();
              placeholderAssistantMessage = newPh;
              askUserContinuationAssistantIdByChatId.set(req.chatId, newPh.id);
              const fetchedChat = await db.query.chats.findFirst({
                where: eq(chats.id, req.chatId),
                with: {
                  messages: {
                    orderBy: (messages, { asc: ascOrd }) => [ascOrd(messages.createdAt)],
                  },
                  app: true,
                },
              });
              if (fetchedChat) {
                updatedChat = fetchedChat;
              }
            }
            fullResponse = "";
            partialResponses.set(req.chatId, "");
            await processResponseChunkUpdate({ fullResponse: "" });
          };

          if (blueprintRequiredBlockMessage) {
            fullResponse = blueprintRequiredBlockMessage;
          } else if (settings.selectedChatMode === "agent") {
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
                  });
                  try {
                    const result = await runToolExecuteWithWorkforceSessionGate(
                      regName,
                      { ...args, _chatSessionId: req.chatId },
                      event.sender,
                      req.chatId,
                      buildToolStreamOpts(),
                    );
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

            // Merge global + workspace MCP tools for Agent mode
            const agentMcpTools = await getMcpTools(event, effectiveAppId ?? null, req.chatId);
            Object.assign(tools, agentMcpTools);

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
              const { bundle, fullResponse: agentRoundFull, finishReason: fr } =
                await runStreamRoundWithEmptyOutputRetry({
                  runSimpleStream: async () =>
                    simpleStreamText({
                      chatMessages: agentStreamMessages,
                      modelClient,
                      tools,
                      systemPromptOverride: constructSystemPrompt({
                        chatMode: "build",
                        contextSize: Math.min(await getContextWindow(), 128_000),
                        enableTurboEditsV2: false,
                      }),
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
                    lastContent: fullResponse,
                    ledgerState: getLedgerStateForContinuation(),
                  }),
                },
              ];
            }
            chatMessages.push({
              role: "assistant",
              content: fullResponse,
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
          if (!blueprintRequiredBlockMessage && settings.selectedChatMode === "ask" && effectiveApp) {
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

            const askToolStreamOpts = () => ({
              turnId: streamTurnIdForLedger,
              abortController,
              abortStreamOnLedgerComplete: false,
            });

            const askModeTools = ToolRegistry.getToolsForAskMode();
            const askLoader = getOrCreateToolSessionLoader(req.chatId);
            const askLoadedNames = askLoader.getLoadedToolNames();
            let askToolsToInclude = askModeTools.filter(
              (t) => askLoadedNames.has(t.name) || isCoreTool(t),
            );
            const modeAllowlist: Record<WorkMode, Set<string>> = {
              ask: new Set([
                "read_file",
                "explore_folder",
                "list_files",
                "search_code",
                "find_file",
                "get_diagram",
                "get_blueprint",
                "get_blueprint_slice",
                "compare_blueprint_to_live",
                "git_status",
                "git_diff",
                "git_log",
                "web_search",
                "deep_search",
                "read_url",
                "ask_user",
                "request_mode_change",
                "request_workspace_permissions",
                "get_project_history",
              ]),
              plan: new Set([
                "read_file",
                "explore_folder",
                "list_files",
                "search_code",
                "find_file",
                "get_blueprint",
                "get_blueprint_slice",
                "compare_blueprint_to_live",
                "get_plan_scope",
                "read_implementation_plan",
                "write_implementation_plan",
                "write_file",
                "get_project_history",
                "get_diagram",
                "ask_user",
                "request_mode_change",
              ]),
              build: new Set(),
              debug: new Set([
                "read_file",
                "explore_folder",
                "list_files",
                "search_code",
                "find_file",
                "get_blueprint",
                "get_blueprint_slice",
                "compare_blueprint_to_live",
                "git_status",
                "git_diff",
                "git_log",
                "ask_user",
                "request_mode_change",
              ]),
              review: new Set([
                "read_file",
                "explore_folder",
                "list_files",
                "search_code",
                "find_file",
                "get_blueprint",
                "get_blueprint_slice",
                "compare_blueprint_to_live",
                "git_status",
                "git_diff",
                "git_log",
                "get_project_history",
                "ask_user",
                "request_mode_change",
              ]),
            };
            // Register tools for any work mode the model can switch to mid-stream; gate at execute time.
            const reachableModeTools = new Set([
              ...modeAllowlist.ask,
              ...modeAllowlist.plan,
              ...modeAllowlist.debug,
              ...modeAllowlist.review,
              ...modeAllowlist.build,
            ]);
            askToolsToInclude = askToolsToInclude.filter((t) =>
              reachableModeTools.has(t.name),
            );
            const planWriteMeta = ToolRegistry.get("write_implementation_plan");
            if (
              planWriteMeta &&
              !askToolsToInclude.some((t) => t.name === "write_implementation_plan")
            ) {
              askToolsToInclude = [...askToolsToInclude, planWriteMeta];
            }
            for (const name of ["write_file", "get_plan_scope", "read_implementation_plan"] as const) {
              if (!modeAllowlist.plan.has(name)) continue;
              const meta = ToolRegistry.get(name);
              if (meta && !askToolsToInclude.some((t) => t.name === name)) {
                askToolsToInclude = [...askToolsToInclude, meta];
              }
            }
            const askManifest = generateManifest(askToolsToInclude, effectiveWorkMode !== "plan");

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
                  const askIsStream =
                    tool.name === "stream_terminal_output" ||
                    tool.name === "stream_pipeline_logs";
                  // Fix: Finding 4
                  if (!askIsStream) {
                    safeSend(event.sender, "chat:tool:start", {
                      chatId: req.chatId,
                      toolId: tool.name,
                      toolName: getToolActivityLabel(tool.name),
                    });
                  }
                  try {
                    const meta = ToolRegistry.get(tool.name);
                    const liveWorkMode: WorkMode =
                      readSettings().workModePreference ?? effectiveWorkMode;
                    const liveAllowedSet =
                      modeAllowlist[liveWorkMode] ?? modeAllowlist.ask;
                    const askAllowed =
                      tool.name === "request_mode_change" ||
                      liveAllowedSet.has(tool.name) ||
                      meta?.isReadOnly === true ||
                      meta?.allowInAskMode === true;
                    if (!askAllowed) {
                      return JSON.stringify({
                        success: false,
                        error: `${tool.name} is not available in ${liveWorkMode} mode. Call request_mode_change first.`,
                      });
                    }
                    const execArgs: any = {
                      ...args,
                      workspace: appPath,
                      workspaceId: effectiveAppId ?? undefined,
                      chatMode:
                        liveWorkMode === "plan"
                          ? "plan"
                          : liveWorkMode === "build"
                            ? "build"
                            : "ask",
                      _chatSessionId: req.chatId,
                    };
                    if (tool.name === "stream_terminal_output" || tool.name === "stream_pipeline_logs") {
                      execArgs.chatId = req.chatId;
                      execArgs._sendToolActivity = (label: string) => {
                        safeSend(event.sender, "chat:tool:start", {
                          chatId: req.chatId,
                          toolId: tool.name,
                          toolName: label,
                        });
                        return () => {
                          safeSend(event.sender, "chat:tool:end", { chatId: req.chatId });
                        };
                      };
                    }
                    const result = await runToolExecuteWithWorkforceSessionGate(
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

                    if (
                      result &&
                      typeof result === "object" &&
                      (result as any).__workspace_permissions_requested
                    ) {
                      const requestId = `workspace-permissions-${Date.now()}`;
                      const services = Array.isArray((result as any).services)
                        ? (result as any).services
                        : [];
                      safeSend(event.sender, "right-panel:set-intent", {
                        intent: "show-workspace-permissions",
                        context: {
                          chatId: req.chatId,
                          requestId,
                          services,
                          alreadyConnected: Array.isArray((result as any).alreadyConnected)
                            ? (result as any).alreadyConnected
                            : [],
                          message:
                            (result as any).message ??
                            "Connect required workforce services, then click Done to continue.",
                        },
                        timestamp: Date.now(),
                        source: "system",
                      });
                      const permissionResult = await waitForWorkspacePermissionResponse(
                        req.chatId,
                        requestId,
                      );
                      return JSON.stringify({
                        success: true,
                        dismissed: permissionResult.dismissed,
                        grantedServices: permissionResult.grantedServices,
                      });
                    }

                    if (
                      tool.name === "write_implementation_plan" &&
                      askPermissionInterceptor.isPermissionRequest(result)
                    ) {
                      const planPerm = askPermissionInterceptor.parsePermissionRequest(result);
                      if (planPerm) {
                        const planOpId = askPermissionInterceptor.generateOperationId();
                        askPermissionInterceptor.bufferOperation(planOpId, planPerm);
                        logger.log(
                          `[Plan tools] write_implementation_plan: executing without approval UI (${planOpId})`,
                        );
                        const planExec = await askPermissionInterceptor.executeOperation(planOpId);
                        if (!planExec.approved) {
                          return JSON.stringify({
                            success: false,
                            error: planExec.error ?? "Failed to write implementation plan",
                          });
                        }
                        const planResult = askPermissionInterceptor.getExecutionResult(planOpId);
                        const planPreview = planPerm.preview as { path?: string };
                        if (planPreview.path) {
                          filesWrittenInThisExchange.push(planPreview.path);
                        }
                        safeSend(event.sender, "chat:activity", {
                          id: `plan-saved-${Date.now()}`,
                          type: "tool",
                          label: "Plan saved",
                          status: "done",
                          timestamp: Date.now(),
                          detail: planResult.path ?? planPreview.path ?? ".atlarix/ATLARIX_PLAN.md",
                          chatId: req.chatId,
                        });
                        const ledgerForPlan = getLedger(streamTurnIdForLedger);
                        captureSafe("plan_written_ask_mode", {
                          step_count: ledgerForPlan?.steps.length ?? 0,
                          chat_id: req.chatId,
                          turn_id: streamTurnIdForLedger,
                        });
                        return JSON.stringify({
                          success: true,
                          message: `Wrote ${planPreview.path ?? ".atlarix/ATLARIX_PLAN.md"}`,
                          path: planResult.path,
                        });
                      }
                    }

                    if (askPermissionInterceptor.isPermissionRequest(result)) {
                      const permRequest = askPermissionInterceptor.parsePermissionRequest(result);
                      if (permRequest) {
                        const operationId = askPermissionInterceptor.generateOperationId();
                        const alwaysAutoAtlarix =
                          askPermissionInterceptor.shouldAlwaysAutoApprove(permRequest);
                        askPermissionInterceptor.bufferOperation(
                          operationId,
                          permRequest,
                          alwaysAutoAtlarix,
                        );

                        if (!alwaysAutoAtlarix) {
                          safeSend(event.sender, "permission-request", {
                            chatId: req.chatId,
                            operationId,
                            request: permRequest,
                          });

                          logger.log(`[Ask Mode] Permission request buffered: ${operationId}`);
                        } else {
                          logger.log(
                            `[Ask Mode] Auto-approved .atlarix internal write: ${operationId}`,
                          );
                        }

                        try {
                          let approved: boolean;
                          if (alwaysAutoAtlarix) {
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

                    return typeof result === "string" ? result : JSON.stringify(result);
                  } catch (error) {
                    return JSON.stringify({ success: false, error: String(error) });
                  } finally {
                    if (!askIsStream) {
                      safeSend(event.sender, "chat:tool:end", { chatId: req.chatId });
                    }
                  }
                },
              };
            }

            // request_mode_change: applied in main; renderer notified via mode:changed (no wait / no dialog)
            const requestModeChangeTool = ToolRegistry.get("request_mode_change");
            if (requestModeChangeTool) {
              askTools["request_mode_change"] = {
                description: requestModeChangeTool.description,
                inputSchema: normalizeToolInputSchemaForAiSdk(
                  requestModeChangeTool.parameters ?? {},
                ) as never,
                execute: async (args: any) => {
                  const execResult = await ToolRegistry.execute("request_mode_change", {
                    ...args,
                    hasWorkspace: true,
                    currentMode: "ask",
                    intentMode: settings.intentMode ?? "ask",
                    hasPendingPermissions: false,
                    chatId: req.chatId,
                  });
                  recordToolUseForTurn(streamTurnIdForLedger, "request_mode_change");
                  const inner = unwrapRegistryToolResult(execResult);
                  if (inner && typeof inner === "object" && (inner as any).__emit_mode_change_activity) {
                    const modeLabelMap: Record<string, string> = { ask: "Ask", plan: "Plan", build: "Build", debug: "Debug", review: "Review" };
                    const ml = modeLabelMap[String((inner as any).requestedMode)] ?? String((inner as any).requestedMode);
                    safeSend(event.sender, "chat:activity", {
                      id: `mode-change-${Date.now()}`,
                      type: "mode_change",
                      label: `Switched to ${ml} (Auto)`,
                      status: "done",
                      timestamp: Date.now(),
                      detail: (inner as any).reason,
                      chatId: req.chatId,
                    });
                  }
                  emitModeChangedIfApplied(event.sender, req.chatId, args?.mode, inner);
                  if (inner && typeof inner === "object" && (inner as any).success === false) {
                    return JSON.stringify(inner);
                  }
                  captureSafe("mode_switched_mid_stream", {
                    from_mode: "ask",
                    to_mode: String(args?.mode ?? ""),
                    chat_id: req.chatId,
                    workspace_id: effectiveAppId ?? null,
                    turn_id: streamTurnIdForLedger,
                  });
                  return JSON.stringify(
                    inner && typeof inner === "object" ? { success: true, ...(inner as object) } : { success: true },
                  );
                },
              };
            }

            // Merge global + workspace MCP tools so workspace chats can use MCP (e.g. GitHub)
            const askMcpTools = await getMcpTools(event, effectiveAppId!, req.chatId);
            Object.assign(askTools, askMcpTools);
            logger.log(
              `Ask tier: ${Object.keys(askTools).length} tools (read-only${effectiveWorkMode === "plan" ? " + Plan tools" : ""} + MCP)`,
            );

            const planModePrompt =
              effectiveWorkMode === "plan"
                ? `

## Plan mode (required)
You are in **Plan** mode (not Build). Call **get_plan_scope** when the workspace layout is ambiguous. Persist the implementation roadmap to **.atlarix/ATLARIX_PLAN.md** using **write_implementation_plan** (preferred) **or** **write_file** only for that path. Update **.atlarix/ATLARIX.md** with **write_file** when the user needs project instructions or memory updates. Read the current plan with **read_implementation_plan** before revising. Keep prose short after saving; the UI renders a structured Plan card—avoid duplicating the full plan in the visible reply. Suggest switching to **Build** only **after** the plan is done and the user wants implementation—not during mid-conversation clarification.
`
                : "";

            const askModePrompt = `
IMPORTANT: **Ask** work mode — **read-only exploration**. Answer questions and inspect the codebase with read-only tools. Do **not** create or update **.atlarix/ATLARIX_PLAN.md** here. For roadmaps, phased implementation plans, or structured plan files, ask the user to switch to **Plan** mode (or call **request_mode_change** toward **plan**). Do **not** suggest **Build** for ordinary Q&A.

Available tools (Ask — read-only):
- read_file, explore_folder, list_files, search_code, find_file
- web_search, deep_search, read_url
- get_diagram: Architecture diagrams
- get_blueprint_slice: Focused blueprint nodes/edges for selected folders/files
- git_status, git_diff
- recall_memory, search_memory
- get_file_outline, get_change_impact, diagnose_issue, health_check
- ask_user: Clarifications or choices — pass \`options\` as string array; do not fake widgets in prose only.
- request_workspace_permissions: Batch Token Auth (narrate first, then wait)
- request_mode_change: Instantly switch to **Plan**, **Build**, **Debug**, or **Review** when the user is ready (no confirmation).

NOT in Ask mode: write_file, write_implementation_plan, delete_file, rename_file, run_command, run_tests, save_learning.

For workforce, explain services before request_workspace_permissions.`;

            let askStreamMessages: ModelMessage[] = [...chatMessages];
            const askTierStreamLoopStartMs = Date.now();
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
                    systemPromptOverride:
                      constructSystemPrompt({
                        chatMode: "ask",
                        contextSize: Math.min(await getContextWindow(), 128_000),
                        enableTurboEditsV2: false,
                      }) +
                      askModePrompt +
                      planModePrompt +
                      "\n\n" +
                      askManifest,
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
                    lastContent: fullResponse,
                    ledgerState: getLedgerStateForContinuation(),
                  }),
                },
              ];
            }
          } else if (!blueprintRequiredBlockMessage) {
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
                  effectiveAppId,
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
            const buildLoadedNames = buildLoader.getLoadedToolNames();
            const buildToolsToInclude = buildModeToolsMetadata.filter(
              (t) => buildLoadedNames.has(t.name) || isCoreTool(t)
            );
            const buildManifest = generateManifest(buildModeToolsMetadata, false);
            const buildSystemPromptWithManifest = systemPrompt + "\n\n" + buildManifest;

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

            if (shouldAutoApprovePermissions(settings.agentMode, req.chatId)) {
              const { startOrchestratorForTurn } = await import("../../lib/agents/orchestrator");
              const { subscribeAgentBus } = await import("../../lib/agents/agent-bus");
              /** Sync only: bus subscription + correction map — no LLM / no await; must stay cheap. */
              const orchTurn = startOrchestratorForTurn({
                chatId: req.chatId,
                turnId: autonomousTurnId,
                emitBlockerActivity: (label, detail) => {
                  safeSend(event.sender, "chat:activity", {
                    id: `orch-${Date.now()}`,
                    type: "orchestrator_blocker",
                    label,
                    status: "done",
                    timestamp: Date.now(),
                    detail,
                    chatId: req.chatId,
                  });
                },
              });
              const stopCap = subscribeAgentBus((msg) => {
                if (msg.turnId !== autonomousTurnId) return;
                if (msg.chatId != null && msg.chatId !== req.chatId) return;
                appendAgentActivitySnapshot(req.chatId, autonomousTurnId, {
                  id: msg.id,
                  from: msg.from,
                  to: msg.to,
                  type: msg.type,
                  timestamp: msg.timestamp,
                  content: msg.content,
                  turnId: msg.turnId,
                  depth: msg.depth,
                  parentMessageId: msg.parentMessageId,
                  chatId: msg.chatId,
                  payload: msg.payload,
                });
              });
              stopAgentOrchestrator = () => {
                orchTurn.stop();
                stopCap();
              };
            }

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
                isPermissionBased: true, // Don't force-switch to terminal tab
              });
              logger.log(`[Build Mode] Terminal output sent: ${payload.command} (${payload.status})`);
            });

            const pendingMidTaskCounselInject = { value: null as string | null };
            let autonomousBuildToolStepCount = 0;
            let midTaskCounselCooldownUntil = 0;
            const MID_TASK_WRITE_GUARD_TOOLS = new Set([
              "write_file",
              "write_multiple_files",
              "run_command",
              "replace_code",
              "insert_code",
              "delete_lines",
            ]);
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
                  const toolActivityId = `tool-${toolName}-${Date.now()}`;
                  let activityStatus: "done" | "error" = "done";
                  const isStreamTool =
                    toolName === "stream_terminal_output" ||
                    toolName === "stream_pipeline_logs";
                  // Fix: Finding 4 — status line (stream tools use inner _sendToolActivity only)
                  const uiToolLabel = getToolActivityLabel(toolName);
                  if (!isStreamTool) {
                    safeSend(event.sender, "chat:tool:start", {
                      chatId: req.chatId,
                      toolId: toolName,
                      toolName: uiToolLabel,
                    });
                  }
                  safeSend(event.sender, "chat:activity", {
                    id: toolActivityId,
                    type: "tool_use",
                    label: getToolActivityLabel(toolName),
                    status: "running",
                    timestamp: Date.now(),
                    chatId: req.chatId,
                  });
                  try {
                    const effectivePath = workspaceOverride?.path ?? workspacePath ?? "";
                    const effectiveId = workspaceOverride?.id ?? effectiveAppId ?? undefined;
                    const executeArgs: any = {
                      ...args,
                      workspace: effectivePath || undefined,
                      workspaceId: effectiveId,
                      chatMode: "build",
                      _chatSessionId: req.chatId,
                    };
                    if (isStreamTool) {
                      executeArgs.chatId = req.chatId;
                      executeArgs._sendToolActivity = (label: string) => {
                        safeSend(event.sender, "chat:tool:start", {
                          chatId: req.chatId,
                          toolId: toolName,
                          toolName: label,
                        });
                        return () => {
                          safeSend(event.sender, "chat:tool:end", { chatId: req.chatId });
                        };
                      };
                    }
                    const result = await runToolExecuteWithWorkforceSessionGate(
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
                      result &&
                      typeof result === "object" &&
                      (result as any).__workspace_permissions_requested
                    ) {
                      const requestId = `workspace-permissions-${Date.now()}`;
                      const services = Array.isArray((result as any).services)
                        ? (result as any).services
                        : [];
                      safeSend(event.sender, "right-panel:set-intent", {
                        intent: "show-workspace-permissions",
                        context: {
                          chatId: req.chatId,
                          requestId,
                          services,
                          alreadyConnected: Array.isArray((result as any).alreadyConnected)
                            ? (result as any).alreadyConnected
                            : [],
                          message:
                            (result as any).message ??
                            "Connect required workforce services, then click Done to continue.",
                        },
                        timestamp: Date.now(),
                        source: "system",
                      });
                      const permissionResult = await waitForWorkspacePermissionResponse(
                        req.chatId,
                        requestId,
                      );
                      return JSON.stringify({
                        success: true,
                        dismissed: permissionResult.dismissed,
                        grantedServices: permissionResult.grantedServices,
                      });
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
                    const permRequest = permissionInterceptor.parsePermissionRequest(result);
                    if (permRequest) {
                      const operationId = permissionInterceptor.generateOperationId();
                      const skipPermissionWait =
                        shouldAutoApprovePermissions(settings.agentMode, req.chatId) ||
                        permissionInterceptor.shouldAlwaysAutoApprove(permRequest);
                      permissionInterceptor.bufferOperation(operationId, permRequest, skipPermissionWait);

                      const pushWrittenPaths = () => {
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
                        request: permRequest,
                      });

                      logger.log(`[Build Mode] Permission request buffered: ${operationId}`);

                      try {
                        // BLOCKING: Wait for user to approve or reject
                        const approved = await permissionInterceptor.waitForApproval(operationId);

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
                    if (
                      !isStreamTool &&
                      settings.agentMode === "autonomous" &&
                      settings.counsel?.enabled !== false
                    ) {
                      autonomousBuildToolStepCount++;
                      const nowMs = Date.now();
                      if (
                        autonomousBuildToolStepCount > 3 &&
                        nowMs > midTaskCounselCooldownUntil &&
                        activityStatus === "done"
                      ) {
                        const resultStr =
                          typeof result === "string"
                            ? result
                            : result == null
                              ? ""
                              : JSON.stringify(result);
                        const lower = resultStr.toLowerCase();
                        const ambiguous =
                          resultStr.trim().length < 20 ||
                          lower.includes("not found") ||
                          lower.includes("unclear") ||
                          lower.includes("ambiguous") ||
                          /"success"\s*:\s*false/.test(resultStr);
                        if (ambiguous) {
                          const recentWriteGuardHit = [...recentCompletedBuildToolNames]
                            .slice(-3)
                            .some((n) => MID_TASK_WRITE_GUARD_TOOLS.has(n));
                          if (!recentWriteGuardHit) {
                            midTaskCounselCooldownUntil = nowMs + 90_000;
                            captureSafe("counsel_triggered", {
                              trigger_type: "agent_blocker",
                              chat_mode: settings.selectedChatMode ?? "unknown",
                              has_workspace: Boolean(hasWorkspace && appPath),
                            });
                            const { runCounselPipeline } = await import("@/lib/counsel/counsel-runner");
                            const counselQ = [
                              "Mid-task decision needed: tool result looked ambiguous, empty, or weak.",
                              `Tool: ${toolName}`,
                              `Task prompt (excerpt): ${(userPrompt || req.prompt).slice(0, 4000)}`,
                              `Last tool result (excerpt): ${resultStr.slice(0, 3500)}`,
                            ].join("\n\n");
                            void runCounselPipeline({
                              chatId: req.chatId,
                              turnId: `${streamTurnIdForLedger}-mid-${nowMs}`,
                              trigger: "agent_blocker",
                              mode: hasWorkspace && appPath ? "workspace" : "general",
                              question: counselQ,
                              settings,
                              sendActivity: (payload) => {
                                safeSend(event.sender, "chat:activity", payload);
                              },
                              workspacePath: hasWorkspace && appPath ? appPath : undefined,
                              workspaceId: hasWorkspace ? (effectiveAppId ?? undefined) : undefined,
                              toolActivity: { webContents: event.sender, chatId: req.chatId },
                              onCounselStreamLifecycle: (phase) => {
                                safeSend(event.sender, "chat:stream:phase", {
                                  chatId: req.chatId,
                                  phase,
                                  label: phase === "counsel_start" ? "Consulting the counsel..." : "",
                                });
                              },
                            })
                              .then((block) => {
                                if (block.trim()) {
                                  pendingMidTaskCounselInject.value = block;
                                }
                              })
                              .catch((midCounselErr) => {
                                logger.warn("[counsel] Mid-task pipeline failed:", midCounselErr);
                                sentryCaptureExceptionSafe(midCounselErr, {
                                  tags: { feature: "counsel" },
                                });
                              });
                          }
                        }
                      }
                    }
                    if (agenticRepetition.isEnabled()) {
                      handleAgenticRepetitionOutcome(agenticRepetition.record(toolName, args));
                    }
                    recordBuildToolLedger(toolName, result);
                    return typeof result === "string" ? result : JSON.stringify(result);
                  } catch (err) {
                    activityStatus = "error";
                    throw err;
                  } finally {
                    if (
                      !isStreamTool &&
                      settings.agentMode === "autonomous" &&
                      settings.counsel?.enabled !== false
                    ) {
                      recentCompletedBuildToolNames.push(toolName);
                      while (recentCompletedBuildToolNames.length > 3) {
                        recentCompletedBuildToolNames.shift();
                      }
                    }
                    if (!isStreamTool) {
                      safeSend(event.sender, "chat:tool:end", { chatId: req.chatId });
                    }
                    safeSend(event.sender, "chat:activity", {
                      id: toolActivityId,
                      type: "tool_use",
                      label: getToolActivityLabel(toolName),
                      status: activityStatus,
                      timestamp: Date.now(),
                      chatId: req.chatId,
                    });
                  }
                },
              };
            }

            // Merge global + workspace MCP tools so workspace Build chats can use MCP (e.g. GitHub)
            const buildMcpTools = await getMcpTools(event, effectiveAppId ?? null, req.chatId);
            Object.assign(tools, buildMcpTools);

            // v2.1: Add delegate_to_agent when in Guided or Autonomous mode
            const agentMode = settings.agentMode ?? "guided";
            if (agentMode === "guided" || agentMode === "autonomous") {
              const delegateTool = ToolRegistry.get("delegate_to_agent");
              if (delegateTool) {
                tools["delegate_to_agent"] = {
                  description: delegateTool.description,
                  inputSchema: normalizeToolInputSchemaForAiSdk(
                    delegateTool.parameters ?? {},
                  ) as never,
                  execute: async (args: any) => {
                    // Fix: Finding 4
                    safeSend(event.sender, "chat:tool:start", {
                      chatId: req.chatId,
                      toolId: "delegate_to_agent",
                      toolName: getToolActivityLabel("delegate_to_agent"),
                    });
                    try {
                      const id = `delegation-${Date.now()}-${args.agent_id ?? "agent"}`;
                      const agentId = String(args.agent_id ?? "agent");
                      const task = String(args.task ?? "");
                      const startTime = Date.now();
                      const shortAgent =
                        agentId.length > 28 ? `${agentId.slice(0, 25)}…` : agentId;
                      let delegationLabel = `Delegation to ${shortAgent.replace(/^./, (c) => c.toUpperCase())}`;
                      if (delegationLabel.length > 60) {
                        delegationLabel = `${delegationLabel.slice(0, 57)}…`;
                      }
                      safeSend(event.sender, "chat:activity", {
                        type: "delegation_start",
                        id,
                        parentId: undefined,
                        depth: 0,
                        agent: agentId,
                        task,
                        status: "active",
                        timestamp: startTime,
                        label: delegationLabel,
                        chatId: req.chatId,
                      });
                      const delegationChatMode =
                        effectiveWorkMode === "plan"
                          ? ("plan" as const)
                          : effectiveWorkMode === "build"
                            ? ("build" as const)
                            : ("ask" as const);
                      const result = await ToolRegistry.execute("delegate_to_agent", {
                        ...args,
                        workspace: workspacePath || undefined,
                        workspaceId: effectiveAppId ?? undefined,
                        // Fix: Finding 3 — sub-agent tools respect parent work mode
                        delegationChatMode,
                        chatId: req.chatId,
                        depth: 0,
                        turnId: autonomousTurnId,
                        parentAgentRole: "main",
                      });
                      recordToolUseForTurn(streamTurnIdForLedger, "delegate_to_agent");
                      if (result?.success !== false) {
                        delegatedAgentsThisTurn.push(agentId);
                      }
                      const duration = Date.now() - startTime;
                      const isError = result?.success === false;
                      const validationInfo =
                        result && typeof result === "object" ? (result as any).validation : undefined;
                      safeSend(event.sender, "chat:activity", {
                        type: isError ? "delegation_error" : "delegation_complete",
                        id,
                        status: isError ? "error" : "done",
                        result: typeof result === "object" && result ? (result as any).summary : undefined,
                        duration,
                        timestamp: Date.now(),
                        label: delegationLabel,
                        detail: typeof result === "object" && (result as any).summary ? String((result as any).summary).slice(0, 200) : undefined,
                        chatId: req.chatId,
                      });
                      if (validationInfo?.status === "fallback" || validationInfo?.warning) {
                        safeSend(event.sender, "chat:activity", {
                          id: `structured-validation-${Date.now()}`,
                          type: "background",
                          label: `Structured output validation (${agentId})`,
                          status: validationInfo?.status === "fallback" ? "error" : "done",
                          timestamp: Date.now(),
                          detail:
                            validationInfo?.warning ||
                            `Schema ${validationInfo?.schema ?? "unknown"} validated in ${validationInfo?.attempts ?? 1} attempt(s).`,
                          chatId: req.chatId,
                        });
                      }
                      return typeof result === "string" ? result : JSON.stringify(result);
                    } finally {
                      safeSend(event.sender, "chat:tool:end", { chatId: req.chatId });
                    }
                  },
                };
              }
            }

            // request_mode_change: Build path — same instant apply + mode:changed notification
            const requestModeChangeToolBuild = ToolRegistry.get("request_mode_change");
            if (requestModeChangeToolBuild) {
              tools["request_mode_change"] = {
                description: requestModeChangeToolBuild.description,
                inputSchema: normalizeToolInputSchemaForAiSdk(
                  requestModeChangeToolBuild.parameters ?? {},
                ) as never,
                execute: async (args: any) => {
                  const hasPending =
                    permissionInterceptor.getAllOperationsCount() >
                    permissionInterceptor.getExecutedOperationsCount();
                  const execResult = await ToolRegistry.execute("request_mode_change", {
                    ...args,
                    hasWorkspace,
                    currentMode: "build",
                    intentMode: settings.intentMode ?? "build",
                    hasPendingPermissions: hasPending,
                    chatId: req.chatId,
                  });
                  recordToolUseForTurn(streamTurnIdForLedger, "request_mode_change");
                  const inner = unwrapRegistryToolResult(execResult);
                  if (inner && typeof inner === "object" && (inner as any).__emit_mode_change_activity) {
                    const modeLabelMap2: Record<string, string> = { ask: "Ask", plan: "Plan", build: "Build", debug: "Debug", review: "Review" };
                    const modeLabel = modeLabelMap2[String((inner as any).requestedMode)] ?? String((inner as any).requestedMode);
                    safeSend(event.sender, "chat:activity", {
                      id: `mode-change-${Date.now()}`,
                      type: "mode_change",
                      label: `Switched to ${modeLabel} (Auto)`,
                      status: "done",
                      timestamp: Date.now(),
                      detail: (inner as any).reason,
                      chatId: req.chatId,
                    });
                  }
                  emitModeChangedIfApplied(event.sender, req.chatId, args?.mode, inner);
                  if (typeof execResult === "string") return execResult;
                  if (inner && typeof inner === "object" && (inner as any).success === false) {
                    return JSON.stringify(inner);
                  }
                  captureSafe("mode_switched_mid_stream", {
                    from_mode: "build",
                    to_mode: String(args?.mode ?? ""),
                    chat_id: req.chatId,
                    workspace_id: effectiveAppId ?? null,
                    turn_id: streamTurnIdForLedger,
                  });
                  return JSON.stringify(
                    inner && typeof inner === "object" ? { success: true, ...(inner as object) } : { success: true },
                  );
                },
              };
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
                      /read_file|explore_folder|search_code|list_files|find_file|parse_url|read_url|get_/.test(
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
                          lastContent: fullResponse,
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
                const hasTextToolCalls = containsTextToolCall(fullResponse);

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

                // Check if task is explicitly complete
                if (isTaskComplete(fullResponse)) {
                  logger.info(`[Agentic Loop] Task completed at iteration ${agenticIteration + 1}`);
                  break;
                }

                // If no tool calls of any kind, end the loop
                if (!hasTextToolCalls && !hadNativeToolExecution) {
                  logger.log("[Agentic Loop] No tool calls detected (text-based or native), ending loop");
                  logger.log(`[Agentic Loop] Total tools executed: ${totalToolExecutions}`);
                  break;
                }

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
                        };
                        try {
                          const r = await runToolExecuteWithWorkforceSessionGate(
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
                        };
                        toolResult = await runToolExecuteWithWorkforceSessionGate(
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
                      const permRequest = permissionInterceptor.parsePermissionRequest(toolResult);
                      if (permRequest) {
                        const operationId = permissionInterceptor.generateOperationId();
                        const skipPermissionWait =
                          shouldAutoApprovePermissions(settings.agentMode, req.chatId) ||
                          permissionInterceptor.shouldAlwaysAutoApprove(permRequest);
                        permissionInterceptor.bufferOperation(operationId, permRequest, skipPermissionWait);
                        const pushAgenticWrittenPaths = () => {
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
                            request: permRequest,
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
                const counselBlock = pendingMidTaskCounselInject.value;
                pendingMidTaskCounselInject.value = null;
                const counselMid =
                  counselBlock != null && counselBlock.trim()
                    ? `\n\n## Counsel (mid-task perspectives)\n${counselBlock.trim()}\n`
                    : "";
                const toolResultsMessage =
                  counselMid +
                  iterationResults
                    .map(
                      (r) => `<tool_result tool="${r.tool}">\n${r.result}\n</tool_result>`,
                    )
                    .join("\n\n");

                // Add assistant's response to message history (strip text-tool XML for cleaner follow-up + UI)
                agenticMessages.push({
                  role: 'assistant' as const,
                  content: stripToolCallXML(fullResponse),
                });

                // Add tool results as a user message so AI can continue
                agenticMessages.push({
                  role: 'user' as const,
                  content: `Here are the results of the tools you called:\n\n${toolResultsMessage}\n\nPlease continue with your task based on these results.`,
                });

                const loopCorrection = agenticRepetition.takePendingCorrection();
                if (loopCorrection) {
                  agenticMessages.push({
                    role: "user" as const,
                    content: loopCorrection,
                  });
                }

                // Keep fullResponse for UI continuity - don't reset
                // (Conversation history already has the response)
                agenticIteration++;

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
                    if (!isEphemeralWorkspace) {
                      await db
                        .update(messages)
                        .set({
                          content: cancelledContent,
                        })
                        .where(eq(messages.id, placeholderAssistantMessage.id));

                      logger.log(
                        `Updated cancelled response for placeholder message ${placeholderAssistantMessage.id} in chat ${chatId}`,
                      );
                    } else {
                      const { addEphemeralMessage } = await import("./chat_only_handlers");
                      addEphemeralMessage(req.chatId, { role: "assistant", content: cancelledContent });
                      logger.log(`Persisted partial response to ephemeral chat ${chatId} after abort`);
                    }
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
          // v3.9: Parse and strip <questions> block; emit chat:questions if present (first block only)
          const {
            cleanContent: contentAfterQuestions,
            questions,
            title: questionsTitle,
          } = parseQuestions(fullResponse);
          let responseToStore = questions != null ? contentAfterQuestions : fullResponse;
          responseToStore = sanitizeAssistantOutput(responseToStore);
          if (questions != null && questions.length > 0) {
            safeSend(event.sender, "chat:questions", {
              messageId: placeholderAssistantMessage.id,
              questions,
              ...(questionsTitle ? { title: questionsTitle } : {}),
            });
          }

          // Scrape from: <atlarix-chat-summary>Renaming profile file</dyad-chat-title>
          const chatTitle = responseToStore.match(
            /<atlarix-chat-summary>(.*?)<\/atlarix-chat-summary>/,
          );
          if (chatTitle) {
            await db
              .update(chats)
              .set({ title: chatTitle[1] })
              .where(and(eq(chats.id, req.chatId), isNull(chats.title)));
          }
          const chatSummary = chatTitle?.[1];

          // Update the placeholder assistant message with the full response (with <questions> stripped if present)
          // v3.9: Also set snapshotId and filesWritten when from Build mode
          if (!isEphemeralWorkspace) {
            await db
              .update(messages)
              .set({
                content: responseToStore,
                ...(preExchangeSnapshotId != null && { snapshotId: preExchangeSnapshotId }),
                ...(filesWrittenInThisExchange.length > 0 && { filesWritten: filesWrittenInThisExchange }),
                ...(autoRoutedTierForTurn != null && { autoRoutedTier: autoRoutedTierForTurn }),
              })
              .where(eq(messages.id, placeholderAssistantMessage.id));
          } else {
            // For ephemeral workspace chats, save to in-memory store
            const { addEphemeralMessage } = await import("./chat_only_handlers");
            addEphemeralMessage(req.chatId, {
              role: "assistant",
              content: responseToStore,
              ...(autoRoutedTierForTurn != null && { autoRoutedTier: autoRoutedTierForTurn }),
            });
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
            sessionMemory.addExchange(userPrompt, cleanResponse);
            logger.log(`Recorded exchange in session memory (now ${sessionMemory.getExchangeCount()} exchanges)`);
          } catch (error) {
            logger.warn("Failed to record session memory exchange:", error);
          }
          let dyadProcessedFileWrites = false;
          const settings = readSettings();
          const isBuildModeTurn =
            settings.selectedChatMode === "agent" || settings.selectedChatMode === "build";
          if (
            settings.autoApproveChanges &&
            settings.selectedChatMode !== "ask"
          ) {
            const status = await processFullResponseActions(
              responseToStore,
              req.chatId,
              {
                chatSummary,
                messageId: placeholderAssistantMessage.id,
              }, // Use placeholder ID
            );

            const chat = await db.query.chats.findFirst({
              where: eq(chats.id, req.chatId),
              with: {
                messages: {
                  orderBy: (messages, { asc }) => [asc(messages.createdAt)],
                },
              },
            });

            safeSend(event.sender, "chat:response:chunk", {
              chatId: req.chatId,
              messages: chat!.messages,
            });

            if (status.error) {
              safeSend(event.sender, "chat:response:error", {
                chatId: req.chatId,
                error: `Sorry, there was an error applying the AI's changes: ${status.error}`,
              });
            }

            dyadProcessedFileWrites = status.updatedFiles ?? false;

            const newReviewSystemActive =
              settings.agentMode === "autonomous" ||
              streamStopWasTaskComplete ||
              delegatedAgentsThisTurn.includes("reviewer");

            // v2.1: Self-review activity (runtime stub - show in Activity Stream when enabled)
            const selfReview = settings.aiConfiguration?.selfReview;
            if (
              !newReviewSystemActive &&
              selfReview?.enabled &&
              (selfReview.strategy === "runtime" || selfReview.strategy === "both") &&
              selfReview.showInActivityStream
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
                detail: `Score: ${(selfReview.qualityThreshold ?? 0.85).toFixed(2)} (threshold met)`,
                chatId: req.chatId,
              });
            }

            // v2.1: Turn summary in Activity Stream (token count when available)
            if (maxTokensUsed != null) {
              safeSend(event.sender, "chat:activity", {
                id: `turn-summary-${req.chatId}-${Date.now()}`,
                type: "turn_summary",
                label: "Turn total",
                status: "done",
                timestamp: Date.now(),
                tokens: maxTokensUsed,
                chatId: req.chatId,
              });
            }

            // v2.1: Agent Lightning trace collection (when enabled)
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
              (dyadProcessedFileWrites || filesWrittenInThisExchange.length > 0)
            ) {
              const { recordBuildCompleteSnapshot } = await import("@/lib/project-memory/service");
              void recordBuildCompleteSnapshot(
                effectiveAppId,
                appPath,
                userPrompt?.slice(0, 500),
              );
            }

            if (
              settings.agentMode === "autonomous" &&
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

            // Signal that the stream has completed
            markLedgerStreamComplete(streamTurnIdForLedger);
            notifyPlanUiForTurnIfPresent(streamTurnIdForLedger);
            {
              const finalLedger = getLedger(streamTurnIdForLedger);
              if (
                finalLedger &&
                isLedgerTaskComplete(finalLedger) &&
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
            safeSend(event.sender, "chat:response:end", {
              chatId: req.chatId,
              updatedFiles: status.updatedFiles ?? false,
              extraFiles: status.extraFiles,
              extraFilesError: status.extraFilesError,
              hadToolCallsOrPermissions: status.updatedFiles ?? (status.extraFiles?.length ? true : false),
              usedCompass: usedCompassThisStream,
              compassTier: compassStreamTier,
              compassTokens: compassStreamTokens,
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
          } else {
            const newReviewSystemActiveElse =
              settings.agentMode === "autonomous" ||
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
            if (
              settings.agentMode === "autonomous" &&
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
            safeSend(event.sender, "chat:response:end", {
              chatId: req.chatId,
              updatedFiles: false,
              hadToolCallsOrPermissions,
              usedCompass: usedCompassThisStream,
              compassTier: compassStreamTier,
              compassTokens: compassStreamTokens,
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
          FileUploadsState.getInstance().clear(req.chatId);
          return;
        }
        const errMessage = isDiagramModelNotFoundError(error)
          ? "The selected model was not found for any provider. Please choose a different model in Settings."
          : isNoUsableModelOutputError(error)
            ? AI_STREAM_EMPTY_RESPONSE_FALLBACK
            : `Sorry, there was an error processing your request: ${error instanceof Error ? error.message : String(error)}`;
        safeSend(event.sender, "chat:response:error", {
          chatId: req.chatId,
          error: errMessage,
        });
        activeStreams.delete(req.chatId);
        FileUploadsState.getInstance().clear(req.chatId);
      } finally {
        stopAgentOrchestrator?.();
        unregisterLedgerPlanUiNotifier(req.chatId);
      }
    };

    void runStream();
    return undefined; // Reply immediately so renderer does not get "reply was never sent"
  });

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

  // v3.9: Submit clarifying-question answers — formatted user bubble + chunk flush
  ipcMain.handle(
    "chat:submit-question-answers",
    async (
      event,
      payload: {
        chatId: number;
        assistantMessageId: number;
        answers: Record<string, string>;
        questionSnapshots: { id: string; question: string }[];
      },
    ) => {
      const { chatId, assistantMessageId, answers, questionSnapshots } = payload;
      const { formatInteractiveQaBlock } = await import("../../lib/interactive-qa-format");
      const {
        isEphemeralChatId,
        insertClarifyingAnswersUserMessageEphemeral,
        getEphemeralChat,
      } = await import("./chat_only_handlers");

      const pairs = questionSnapshots.map((q) => ({
        question: q.question,
        answer: answers[q.id] ?? "",
      }));
      const content = formatInteractiveQaBlock(pairs);

      if (isEphemeralChatId(chatId)) {
        const ok = insertClarifyingAnswersUserMessageEphemeral(chatId, assistantMessageId, content);
        if (!ok) throw new Error("Assistant message not found in ephemeral chat");
        const chat = getEphemeralChat(chatId);
        safeSend(event.sender, "chat:response:chunk", {
          chatId,
          messages: [...(chat?.messages ?? [])],
        });
        return { success: true };
      }

      const assistantMsg = await db.query.messages.findFirst({
        where: and(eq(messages.id, assistantMessageId), eq(messages.chatId, chatId)),
      });
      if (!assistantMsg) {
        throw new Error("Assistant message not found");
      }

      let insertCreatedAt = new Date();
      if (assistantMsg.createdAt) {
        insertCreatedAt = new Date(assistantMsg.createdAt.getTime() + 1);
      }

      await db.insert(messages).values({
        chatId,
        role: "user",
        content,
        createdAt: insertCreatedAt,
      });
      await db.update(chats).set({ hasAnsweredQuestions: true }).where(eq(chats.id, chatId));

      const rowsAfter = await db
        .select()
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(asc(messages.createdAt));

      safeSend(event.sender, "chat:response:chunk", {
        chatId,
        messages: rowsAfter.map((row) => ({
          id: row.id,
          chatId: row.chatId,
          role: row.role as "user" | "assistant" | "system",
          content: row.content ?? "",
          createdAt: row.createdAt ?? new Date(),
        })) as import("../ipc_types").Message[],
      });

      return { success: true };
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
      const msg = await db.query.messages.findFirst({
        where: and(eq(messages.id, userMessageId), eq(messages.chatId, chatId)),
      });
      if (!msg || msg.role !== "user") {
        throw new Error("User message not found");
      }
      const chatMessages = await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(messages.createdAt);
      const idx = chatMessages.findIndex((m) => m.id === userMessageId);
      if (idx < 0) throw new Error("Message not in chat");
      const idsToDelete = chatMessages.slice(idx + 1).map((m) => m.id);
      if (idsToDelete.length > 0) {
        await db.delete(messages).where(inArray(messages.id, idsToDelete));
      }
      await db.update(messages).set({ content: newContent }).where(eq(messages.id, userMessageId));
      await db.update(chats).set({ hasAnsweredQuestions: false }).where(eq(chats.id, chatId));
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
      const manifestPath = path.join(
        atlasDir(workspacePath),
        "snapshots",
        String(turnId),
        "manifest.json",
      );
      try {
        await access(manifestPath);
        return true;
      } catch {
        return false;
      }
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
      const msg = await db.query.messages.findFirst({
        where: and(eq(messages.id, assistantMessageId), eq(messages.chatId, chatId)),
      });
      if (!msg || msg.role !== "assistant") {
        throw new Error("Assistant message not found");
      }
      const [chatRow] = await db.select().from(chats).where(eq(chats.id, chatId));
      const appId = chatRow?.appId ?? null;
      const turnId = String(assistantMessageId);
      if (appId != null) {
        const [app] = await db.select().from(apps).where(eq(apps.id, appId));
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
      const chatMessages = await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(asc(messages.createdAt));
      const idx = chatMessages.findIndex((m) => m.id === assistantMessageId);
      if (idx < 0) throw new Error("Message not in chat");
      const idsToMark = chatMessages.slice(idx).map((m) => m.id);
      await db.update(messages).set({ isReverted: false }).where(eq(messages.chatId, chatId));
      if (idsToMark.length > 0) {
        await db.update(messages).set({ isReverted: true }).where(inArray(messages.id, idsToMark));
      }
      await db.update(chats).set({ hasAnsweredQuestions: false }).where(eq(chats.id, chatId));
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
      const chatRow = await db.query.chats.findFirst({
        where: eq(chats.id, payload.chatId),
        with: { app: true },
      });
      if (!chatRow?.app?.path) {
        return { success: false, error: "Chat has no workspace" };
      }
      const workspacePath = resolveAppPath(chatRow.app.path);
      const workspaceId = chatRow.app.id;
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
      const msg = await db.query.messages.findFirst({
        where: and(
          eq(messages.id, assistantMessageId),
          eq(messages.chatId, chatId),
        ),
      });
      if (!msg || msg.role !== "assistant") {
        return {
          success: false,
          error: "Assistant message not found for this chat and turnId",
        };
      }
      const chatRow = await db.query.chats.findFirst({
        where: eq(chats.id, chatId),
        with: { app: true },
      });
      if (!chatRow?.app?.path) {
        return { success: false, error: "No workspace attached" };
      }
      const workspacePath = resolveAppPath(chatRow.app.path);
      const workspaceId = chatRow.app.id;
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

// Helper function to replace text attachment placeholders with full content
async function replaceTextAttachmentWithContent(
  text: string,
  filePath: string,
  fileName: string,
): Promise<string> {
  try {
    if (await isTextFile(filePath)) {
      // Read the full content
      const fullContent = await readFile(filePath, "utf-8");

      // Replace the placeholder tag with the full content
      const escapedPath = filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const tagPattern = new RegExp(
        `<atlarix-text-attachment filename="[^"]*" type="[^"]*" path="${escapedPath}">\\s*<\\/atlarix-text-attachment>`,
        "g",
      );

      const replacedText = text.replace(
        tagPattern,
        `Full content of ${fileName}:\n\`\`\`\n${fullContent}\n\`\`\``,
      );

      logger.log(
        `Replaced text attachment content for: ${fileName} - length before: ${text.length} - length after: ${replacedText.length}`,
      );
      return replacedText;
    }
    return text;
  } catch (error) {
    logger.error(`Error processing text file: ${error}`);
    return text;
  }
}

// Helper function to convert traditional message to one with proper image attachments
async function prepareMessageWithAttachments(
  message: ModelMessage,
  attachmentPaths: string[],
): Promise<ModelMessage> {
  let textContent = message.content;
  // Get the original text content
  if (typeof textContent !== "string") {
    logger.warn(
      "Message content is not a string - shouldn't happen but using message as-is",
    );
    return message;
  }

  // Process text file attachments - replace placeholder tags with full content
  for (const filePath of attachmentPaths) {
    const fileName = path.basename(filePath);
    textContent = await replaceTextAttachmentWithContent(
      textContent,
      filePath,
      fileName,
    );
  }

  // For user messages with attachments, create a content array
  const contentParts: (TextPart | ImagePart)[] = [];

  // Add the text part first with possibly modified content
  contentParts.push({
    type: "text",
    text: textContent,
  });

  // Add image parts for any image attachments
  for (const filePath of attachmentPaths) {
    const ext = path.extname(filePath).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
      try {
        // Read the file as a buffer
        const imageBuffer = await readFile(filePath);

        // Add the image to the content parts
        contentParts.push({
          type: "image",
          image: imageBuffer,
        });

        logger.log(`Added image attachment: ${filePath}`);
      } catch (error) {
        logger.error(`Error reading image file: ${error}`);
      }
    }
  }

  // Return the message with the content array
  return {
    role: "user",
    content: contentParts,
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
  const dyadRegex = /<dyad-[^>]*>[\s\S]*?<\/dyad-[^>]*>/g;
  return text.replace(dyadRegex, "").trim();
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

const CODEBASE_PROMPT_PREFIX = "This is my codebase.";
/** @deprecated Use createDiagramFirstPrompt instead - this dumps full codebase */
function createCodebasePrompt(codebaseInfo: string): string {
  return `${CODEBASE_PROMPT_PREFIX} ${codebaseInfo}`;
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
3. Deep-dive only relevant code and blueprint slices

## Recommended tool sequence
- **explore_folder**: inspect directory contents first
- **list_files** / **find_file**: refine scope
- **get_blueprint_slice**: pull focused architecture for chosen paths
- **read_file**: read exact files needed for implementation
- **search_code**: locate symbols/usages
`;
  }
  return `# Workspace Context

You currently do not have project Diagram/Blueprint context in this turn.

Your first actions should be:
1. Use **explore_folder** to discover relevant folders/files.
2. Use **get_blueprint_slice** for the selected paths to obtain focused architecture context.
3. Use **read_file** only after narrowing to the exact files.

Do not claim a diagram is present until architecture context is actually provided.
`;
}

function createOtherAppsCodebasePrompt(otherAppsCodebaseInfo: string): string {
  return `
# Referenced Apps

These are the other apps that I've mentioned in my prompt. These other apps' codebases are READ-ONLY.

${otherAppsCodebaseInfo}
`;
}

const PERMISSIVE_TOOL_JSON_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {},
  additionalProperties: true,
};

/**
 * Wire tool schemas for `streamText` tools. ToolRegistry uses Zod; MCP uses JSON Schema.
 * - Pass Zod through `zodSchema()` so the provider gets real parameter shapes (not empty `{}`).
 * - Pass JSON-Schema-shaped objects through `aiJsonSchema()`.
 * - If a Zod schema hits an AI SDK conversion bug, fall back to permissive schema for that tool only.
 */
function normalizeToolInputSchemaForAiSdk(schema: unknown) {
  if (!schema || typeof schema !== "object") {
    return aiJsonSchema(PERMISSIVE_TOOL_JSON_SCHEMA);
  }
  const obj = schema as Record<string, unknown>;
  if ("_def" in obj) {
    try {
      return zodSchema(
        obj as unknown as Parameters<typeof zodSchema>[0],
        { useReferences: true },
      );
    } catch (e) {
      logger.warn(
        "Tool input Zod schema could not be wrapped for AI SDK; using permissive schema:",
        e,
      );
      return aiJsonSchema(PERMISSIVE_TOOL_JSON_SCHEMA);
    }
  }
  if ("type" in obj || "$schema" in obj) {
    return aiJsonSchema(obj as JSONSchema7);
  }
  if ("jsonSchema" in obj && obj.jsonSchema && typeof obj.jsonSchema === "object") {
    return aiJsonSchema(obj.jsonSchema as JSONSchema7);
  }
  return aiJsonSchema(PERMISSIVE_TOOL_JSON_SCHEMA);
}

/** When appId is null/undefined, only global MCPs; when set, global + that workspace's MCPs (same as list-servers). */
async function getMcpTools(
  event: IpcMainInvokeEvent,
  appId?: number | null,
  /** Fix: Finding 4 — when set, emit chat:tool:start/end around MCP execution */
  chatIdForToolIndicator?: number | null
): Promise<ToolSet> {
  const mcpToolSet: ToolSet = {};
  try {
    const enabled = eq(mcpServers.enabled, true as any);
    const servers = await db
      .select()
      .from(mcpServers)
      .where(
        appId != null
          ? and(
              enabled,
              or(
                eq(mcpServers.scope, "global"),
                and(
                  eq(mcpServers.scope, "workspace"),
                  eq(mcpServers.appId, appId)
                )
              )
            )
          : and(enabled, eq(mcpServers.scope, "global"))
      );
    for (const s of servers) {
      const client = await mcpManager.getClient(s.id);
      const toolSet = await client.tools();
      for (const [name, tool] of Object.entries(toolSet)) {
        const key = `${String(s.name || "").replace(/[^a-zA-Z0-9_-]/g, "-")}__${String(name).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
        const original = tool as { description?: string; inputSchema?: unknown; execute?: (args: unknown, ctx?: unknown) => Promise<unknown> };
        mcpToolSet[key] = {
          description: original?.description,
          inputSchema: normalizeToolInputSchemaForAiSdk(original?.inputSchema) as never,
          execute: async (args: any, execCtx: any) => {
            const cid = chatIdForToolIndicator;
            if (cid != null) {
              safeSend(event.sender, "chat:tool:start", {
                chatId: cid,
                toolId: key,
                toolName: getToolActivityLabel(key),
              });
            }
            try {
              const inputPreview =
                typeof args === "string"
                  ? args
                  : Array.isArray(args)
                    ? args.join(" ")
                    : JSON.stringify(args).slice(0, 500);
              const ok = await requireMcpToolConsent(event, {
                serverId: s.id,
                serverName: s.name,
                toolName: name,
                toolDescription: original?.description,
                inputPreview,
              });

              if (!ok) throw new Error(`User declined running tool ${key}`);
              const res = await (original as { execute?: (a: unknown, c?: unknown) => Promise<unknown> }).execute?.(args, execCtx);

              return typeof res === "string" ? res : JSON.stringify(res);
            } finally {
              if (cid != null) {
                safeSend(event.sender, "chat:tool:end", { chatId: cid });
              }
            }
          },
        };
      }
    }
  } catch (e) {
    logMcpError("Failed building MCP toolset", e);
  }
  return mcpToolSet;
}
