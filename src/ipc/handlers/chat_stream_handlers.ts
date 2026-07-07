import { v4 as uuidv4 } from "uuid";
import { ipcMain } from "electron";
import {
  ModelMessage,
  ToolSet,
  jsonSchema as aiJsonSchema,
} from "ai";

import { db } from "../../db";
import { apps } from "../../db/schema";
import { eq } from "drizzle-orm";
import type { WorkMode } from "../../lib/schemas";
import {
  constructSystemPrompt,
  constructSystemPromptParts,
  buildSystemPromptWithProjectInstructions,
  type ModeSystemKey,
} from "../../prompts/system_prompt";
import { getActiveModeReanchor } from "@/lib/tools/mode-prompt-bundle";
import {
  buildToolModelOutput,
  redactToolMediaForDisplay,
  extractImageMedia,
} from "@/lib/ai/tool-model-output";
import { detectVisionCapability } from "@/lib/routing/model-capability-profile";
import {
  hasNativeToolParts,
  serializeNativeHistory,
  parseNativeHistory,
  isNativeHistoryEnvelope,
  regateNativeMediaForProvider,
} from "@/lib/ai/native-history";
import { runAgentTurn } from "@/lib/agent/run-agent-turn";
import { simplifyToolParametersForProfile } from "@/lib/routing/model-capability-profile";
import { resolveToolsetForSession } from "@/lib/tools/resolve-toolset";
import {
  runStopHooks,
  hasStopHooks,
} from "@/lib/hooks/file-hooks";
import { renderUserAgentSystemBlock } from "@/lib/agents/user-agents";
import {
  estimateTurnCostUsd,
} from "@/lib/routing/byok-pricing";
import { finalizeReels, setReelTurnContext } from "../utils/browser-reel";
import { PreflightTimer } from "@/lib/agent/preflight-timing";
import { buildAttachmentRecord } from "@/lib/attachment-upload";
import { resolveAppPath } from "../../paths/paths";
import { readSettings } from "../../main/settings";
import type { ChatContextReport, ChatResponseEnd, ChatStreamParams } from "../ipc_types";
import { streamTestResponse } from "./testing_chat_handlers";
import { getTestResponse } from "./testing_chat_handlers";
import { getModelClient, getEffectiveModel, getEffectiveModelForOptions, type GetModelClientOptions } from "../utils/get_model_client";
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
} from "../../lib/auth/compass_usage";
import {
  COMPASS_LIMIT_STREAM_STOP,
} from "../../lib/auth/compass_enforcement";
import {
  ASK_USER_STREAM_STOP,
  LOOP_REPETITION_STREAM_STOP,
  FORCE_TEXT_FINISH_STREAM_STOP,
  SUPERSEDED_STREAM_STOP,
  abortReasonSentinel,
  streamStopAbortReason,
} from "../../lib/stream/stream-stop-sentinels";
import {
  compassExhaustedUserMessage,
} from "../shared/compass_constants";
import log from "electron-log";
import fs from "node:fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { readFile, writeFile, unlink } from "fs/promises";
import { MAX_CHAT_TURNS_IN_CONTEXT } from "@/constants/settings_constants";


import { safeSend } from "../utils/safe_sender";
import { normalizeToolInputSchemaForAiSdk, sanitizeJsonSchemaForProvider } from "@/lib/ai/normalize-tool-schema";
import { stripHallucinatedAtlarixToolTagsFromDelta } from "@/lib/chat/answer-display";
import {
  getStreamTransport,
  buildContinueAfterQuestionsPrompt,
  nextEphemeralMessageId,
} from "@/lib/chat/stream-transport";
import { shouldUseTextToolFallback } from "@/lib/stream/text-tool-fallback";
import { isStreamDebugLoggingEnabled } from "@/lib/stream/stream-debug";
import { stripQuestionsBlockFromResponse } from "../utils/cleanFullResponse";
import {
  stripThinkBlocks,
} from "../utils/thinking_tags";
// Pure post-processing helpers (extracted). Imported for internal use AND
// re-exported so the public API (consumers importing these from this file) is
// preserved unchanged.
import {
  formatMessagesForSummary,
  prepareMessageWithAttachments,
  removeNonEssentialTags,
  removeProblemReportTags,
  removeAtlarixTags,
  hasUnclosedAtlarixWrite,
  removeThinkingTags,
} from "./chat_stream/message-postprocess";
export {
  formatMessagesForSummary,
  prepareMessageWithAttachments,
  removeProblemReportTags,
  removeAtlarixTags,
  hasUnclosedAtlarixWrite,
  removeThinkingTags,
};
import { FileUploadsState } from "../utils/file_uploads_state";
import { extractMentionedContext } from "../utils/mention_apps";
import { parseContextMentions } from "@/shared/parse_mention_apps";

import { isTurboEditsV2Enabled } from "@/lib/schemas";
import { trackPendingWork } from "@/lib/pending-work";
import {
  takePendingBackgroundCommandResults,
  listBackgroundJobs,
} from "@/lib/agent/background-commands";
import {
  takePendingSubagentResults,
  runningSubagentCount,
} from "@/lib/agents/subagent-results";
import {
  computeWakePendingResults,
} from "@/lib/agent/collect-results";
import {
  AI_STREAMING_ERROR_MESSAGE_PREFIX,
  AI_STREAM_EMPTY_RESPONSE_FALLBACK,
  SAFETY_FILTER_BLOCKED_MESSAGE,
  modelFailureUserMessage,
} from "@/shared/texts";
import {
  EmptyModelOutputAfterRetryError,
  isNoUsableModelOutputError,
  MODEL_EMPTY_RESPONSE_USER_MESSAGE,
} from "../utils/no_usable_model_output";
import {
  prepareUserChatTurnInput,
  ChatPromptSafetyError,
} from "../../lib/security/chat-prompt-gate";
import { sanitizeAssistantOutput } from "../../lib/security/profanity-filter";
import {
  detectReasoningCapability,
  resolveReasoningCatalogModelId,
  hasNativeDeepThinkingSupport,
} from "@/lib/routing/reasoning-detector";
import { enforceContextBudget } from "@/lib/routing/tier_context_budget";
import { feedTerminalOutput } from "../../lib/streams/StreamManager";
import { ToolRegistry } from "../../lib/tools";
import { AttachmentStore } from "../../lib/attachment-store";
import {
  buildPasteAttachmentDirective,
  ensurePasteAttachmentIds,
  pasteToAttachmentData,
} from "../../lib/attachment-persistence";
import type { StoredFileAttachment } from "../ipc_types";
import { getModeToolAllowSets } from "../../lib/tools/mode-tool-registry";
import { toolExecutionChatMode } from "../../lib/work-mode";
import {
  createAgenticRepetitionState,
  buildLoopCorrectionMessage,
  type AgenticRepetitionOutcome,
} from "../../lib/streaming/agentic-loop-repetition";
import {
  createLedger,
  getLedger,
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
import { getPlanCompletionFeedback } from "@/lib/tasks/plan-completion-gate";
import { emitPlanUpdate } from "@/ipc/utils/emit_plan_update";
import {
  clearMutationOutcomes,
  recordUnverifiedEdit,
  clearUnverifiedEdit,
} from "@/lib/agent/mutation-verify";
import { type ContextSection } from "@/lib/context/ContextAssembler";
import { ContextBudgetTracker } from "@/lib/context/context-budget-tracker";
import { pruneContextSectionsForBudget } from "@/lib/context/context-budget-pruning";
import { resolveModelContextLimit } from "@/lib/context/resolve-model-context-limit";
import { estimateDispatchTokens } from "@/lib/routing/tier_context_budget";
// Pass 7: loadInstalledSkillsForSession is now reached through the get_active_skills tool.
import {
  requireAuthSession,
  formatAuthRequiredIpcError,
  AuthRequiredError,
} from "../../lib/auth/require_auth_session";
import { PermissionInterceptor } from "./permissions/interceptor";
import {
  registerInterceptor,
} from "./permissions/handlers";
import {
  appendAutonomousOp,
  autonomousOpFromPermissionExec,
  getAutonomousSessionLog,
  getAgentActivityForTurn,
} from "./autonomous-session-state";
import {
  estimateTokens,
  getContextWindow,
  getContextWindowDetailed,
  setCompassContextWindow,
} from "../utils/token_utils";
import {
  resolveEffectiveWorkMode,
} from "../../lib/work-mode";
import { computeDiffHunks } from "@/lib/diff/compose-hunks";
import { attachDelegationToolsToSet } from "../../lib/agents/register-delegation-tools";
import { shouldAutoApprovePermissions } from "../../lib/agents/agent-runtime";
import { getToolActivityLabel } from "../../lib/tool-activity-labels";
import { summarizeToolResultForActivityDetail, toolResultTextForExpand } from "@/lib/chat/stream-tool-display";
import { captureSafe } from "../../main/lib/analytics";
import {
  applyFileScopePreflightInStream,
} from "./file_permission_preflight";
import {
  runCommandGateResult,
  emitFilePermissionActivity,
  enrichPermissionRequestForUi,
  emitAutoApprovedWritePreview,
  runCommandCategoryGateToolResult,
  shouldSkipPermissionWaitForRunCommand,
} from "./chat_stream/permission-ui";
import {
  emitCompactionMirroredActivity,
  emitModelCompactionActivity,
} from "./chat_stream/compaction-activity";
import {
  runToolExecute,
  attachSearchRoutingActivity,
} from "./chat_stream/tool-execute";
import {
  NetworkStreamDisconnectedError,
} from "./chat_stream/network-retry";
import {
  awaitWithTimeout,
  isTextFile,
} from "./chat_stream/stream-misc";
import {
  activeStreams,
  activeStreamRuns,
  activeStreamId,
  nextStreamId,
  partialResponses,
  lastStreamRequest,
  streamSessionByChatId,
  lastTurnModeByChat,
  pendingAskUserArtifactByChatId,
  getLastSkillCacheAppId,
  setLastSkillCacheAppId,
  getChatStreamHandler,
  setChatStreamHandlerRef,
  SUPERSEDE_AWAIT_TIMEOUT_MS,
} from "./chat_stream/stream-state";
import {
  resolveModeChange,
  resolveAskUserToolResult,
  flushInterruptedDraft,
  clearInterruptedDraft,
  flushPartialStreamsForShutdown,
  clearChatStreamStateForChat,
  abortAllStreams,
  cancelStreamForAutomation,
} from "./chat_stream/stream-lifecycle";
import { registerLifecycleHandlers } from "./chat_stream/lifecycle-handlers";
import { registerRevertHandlers } from "./chat_stream/revert-handlers";
import { registerSessionHandlers } from "./chat_stream/session-handlers";
import { createStreamTurnContext } from "./chat_stream/turn-context";
import { buildPromptBundle } from "./chat_stream/turn-runner/prompt-bundle";
import {
  simpleStreamText,
  type SimpleStreamTextDeps,
} from "./chat_stream/turn-runner/simple-stream-text";
import { runStreamRoundWithEmptyOutputRetry } from "./chat_stream/turn-runner/round-retry";
import { processResponseChunkUpdate as runProcessResponseChunkUpdate } from "./chat_stream/turn-runner/response-chunk-update";
import {
  loadModeSkillSection,
  loadRepoSkillsSection,
  loadWorkspaceCapsSection,
  loadActivePlanSection,
  loadAtlarixMdSection,
  loadMemoryMdSection,
  loadInstalledSkillsSection,
} from "./chat_stream/context-sections";
export {
  resolveModeChange,
  clearChatStreamStateForChat,
  flushPartialStreamsForShutdown,
  abortAllStreams,
  getChatStreamHandler,
  cancelStreamForAutomation,
};

const logger = log.scope("chat_stream_handlers");

// --- run_command/file permission gating + UI enrichment moved to ./chat_stream/permission-ui ---
// --- Sentry safe wrappers moved to ./chat_stream/sentry-safe ---

// v4.0 Progressive Tool Reveal: one loader per chat session

// --- shared stream state moved to ./chat_stream/stream-state; lifecycle satellites to ./chat_stream/stream-lifecycle ---

// Directory for storing temporary files
const TEMP_DIR = path.join(os.tmpdir(), "atlarix-attachments");

// Common helper functions

// --- isTextFile moved to ./chat_stream/stream-misc ---

// Ensure the temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// --- performFullRevert moved to ./chat_stream/stream-misc ---

// --- ChatStreamHandlerFn/getChatStreamHandler/cancelStreamForAutomation moved to ./chat_stream/stream-{state,lifecycle} ---

export function registerChatStreamHandlers() {
  registerSessionHandlers();

  const chatStreamHandler = async (
    event: Electron.IpcMainInvokeEvent,
    req: ChatStreamParams,
  ) => {
    // Bug A (single-flight): supersede any in-flight leg for this chat and AWAIT
    // its real termination before starting a new one. Aborting alone is not
    // enough — it's cooperative, so the old leg can still be mid-tool when the
    // new one begins and both write the same workspace. Awaiting the prior
    // runStream() promise guarantees its tool loop + ensureTerminal finished.
    const priorController = activeStreams.get(req.chatId);
    const priorRun = activeStreamRuns.get(req.chatId);
    if (priorController || priorRun) {
      try {
        priorController?.abort(streamStopAbortReason(SUPERSEDED_STREAM_STOP));
      } catch {
        /* noop */
      }
      if (priorRun) {
        await awaitWithTimeout(priorRun, SUPERSEDE_AWAIT_TIMEOUT_MS);
      }
    }

    const streamId = nextStreamId();
    activeStreamId.set(req.chatId, streamId);
    const abortController = new AbortController();
    activeStreams.set(req.chatId, abortController);
    // v11.1: a new stream supersedes any pending ask_user state for this chat.
    pendingAskUserArtifactByChatId.delete(req.chatId);
    // FIX 4: remember this request so the renderer's [Reconnect] button can
    // re-dispatch the exact same turn via `chat:stream:reconnect`.
    lastStreamRequest.set(req.chatId, req);

    // v11.1 overflow recovery: one forced-compaction retry per stream request.
    let retriedAfterOverflowCompaction = false;

    const runStream = async () => {
      const ctx = createStreamTurnContext();
      // A2: set when runAgentTurn ends the turn with background work still
      // outstanding (the turn is OVER, not held open). Surfaced on
      // chat:response:end (rich build emit AND the ensureTerminal fallback) so
      // the renderer shows the "waiting … will resume automatically" chip and
      // auto-resumes when an item reports. Declared before ensureTerminal so the
      // terminal closure can read it.
      // Set when runAgentTurn ended via the forced tools-off finish round. The
      // turn controller is left ABORTED in that case, so the post-turn save gate
      // must treat it as a clean completion (persist the summary) rather than a
      // user cancel.
      // v12 2.3: the snapshot/ledger turn id for THIS turn, captured for the
      // terminal payload so a detached background agent can revert. Set once
      // streamTurnId is established (below).
      let snapshotTurnIdForTerminal: string | undefined;
      const ensureTerminal = (error?: unknown) => {
        if (ctx.streamTerminated) return;
        ctx.streamTerminated = true;
        if (error) {
          safeSend(event.sender, "chat:response:error", {
            chatId: req.chatId,
            streamId,
            error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${String((error as any)?.message ?? error)}`,
          });
        }
        safeSend(event.sender, "chat:response:end", {
          chatId: req.chatId,
          streamId,
          updatedFiles: false,
          hadToolCallsOrPermissions: false,
          ...(snapshotTurnIdForTerminal
            ? { snapshotTurnId: snapshotTurnIdForTerminal }
            : {}),
          // A2: carry parked on the guaranteed terminal too, so the ask path
          // (and the post-success ensureTerminal) keep the flag consistent and
          // never clobber the chip with a parked-less end.
          ...(ctx.turnParked
            ? {
                parked: true,
                parkedCommands: listBackgroundJobs(req.chatId).length,
                parkedSubagents: runningSubagentCount(req.chatId),
              }
            : {}),
        } satisfies ChatResponseEnd);
        // Only relinquish the registry slot if WE still own it — a superseding
        // stream may have already replaced the controller/id for this chat.
        if (activeStreamId.get(req.chatId) === streamId) {
          activeStreams.delete(req.chatId);
        }
      };

      /**
       * Stream stall watchdog. A stalled ROUND now auto-retries with backoff
       * (runStreamRoundWithEmptyOutputRetry aborts only the per-round controller,
       * not the turn). So a stall is transient: just keep the activity clock
       * fresh so the UI shows "Reconnecting…" honestly during the retry, instead
       * of a fatal error card. If every retry is exhausted, the recoverable
       * NetworkStreamDisconnectedError path surfaces the [Reconnect] affordance.
       */
      const handleStreamStall = () => {
        logger.warn(`[stream] Stall detected for chat ${req.chatId} — retrying`);
        handleStreamActivityPulse();
      };

      const streamDebugLogging = isStreamDebugLoggingEnabled();
      const handleToolInputProgress = ({
        toolName,
        deltaCount,
      }: {
        toolName: string;
        deltaCount: number;
      }) => {
        const label = `${getToolActivityLabel(toolName).replace(/…$/u, "")} (${deltaCount} chunks)…`;
        if (label === ctx.lastToolInputPhaseLabel) return;
        ctx.lastToolInputPhaseLabel = label;
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
      // Live partial tool-call arguments → renderer streaming preview (e.g. an
      // edit_file diff building up before the approval card opens).
      const handleToolInputDelta = ({
        toolCallId,
        toolName,
        argsTextSoFar,
      }: {
        toolCallId: string;
        toolName: string;
        argsTextSoFar: string;
      }) => {
        safeSend(event.sender, "chat:stream:tool-input", {
          chatId: req.chatId,
          toolCallId,
          toolName,
          argsTextSoFar,
        });
      };

      // v12 S17: per-turn TTFT waterfall. `time()` only wraps awaited steps —
      // ordering and error propagation are untouched (measure before S18 fixes).
      const preflight = new PreflightTimer();

      try {
        try {
          await preflight.time("auth", () => requireAuthSession());
        } catch (e) {
          if (e instanceof AuthRequiredError) {
            safeSend(event.sender, "chat:response:error", {
              chatId: req.chatId,
              streamId,
              error: formatAuthRequiredIpcError(),
            });
            safeSend(event.sender, "chat:response:end", {
              chatId: req.chatId,
              streamId,
              updatedFiles: false,
              hadToolCallsOrPermissions: false,
            } satisfies ChatResponseEnd);
            if (activeStreamId.get(req.chatId) === streamId) activeStreams.delete(req.chatId);
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
              streamId,
              error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${SAFETY_FILTER_BLOCKED_MESSAGE}`,
            });
            safeSend(event.sender, "chat:response:end", {
              chatId: req.chatId,
              streamId,
              updatedFiles: false,
              hadToolCallsOrPermissions: false,
            } satisfies ChatResponseEnd);
            if (activeStreamId.get(req.chatId) === streamId) activeStreams.delete(req.chatId);
            return;
          }
          if (e instanceof Error && /maximum length|Invalid prompt/i.test(e.message)) {
            safeSend(event.sender, "chat:response:error", {
              chatId: req.chatId,
              streamId,
              error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${e.message}`,
            });
            safeSend(event.sender, "chat:response:end", {
              chatId: req.chatId,
              streamId,
              updatedFiles: false,
              hadToolCallsOrPermissions: false,
            } satisfies ChatResponseEnd);
            if (activeStreamId.get(req.chatId) === streamId) activeStreams.delete(req.chatId);
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
        const { isStreamTransportId, getStreamTransportAppId } = await import("@/lib/chat/stream-transport");

        if (!isStreamTransportId(req.chatId)) {
          const legacyMsg =
            "Legacy database chats were removed. Open a workspace session from the sidebar.";
          logger.warn(`Chat ${req.chatId} rejected: legacy positive chat id`);
          safeSend(event.sender, "chat:response:error", {
            chatId: req.chatId,
            streamId,
            error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${legacyMsg}`,
          });
          safeSend(event.sender, "chat:response:end", {
            chatId: req.chatId,
            streamId,
            updatedFiles: false,
            hadToolCallsOrPermissions: false,
          } satisfies ChatResponseEnd);
          ctx.streamTerminated = true;
          return;
        }

        if (isStreamTransportId(req.chatId)) {
          // Check if this ephemeral chat is associated with a workspace
          const ephemeralAppId = getStreamTransportAppId(req.chatId);

          if (ephemeralAppId) {
            logger.log(`Chat ${req.chatId} is ephemeral workspace chat for app: ${ephemeralAppId}`);
          } else {
            const noWorkspaceMsg =
              "Open a workspace folder to start chatting. Use Open folder on the welcome screen.";
            logger.warn(`Chat ${req.chatId} rejected: ephemeral chat without workspace`);
            safeSend(event.sender, "chat:response:error", {
              chatId: req.chatId,
              streamId,
              error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${noWorkspaceMsg}`,
            });
            safeSend(event.sender, "chat:response:end", {
              chatId: req.chatId,
              streamId,
              updatedFiles: false,
              hadToolCallsOrPermissions: false,
            } satisfies ChatResponseEnd);
            ctx.streamTerminated = true;
            return;
          }
        }

      // Get app for ephemeral workspace chats or regular DB chats
      let chat: any;
      let appData: any;

      if (isStreamTransportId(req.chatId)) {
        // Ephemeral workspace chat - get app from DB using the stored appId
        const ephemeralAppId = getStreamTransportAppId(req.chatId);
        const { getStreamTransport } = await import("@/lib/chat/stream-transport");
        const ephemeralChat = getStreamTransport(req.chatId);

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
      req.workspaceSessionId = await preflight.time("session-bind", () =>
        resolveOrBindWorkspaceSessionForStream({
          workspaceSessionId: req.workspaceSessionId,
          chatId: req.chatId,
          workspaceAppId: chat.app?.id ?? req.appId ?? null,
        }),
      );
      // Issue 4: remember chat→session so a shutdown/suspend flush can persist
      // this stream's partial output without a request object.
      if (req.workspaceSessionId) {
        streamSessionByChatId.set(req.chatId, req.workspaceSessionId);
      }

      // v12 0.2 (B2): the turn's NATIVE model messages (assistant tool_use +
      // tool results + continuations) accumulated by the build loop. Persisted
      // on the assistant message's modelContent as a native-history envelope
      // so the NEXT turn replays native parts instead of flattened prose.

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
          const ephemeral = getStreamTransport(req.chatId);
          if (ephemeral) {
            ephemeral.messages = chat.messages;
          }
        }
      }

      // v3.9: Continue after clarifying questions — use last user message (already updated with Q/A block)
      let userPrompt: string = "";
      if (req.continueAfterQuestions) {
        const ephemeral = getStreamTransport(req.chatId);
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

        // W10: temp-file writes + AttachmentStore/PDF pre-extract are real
        // I/O that previously fell into the "unaccounted" preflight gap.
        await preflight.time("ingest-attachments", async () => {
        for (const [index, attachment] of req.attachments!.entries()) {
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
            req.chatId,
            req.workspaceSessionId ?? undefined,
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
                const previewClipped = content.length > 1500;
                attachmentInfoForModel += `  preview${previewClipped ? " (first 1500 chars — read_attachment pages the FULL content)" : ""}:\n  ---\n  ${content
                  .slice(0, 1500)
                  .replace(/\n/g, "\n  ")}\n  ---\n`;
              } catch (err) {
                logger.error(`Error reading file content: ${err}`);
              }
            }
          }
        }
        });
        attachmentInfoForModel +=
          '\nMANDATORY TOOL USE:\n- If the user asks to read/summarize any attached file, you MUST call the tool `read_attachment` with the exact `attachmentId` shown above.\n- Example: read_attachment({ "attachmentId": "<id>" })\n';
      }

      if (pasteAttachmentsForMessage?.length) {
        for (const paste of pasteAttachmentsForMessage) {
          AttachmentStore.add(
            pasteToAttachmentData(paste),
            req.chatId,
            req.workspaceSessionId ?? undefined,
          );
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

      // v14.8.11 (W9): every live chat is a negative-id stream-transport chat —
      // renderer, headless CLI, and evals all mint them. The legacy positive-id
      // DB-chat branches were deleted; this invariant fails loudly if one ever
      // reappears instead of silently resurrecting half a branch.
      if (!isStreamTransportId(req.chatId)) {
        throw new Error(
          "LEGACY_CHAT_REMOVED: chat:stream requires a stream-transport (negative) chatId — legacy database chats were removed.",
        );
      }

      // v12 0.4-C2: capture the persisted row's UUID so the ephemeral message
      // carries it (edits target the DB row directly — no ordinal mapping).
      // W2 (v14.8.11): retry once on failure — a swallowed persist here leaves
      // the row holding only the display STUB (no modelContent/attachments),
      // so a later resume replays an EMPTY <atlarix-*-attachment/> to the
      // model ("attachment is truncated"). One retry covers transient sqlite
      // contention; a double failure is loudly logged.
      let persistedUserRowId: string | undefined;
      if (req.workspaceSessionId && !req.continueAfterQuestions) {
        const { persistWorkspaceSessionUserMessage } = await import(
          "./workspace_session_handlers"
        );
        const persistOnce = () =>
          persistWorkspaceSessionUserMessage(
            req.workspaceSessionId!,
            userDisplayContent,
            {
              modelContent:
                userPrompt !== userDisplayContent ? userPrompt : null,
              pasteAttachments: pasteAttachmentsForMessage,
              fileAttachments:
                storedFileAttachments.length > 0 ? storedFileAttachments : null,
            },
          );
        try {
          const row = await preflight.time("persist-user-msg", async () => {
            try {
              return await persistOnce();
            } catch (firstErr) {
              logger.warn(
                "Persist of workspace session user message failed — retrying once:",
                firstErr,
              );
              return await persistOnce();
            }
          });
          persistedUserRowId = row?.id;
        } catch (err) {
          logger.error(
            "Failed to persist workspace session user message (after retry) — a resume of this turn will see attachment stubs without bodies:",
            err,
          );
        }
      }


      const settingsBase = readSettings();
      let settings =
        req.streamChatModeOverride != null
          ? { ...settingsBase, selectedChatMode: req.streamChatModeOverride }
          : settingsBase;
      if (req.workModeOverride) {
        const { settingsPatchForWorkMode } = await import("@/lib/work-mode");
        settings = { ...settings, ...settingsPatchForWorkMode(req.workModeOverride) };
      }

      // v12 7A: user-defined agent (.atlarix/agents/<name>.md). Resolved
      // BEFORE the model + work-mode resolve below so its base mode, model
      // override, and (later) custom system block + tool allowlist all take
      // effect. Composes with everything downstream (capability trim, hooks).
      let activeUserAgent: import("@/lib/agents/user-agents").UserAgent | null =
        null;
      // Per-turn req override wins; else the persisted picker selection.
      const agentName = req.agentOverride ?? settings.selectedAgent ?? undefined;
      if (agentName && chat?.app?.path) {
        const { loadUserAgent } = await import("@/lib/agents/user-agents");
        activeUserAgent = loadUserAgent(
          resolveAppPath(chat.app.path),
          agentName,
        );
        if (activeUserAgent) {
          const { settingsPatchForWorkMode } = await import("@/lib/work-mode");
          settings = {
            ...settings,
            ...settingsPatchForWorkMode(activeUserAgent.mode),
          };
          if (activeUserAgent.model && !req.modelOverride) {
            const slash = activeUserAgent.model.indexOf("/");
            req.modelOverride =
              slash > 0
                ? {
                    provider: activeUserAgent.model.slice(0, slash),
                    name: activeUserAgent.model.slice(slash + 1),
                  }
                : { provider: settings.selectedModel.provider, name: activeUserAgent.model };
          }
          logger.log(
            `[user-agent] active: ${activeUserAgent.name} (mode=${activeUserAgent.mode}${activeUserAgent.model ? `, model=${activeUserAgent.model}` : ""})`,
          );
        } else {
          logger.warn(`[user-agent] "${req.agentOverride}" not found — ignored`);
        }
      }

      // Generate requestId early so it can be saved with the message
      engineRequestId = uuidv4();

      // Add a placeholder assistant message immediately
      // For ephemeral chats, we'll use a placeholder ID
      // (v12 3.1: monotonic counter — Date.now() collided in-millisecond.
      // Allocation order matters: the user message's id must be LOWER than
      // the placeholder's so id-order matches array/display order.)
      const newUserMessageId = nextEphemeralMessageId();
      const placeholderMessageId = nextEphemeralMessageId();
      let placeholderAssistantMessage: any = { id: placeholderMessageId };
      let updatedChat: any = chat; // Use the existing chat object for ephemeral

      const ephemeralChat = getStreamTransport(req.chatId);
      const existingMessages = ephemeralChat?.messages || [];

      const placeholderMessage = {
        id: placeholderMessageId,
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
          id: newUserMessageId,
          chatId: req.chatId,
          role: "user",
          content: userDisplayContent,
          // v12 0.4-C2: direct DB-row identity for edits (no ordinal mapping).
          ...(persistedUserRowId ? { sessionRowId: persistedUserRowId } : {}),
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

      let streamTurnId = String(placeholderAssistantMessage.id);
      snapshotTurnIdForTerminal = streamTurnId; // v12 2.3
      // Tie any browser/preview session reels captured this turn to this
      // assistant message so the renderer attaches the inline artifact to it.
      setReelTurnContext(req.chatId, String(placeholderAssistantMessage.id));
      // v11.1: set when the model asked the user question(s) — the turn ends
      // gracefully (persist + response:end) WITHOUT task-complete side effects
      // (no build verification, no self-review).
      const buildToolStreamOpts = () => ({
        turnId: streamTurnId,
        abortController,
        workspaceSessionId: req.workspaceSessionId ?? undefined,
        unattended: Boolean(req.automation),
      });

      // Send the messages right away so that the loading state is shown for the message.
      safeSend(event.sender, "chat:response:chunk", {
        chatId: req.chatId,
        streamId,
        messages: updatedChat.messages,
      });

      // v12 7D: accumulate BYOK token usage across the turn's rounds for the
      // per-turn cost estimate emitted on chat:response:end.
      // v13.2 cache-aware cost: cache reads/writes priced at provider cache
      // rates; OpenRouter's per-request usage.cost (already discounted) wins.

      // Check if this is a test prompt
      const testResponse = getTestResponse(req.prompt);

      if (testResponse) {
        // For test prompts, use the dedicated function
        ctx.fullResponse = await streamTestResponse(
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
        // v11: no plan-based model coercion — every plan can use all Core
        // models. Access is enforced strictly by the shared token pool
        // (pre-flight block below + per-step enforcement in onStepFinish).
        // `modelClient` is `let` (not destructured const) so the mid-stream
        // tier-escalation guard can rebind it when Auto-routing decides a
        // tool-heavy turn deserves `balanced` or `thinking` halfway through.
        // `isEngineEnabled` / `isSmartContextEnabled` stay tied to the initial
        // client because they encode capabilities used during system-prompt
        // assembly and would be unsafe to flip mid-turn.
        // v12 S18: the context-window lookup depends only on `effectiveModel`
        // — start it CONCURRENTLY with model-client creation and await it at
        // its original use site below (the [budget] log). The noop catch only
        // suppresses an unhandled-rejection warning if we throw before that
        // await; the await itself still rethrows.
        const contextWindowPromise = preflight.time("context-window", () =>
          getContextWindowDetailed(effectiveModel, req.chatId),
        );
        contextWindowPromise.catch(() => {});
        const initialModelClientBundle = await preflight.time(
          "model-client",
          () => getModelClient(effectiveModel, settings, mainOptions),
        );
        let modelClient = initialModelClientBundle.modelClient;
        // Surface the no-key → Atlarix Core fallback so the user knows their
        // selected model isn't what answered (and how to switch back).
        if (initialModelClientBundle.fellBackToCore) {
          safeSend(event.sender, "chat:activity", {
            id: `core-fallback-${req.chatId}`,
            type: "model_selection",
            label: "Using Atlarix Core",
            detail:
              "Your selected model has no API key — add one in Settings to use it.",
            status: "done",
            timestamp: Date.now(),
            chatId: req.chatId,
          });
        }
        // v12 S18: the Compass usage pre-flight is a Supabase round-trip that
        // only gates dispatch (per-step metering still enforces mid-turn) —
        // start it as soon as the provider is known and await at the original
        // check site, overlapping the tier/window work between here and there.
        const compassUsagePromise =
          modelClient.builtinProviderId === "compass"
            ? preflight.time("compass-preflight", () =>
                getCompassUsageFromSupabase(),
              )
            : null;
        compassUsagePromise?.catch(() => {});
        const isEngineEnabled = initialModelClientBundle.isEngineEnabled;
        const isSmartContextEnabled = initialModelClientBundle.isSmartContextEnabled;
        // Native extended-thinking/reasoning turns on whenever the selected
        // model + gateway support it (the fast/balanced/thinking tiers are gone;
        // a model now delivers its full capability).
        const enableNativeReasoning = hasNativeDeepThinkingSupport(
          effectiveModel,
          modelClient.builtinProviderId,
          settings,
        );
        logger.log(
          `[stream:${req.chatId}] model=${effectiveModel.provider}/${effectiveModel.name} ` +
          `reasoning=${enableNativeReasoning}`,
        );

        // FIX 5: log the true context window for this dispatch. The first
        // lookup per (provider, model) hits "live" (catalog fetch); subsequent
        // calls in the same process hit "cache" via the module-level memo.
        // "fallback" means the catalog had no contextWindow and we used the
        // 200K default — investigate if this fires for a model we know.
        const budgetDetail = await contextWindowPromise;
        logger.log(
          `[budget] model=${effectiveModel.provider}/${effectiveModel.name} ` +
          `contextWindow=${budgetDetail.contextWindow} source=${budgetDetail.source}`,
        );

        const usedCompassThisStream = modelClient.builtinProviderId === "compass";
        // v11 strict enforcement: tokens remaining at stream start (server
        // authoritative; null when pre-flight could not verify) + local tally
        // so the turn hard-stops on the step that exhausts the pool.

        const stopStreamForCompassLimit = (origin: string) => {
          if (ctx.compassLimitHit) return;
          ctx.compassLimitHit = true;
          logger.warn(
            `[compass] Token pool exhausted mid-task (${origin}) — stopping stream for chat ${req.chatId}`,
          );
          safeSend(event.sender, "chat:response:error", {
            chatId: req.chatId,
            streamId,
            error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${compassExhaustedUserMessage(ctx.compassStreamTier ?? "free")}`,
          });
          abortController.abort(streamStopAbortReason(COMPASS_LIMIT_STREAM_STOP));
        };

        if (compassUsagePromise) {
          const usagePre = await compassUsagePromise;
          if (usagePre.ok) {
            if (usagePre.tier) {
              ctx.compassStreamTier = usagePre.tier;
            }
            if (usagePre.monthlyLimit > 0) {
              ctx.compassRemainingBudget = Math.max(
                0,
                usagePre.monthlyLimit - usagePre.tokensUsedThisMonth,
              );
            }
            // 3b diagnostics: the metering pool (this RPC) must match the
            // budget the UI shows for the user's real plan. A mismatch here
            // (e.g. a workforce account metered at a free-tier monthlyLimit)
            // is what causes a premature "token pool exhausted" stop while the
            // app still shows tokens remaining. Logged so the gap is visible.
            logger.log(
              `[compass] preflight budget chat ${req.chatId}: tier=${usagePre.tier} ` +
                `monthlyLimit=${usagePre.monthlyLimit} usedThisMonth=${usagePre.tokensUsedThisMonth} ` +
                `remaining=${ctx.compassRemainingBudget ?? "unknown"}`,
            );
          } else {
            logger.warn(
              `[compass] preflight usage unavailable for chat ${req.chatId} (reason=${usagePre.reason}) — ` +
                `enforcement relies on the server RPC only this turn`,
            );
          }
          if (
            usagePre.ok &&
            usagePre.monthlyLimit > 0 &&
            usagePre.tokensUsedThisMonth >= usagePre.monthlyLimit
          ) {
            safeSend(event.sender, "chat:response:error", {
              chatId: req.chatId,
              streamId,
              error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${compassExhaustedUserMessage(usagePre.tier)}`,
            });
            if (activeStreamId.get(req.chatId) === streamId) activeStreams.delete(req.chatId);
            return;
          }
        }

        // Workspace: use chat's linked app, or req.appId only when the chat has no app
        // (client binds appId on first stream — no mid-chat sidebar override).
        let effectiveApp = updatedChat.app;
        if (!effectiveApp && req.appId != null) {
          const boundApp = await preflight.time("app-lookup", () =>
            db.query.apps.findFirst({
              where: eq(apps.id, req.appId!),
            }),
          );
          if (boundApp) effectiveApp = boundApp;
        }
        const hasWorkspace = !!effectiveApp;
        // Worktree-write automation runs execute in an isolated worktree, not
        // the live workspace checkout.
        let appPath =
          req.automation?.workspacePathOverride ??
          (effectiveApp?.path ? resolveAppPath(effectiveApp.path) : "");
        const effectiveAppId = effectiveApp?.id;
        if (process.env.ATLARIX_DIAG_146 === "1") {
          logger.info(
            `[DIAG_146] enforce-appId chat=${req.chatId} effectiveAppId=${effectiveAppId} path=${effectiveApp?.path ?? "<none>"}`,
          );
        }
        if (effectiveAppId !== getLastSkillCacheAppId()) {
          setLastSkillCacheAppId(effectiveAppId);
          void import("@/lib/skills/skill-loader")
            .then((m) => m.clearSkillCache())
            .catch(() => {});
        }
        logger.log(
          `Using workspace for chat ${req.chatId}: ${appPath || "(none)"} (appId: ${effectiveAppId ?? req.appId ?? "n/a"})`,
        );
        // v14.8.10 Fix G: keep the incremental ctags/FTS5 search-index refresh
        // alive for ordinary agent sessions. Idempotent; ignore-filtered; cheap.
        // Automation runs skip this — never re-point the singleton watcher at a
        // throwaway worktree.
        if (hasWorkspace && appPath && !req.automation) {
          void import("@/lib/search/search-index-watcher")
            .then((m) => m.ensureSearchIndexWatcher(appPath, effectiveAppId ?? null))
            .catch(() => {});
        }
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
          // PASS1: no proactive codebase-context injection — the model explores
          // via grep (Blueprint-reranked), glob, and read_file on demand.
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

        // Parse @file:/@dir: mentions and build a scoped context block
        // (file contents + folder listings, capped). Replaces the old
        // whole-other-app codebase dump.
        const contextMentions = parseContextMentions(req.prompt);
        const mentionedContextBlock = hasWorkspace
          ? await extractMentionedContext({
              appPath,
              files: contextMentions.files,
              dirs: contextMentions.dirs,
            })
          : "";

        const isDeepContextEnabled =
          isEngineEnabled &&
          settings.enableProSmartFilesContextMode &&
          // Anything besides balanced will use deep context.
          settings.proSmartContextOption !== "balanced" &&
          !mentionedContextBlock;
        logger.log(`isDeepContextEnabled: ${isDeepContextEnabled}`);

        const otherAppsCodebaseInfo = mentionedContextBlock;
        if (otherAppsCodebaseInfo) {
          logger.log(
            `Injected @-mention context: ${contextMentions.files.length} file(s), ${contextMentions.dirs.length} folder(s)`,
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
          let messageHistory = updatedChat.messages.map((message: Msg & { modelContent?: string | null }) => {
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

            // v12 0.2 (B2): assistant turns carrying a native-history envelope
            // keep it — the ModelMessage build below expands it into native
            // tool_use/tool_result messages. Slicing/truncation here still
            // operates on the single string-content slot (one per turn).
            const nativeEnvelope =
              message.role === "assistant" &&
              isNativeHistoryEnvelope(message.modelContent)
                ? { modelContent: message.modelContent! }
                : {};

            return { ...baseMessage, ...commitFields, ...nativeEnvelope };
          });

          // v11.1 durable compaction: when the history contains a persisted
          // compaction summary, the MODEL only needs [last summary .. end] —
          // a reload rehydrates the full session log (kept for the UI), but
          // re-sending the superseded head would re-overflow the context.
          {
            const { sliceFromLastCompactionSummary } = await import(
              "@/lib/context/compaction"
            );
            const sliced = sliceFromLastCompactionSummary(messageHistory);
            if (process.env.ATLARIX_DIAG_146 === "1") {
              logger.info(
                `[DIAG_146] dispatch-slice chat=${req.chatId} markerFound=${sliced.length !== messageHistory.length} fullLen=${messageHistory.length} slicedLen=${sliced.length}`,
              );
            }
            if (sliced.length !== messageHistory.length) {
              logger.log(
                `[stream:${req.chatId}] Compaction summary found — model history ${messageHistory.length} → ${sliced.length} messages`,
              );
              messageHistory = sliced;
            }
          }

          logger.log(
            `[stream:${req.chatId}] Prepared message history (len=${messageHistory.length})`,
          );

          // Turn-based history cap. The legacy positive-id "auto-summarize"
          // gate was constant-false (W9) and is gone: mid-turn pressure is
          // handled by `compactAgenticMessagesIfNeeded` inside the SMART
          // AGENTIC TOOL LOOP; `compress_context` remains the model-triggered
          // escape hatch; durable summaries flow through [COMPACTION MARKER]
          // message slices; token-percent compaction (55% / 75% / 90%) runs
          // later against `resolveModelContextLimit` + the full dispatch
          // estimate.
          let limitedMessageHistory = messageHistory;
          const contextSummaryForSystem: string | null = null;

          {
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
          // v12 0.1: legacy "agent" is coerced to "build" upstream (readSettings
          // + custom-command modeOverride) — only ask/build reach this point.
          const chatMode: "ask" | "build" =
            settings.selectedChatMode === "build" ? "build" : "ask";

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

          // #15: compact active-mode re-anchor injected after the latest user
          // turn (recency), with a "mode changed" prefix when the mode differs
          // from this chat's previous turn — weaker models otherwise follow the
          // PREVIOUS mode after a switch. Computed once per turn; injected at
          // step 0 via the prepareStep seam below.
          const prevTurnMode = lastTurnModeByChat.get(req.chatId);
          lastTurnModeByChat.set(req.chatId, modeBlockKey);
          const modeReanchorNote =
            (prevTurnMode && prevTurnMode !== modeBlockKey
              ? "Work mode changed since your last message — prior turns ran under a different mode; ignore their behavioral norms and follow the mode below. "
              : "") + getActiveModeReanchor(modeBlockKey);

          // #A1: compact live task-ledger block, re-injected near the latest
          // turn every turn so "what's left" is the freshest thing the model
          // reads (open-weight models otherwise re-derive progress from git).
          // Populated once per turn from the session's plan artifact by
          // loadActivePlanSection below (single DB read, reused across steps).
          let taskLedgerBlock: string | null = null;

          // #12: when a round yields ONLY reasoning (no text/tool), the empty-output
          // retry sets this take-once nudge (ctx.pendingEmptyOutputNudge); the
          // retry's prepareStep injects it so the model is told to act instead of
          // silently re-running the same round.

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
            baseSystemPrompt = await preflight.time("system-prompt", () =>
              buildSystemPromptWithProjectInstructions({
              workspacePath: appPath,
              workspacePromptContent: null,
              contextSize,
              chatMode,
              effectiveWorkMode: modeBlockKey,
              userPrompt: userPrompt,
              hasAnsweredQuestions: updatedChat?.hasAnsweredQuestions ?? false,
              hasWorkspace: true,
              ...promptIdentityOpts,
              }),
            );
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
          // v12 7A: prepend the user agent's system block (build path +
          // every non-ask consumer of `systemPrompt`; the ask branch injects
          // it into its own rebuilt header below).
          if (activeUserAgent) {
            const { renderUserAgentSystemBlock } = await import(
              "@/lib/agents/user-agents"
            );
            baseSystemPrompt = `${renderUserAgentSystemBlock(activeUserAgent)}\n\n${baseSystemPrompt}`;
          }
          let contextSections: ContextSection[] = [];

          // v12 S18: the six pre-flight context loads (mode skill, repo
          // skills, workspace capabilities, plan artifact, filesystem truth,
          // atlarix.md) are mutually independent disk/DB reads that feed
          // DISTINCT sections — run them CONCURRENTLY. Each loader keeps its
          // own try/catch (one failed source never blocks the others, same
          // isolation as the old serial code) and returns a section-or-null;
          // results are pushed afterwards in one place. Section ORDER is
          // unaffected: assembleContextSections sorts by `priority`, and all
          // priorities here are distinct. Wall-clock drops from sum(loads)
          // to max(loads). The [perf] spans now measure concurrent wall time.
          // --- 7 context-section loaders moved to ./chat_stream/context-sections ---

          // R2 single-consumer invariant: decide the delivery channel ONCE, up
          // front — BEFORE any take-once drain. On a wake turn (auto-resume with
          // finished background/sub-agent work OR a stall advisory) the results
          // are delivered by the FORCED `collect_results` tool (a channel a weak
          // model cannot skip); so the context loaders and the prepareStep
          // injection must NOT drain them (that would leave collect_results empty
          // and route the result to the weak context section instead — the bug
          // this fixes). `computeWakePendingResults` is strictly non-destructive.
          const wakeHasPendingResults = computeWakePendingResults(
            req.chatId,
            req.continueAfterQuestions === true,
          );
          // BUT a forced/object tool_choice is INCOMPATIBLE with extended-thinking
          // mode on several providers (Alibaba/Qwen 400 "tool_choice ... not
          // supported ... in thinking mode"; Anthropic likewise only allows
          // auto/none while thinking). So when reasoning is active we do NOT force
          // the tool — we deliver the same results via the prepareStep injection
          // (the mid-turn path). Thinking-capable models reliably consume that.
          const forceCollectOnWake = wakeHasPendingResults && !enableNativeReasoning;

          // v13 7A: background command results that finished AFTER the
          // previous turn ended — drain them into this turn's context.
          const loadBackgroundResultsSection = (): ContextSection | null => {
            if (wakeHasPendingResults) return null; // collect_results is the drain
            const pending = takePendingBackgroundCommandResults(req.chatId);
            if (!pending) return null;
            return {
              name: "taskProgress",
              priority: 1.5,
              content: pending,
            };
          };

          // Background sub-agent results that finished after the previous turn
          // ended — drain them into this turn's context the same way.
          const loadSubagentResultsSection = (): ContextSection | null => {
            if (wakeHasPendingResults) return null; // collect_results is the drain
            const pending = takePendingSubagentResults(req.chatId);
            if (!pending) return null;
            return {
              name: "taskProgress",
              priority: 1.5,
              content: pending,
            };
          };

          const contextSectionParams = {
            effectiveWorkMode,
            preflight,
            hasWorkspace,
            appPath,
            effectiveAppId,
            req,
          };
          const [
            modeSkillSection,
            repoSkillsSection,
            workspaceCapsSection,
            activePlanResult,
            atlarixMdSection,
            memoryMdSection,
            installedSkillsSection,
          ] = await Promise.all([
            loadModeSkillSection(contextSectionParams),
            loadRepoSkillsSection(contextSectionParams),
            loadWorkspaceCapsSection(contextSectionParams),
            loadActivePlanSection(contextSectionParams),
            loadAtlarixMdSection(contextSectionParams),
            loadMemoryMdSection(contextSectionParams),
            loadInstalledSkillsSection(contextSectionParams),
          ]);
          // loadActivePlanSection is the sole writer of taskLedgerBlock.
          taskLedgerBlock = activePlanResult.taskLedgerBlock;
          const loadedSections = [
            modeSkillSection,
            repoSkillsSection,
            workspaceCapsSection,
            activePlanResult.section,
            atlarixMdSection,
            memoryMdSection,
            installedSkillsSection,
            loadBackgroundResultsSection(),
            loadSubagentResultsSection(),
          ];
          for (const section of loadedSections) {
            if (section) contextSections.push(section);
          }
          const shouldCreateTaskLedger = false;
          if (
            shouldCreateTaskLedger &&
            !req.prompt.startsWith("Summarize from chat-id=")
          ) {
            let shouldEmitPlanCreated = false;
            const wsId = effectiveAppId ?? req.appId ?? undefined;
            let usedWorkspacePlanLedger = false;

            if (typeof wsId === "number" && wsId > 0 && hasWorkspace && appPath) {
              if (hasActivePlanLedger(wsId)) {
                const planTid = planLedgerTurnId(wsId);
                if (planTid != null) {
                  streamTurnId = planTid;
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
                        streamTurnId = planTid;
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
                        streamTurnId = planTid;
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
                turnId: streamTurnId,
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
                      await setLedgerSteps(streamTurnId, planSteps);
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

            const ledgerForUi = getLedger(streamTurnId);
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

          // v14.8.7 §A: the legacy taskProgress injection here keyed off the
          // dead task-ledger (getLedger(streamTurnId) is always undefined with
          // shouldCreateTaskLedger=false); the live compact ledger now rides the
          // per-turn recency slot (taskLedgerBlock) from the plan artifact.

          // (fileSystemTruth is loaded concurrently above — S18.)

          // Pass 7: Workforce workspace context block deleted along with the
          // Legacy hosted credential store removed; per-extension state lives in MCP server
          // env vars.

          // Blueprint is the silent grep-ranking substrate (ctags + FTS5) — no
          // map tool. Architecture exploration is tool-driven via grep + read_file.

          // PASS5: SQLite project memory is tool-driven — the model calls
          // get_project_memory when it needs project context. (v11.1: the
          // dead pre-injection block was deleted; table + builder remain.)

          // (projectMemory / atlarix.md is loaded concurrently above — S18.)

          // Phase 6: Inject context summary (compacted earlier conversation)
          if (contextSummaryForSystem) {
            contextSections.push({
              name: "contextSummary",
              priority: 5,
              content: `## Session Summary (earlier conversation)\n${contextSummaryForSystem}`,
            });
            logger.info("Injected context summary from auto-compaction");
          }

          // v14.7: the redundant rolling 7-exchange "session memory" summary was
          // REMOVED. It was a lossy, char-truncated second copy of the recent
          // tail that competed with the full native conversation history and made
          // the model behave as if only ~7 exchanges existed. Model context now
          // defers entirely to the full history + token-overflow compaction
          // (getUsableBudget / enforceContextBudget / compactAgenticMessagesIfNeeded),
          // matching opencode / Claude Code (keep everything; compact only on real
          // token overflow). The display has always shown the full conversation.

          const isSummarizeIntent = req.prompt.startsWith(
            "Summarize from chat-id=",
          );

          // buildPromptBundle moved to ./chat_stream/turn-runner/prompt-bundle;
          // the assembly config it reads is passed once via promptBundleDeps
          // (all fields are finalized before the first call).
          const promptBundleDeps = {
            req,
            event,
            effectiveAppId,
            effectiveWorkMode,
            userPrompt,
            baseSystemPrompt,
            isSummarizeIntent,
            otherAppsCodebaseInfo,
          };
          let promptBundle = await preflight.time("prompt-bundle", () =>
            buildPromptBundle(contextSections, promptBundleDeps),
          );
          let {
            systemPrompt,
            contextAssemblerBlob,
            codebasePrefix,
            otherCodebasePrefix,
          } = promptBundle;

          const modelContextResolved = await preflight.time(
            "resolve-context-limit",
            () => resolveModelContextLimit(effectiveModel, settings),
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
            promptBundle = await buildPromptBundle(workingSections, promptBundleDeps);
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
            );
          }

          const tierBudgeted = await preflight.time("context-budget", () =>
            enforceContextBudget({
              settings,
              effectiveModel,
              userPrompt,
              systemPrompt,
              contextAssemblerBlob,
              limitedMessageHistory,
              codebasePrefixMessages: [...codebasePrefix],
              otherCodebasePrefixMessages: [...otherCodebasePrefix],
            }),
          );
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
            ): Promise<{ ok: boolean; tokensBefore?: number; tokensAfter?: number; status?: string }> => {
              const providerId =
                getEffectiveModelForOptions(settings)?.provider ??
                (settings.selectedModel?.provider ?? undefined);
              const { executeCompressContext } = await import("@/lib/tools/workspace");
              const { getStreamTransport } = await import("@/lib/chat/stream-transport");
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
                  // W6: the stream's REAL system prompt is in scope — no more
                  // hardcoded 6000 (the ratio gate now sees the meter's scope).
                  systemPromptTokens: estimateTokens(systemPrompt),
                  inputTokens: estimateTokens(userPrompt),
                  providerId,
                  sessionStats: { toolCallCount: 0, delegationCount: 0 },
                  // Thread the known-good session id (as the other two compress
                  // call sites do) so the compaction marker persists — else a
                  // reload re-loads FULL history and re-summarizes on the first
                  // post-reload turn.
                  workspaceSessionId: req.workspaceSessionId ?? undefined,
                  setMessages: (next) => {
                    updatedChat.messages = next as typeof updatedChat.messages;
                    const ec = getStreamTransport(req.chatId);
                    if (ec) ec.messages = next as typeof ec.messages;
                  },
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
              {
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
              promptBundle = await buildPromptBundle(workingSections, promptBundleDeps);
              ({
                systemPrompt,
                contextAssemblerBlob,
                codebasePrefix,
                otherCodebasePrefix,
              } = promptBundle);
              const tierBudgetedR = await enforceContextBudget({
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
              {
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
                  const cr = await runCompressAndRebuild(reason);
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
              {
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
                    const crF = await runCompressAndRebuild("forced-fill-90%");
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

            const CONTEXT_PROACTIVE_THRESHOLD = 0.55;
            const fillAfterProactive = dispatchEstimate / contextWindowTokens;
            if (fillAfterProactive >= CONTEXT_PROACTIVE_THRESHOLD) {
              const livePct = Math.round(fillAfterProactive * 100);
              logCompactionLine(dispatchEstimate, "reminder", 55);
              proactiveContextReminderForStream = `Context is at ${livePct}% capacity. Consider calling compress_context before your next heavy tool use.`;
            }
            // Context meter: report the ACTUAL model-facing dispatched size
            // (post compaction/slice) + window so the UI shows what the model
            // sees and DROPS after a summarize, instead of the full untrimmed
            // conversation count. Sections/trims came from the earlier report;
            // the renderer (useContextReport) merges these dispatched fields in.
            if (process.env.ATLARIX_DIAG_146 === "1") {
              logger.info(
                `[DIAG_146] per-dispatch context-report chat=${req.chatId} dispatchedTokens=${dispatchEstimate} window=${contextWindowTokens}`,
              );
            }
            safeSend(event.sender, "chat:context-report", {
              chatId: req.chatId,
              sections: [],
              trimReport: [],
              dispatchedTokens: dispatchEstimate,
              contextWindow: contextWindowTokens,
            } satisfies ChatContextReport);
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
                `[TTFT] provider=${String(modelClient.builtinProviderId)} model=${String((effectiveModel as { name?: string })?.name ?? "")} contextLength=${modelContextResolved.rawContextLength ?? "unknown"} ttft=${Date.now() - ttftStartRef.ms}ms budgetTier=${budgetTracker.getBudgetTier()} estimatedTokens=${dispatchEstimate} pruningApplied=${contextBudgetPruningApplied} compressionApplied=${openRouterCompressionApplied} compactionApplied=${llmCompactionApplied}`,
              );
            };
          })();

          type HistoryMsg = { role: string; content?: string; sourceCommitHash?: string; commitHash?: string; modelContent?: string | null };
          let limitedHistoryChatMessages: ModelMessage[] = limitedMessageHistory.flatMap((msg: HistoryMsg): ModelMessage[] => {
            // v12 0.2 (B2): assistant turns with a native-history envelope
            // expand into their NATIVE messages (assistant tool_use + tool
            // results) — the model replays real tool blocks, byte-stable
            // across turns (prompt cache holds). Media re-gated when the
            // dispatching provider can't take images in tool results.
            if (msg.role === "assistant" && isNativeHistoryEnvelope(msg.modelContent)) {
              const envelope = parseNativeHistory(msg.modelContent);
              if (envelope) {
                return regateNativeMediaForProvider(
                  envelope.messages,
                  modelClient.builtinProviderId,
                  resolveReasoningCatalogModelId(effectiveModel),
                );
              }
            }

            const baseMsg: { role: "user" | "assistant" | "system"; content: string; providerOptions?: Record<string, Record<string, unknown>> } = {
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

            return [baseMsg as ModelMessage];
          });

          // OpenRouter-backed (Compass + BYOK): last-resort safety cap. The
          // per-model budget pass runs first; this only kicks in when history is
          // still over the window.
          const isOpenRouterBacked =
            modelClient.builtinProviderId === "compass" ||
            modelClient.builtinProviderId === "openrouter";
          if (isOpenRouterBacked && budgetTracker.isOverLimit()) {
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
          // Follow-on to W4 (v14.8.11): on a vision-capable dispatch the
          // current turn's image attachments ride the user message as NATIVE
          // image parts — seen immediately, no tool round-trip. Uses
          // detectVisionCapability (user-message image INPUT — models.dev
          // aware), NOT the tool-result media gate: OpenAI-compatible APIs
          // accept images in user messages but not in tool results.
          const visionOk = detectVisionCapability(
            modelClient.builtinProviderId,
            resolveReasoningCatalogModelId(effectiveModel),
          );
          // Edited/resent turns carry no fresh req.attachments — recover the
          // last user message's persisted attachments from the transport so an
          // edit doesn't silently drop what the model could see/read.
          const lastUserTransportMessage = (() => {
            for (let i = updatedChat.messages.length - 1; i >= 0; i--) {
              const m = updatedChat.messages[i];
              if (m?.role === "user") return m;
            }
            return undefined;
          })();
          const lastUserTransportImages = (() => {
            if (!visionOk) return [] as Array<{ filename: string; mimeType: string; data: string }>;
            if (storedFileAttachments.length > 0) return storedFileAttachments;
            return (lastUserTransportMessage?.fileAttachments ?? [])
              .filter((f: { mimeType?: string }) => f.mimeType?.startsWith("image/"))
              .map((f: { filename: string; mimeType: string; data: string }) => ({
                filename: f.filename,
                mimeType: f.mimeType,
                data: f.data,
              }));
          })();
          // Edit-resend: ingest was skipped, so the model got NO attachment
          // directive (it had to guess or list). Rebuild the id lines from the
          // persisted attachments of the message being resent.
          if (
            !attachmentInfoForModel.trim() &&
            lastUserTransportMessage &&
            ((lastUserTransportMessage.fileAttachments?.length ?? 0) > 0 ||
              (lastUserTransportMessage.pasteAttachments?.length ?? 0) > 0)
          ) {
            const lines: string[] = [];
            for (const f of lastUserTransportMessage.fileAttachments ?? []) {
              lines.push(
                `- name: "${f.filename}" | attachmentId: ${f.id} | mime: ${f.mimeType} | size: ${f.size}`,
              );
            }
            try {
              const { resolvePasteAttachmentsForMessage } = await import(
                "@/lib/chat/paste-attachment-meta"
              );
              for (const paste of resolvePasteAttachmentsForMessage(
                lastUserTransportMessage,
              )) {
                lines.push(
                  `- name: "${paste.displayName}" | attachmentId: ${paste.id} | kind: ${paste.kind} | source: user-paste`,
                );
              }
            } catch {
              // paste recovery is best-effort
            }
            if (lines.length > 0) {
              attachmentInfoForModel =
                "\n\nFILES ATTACHED to this (edited) message — already uploaded, do NOT ask the user to re-attach:\n" +
                lines.join("\n") +
                '\n\nUse read_attachment({ "attachmentId": "<id>" }) to read any of them.\n';
            }
          }
          if (
            chatMessages.length >= 2 &&
            (attachmentPaths.length > 0 ||
              attachmentInfoForModel.trim().length > 0 ||
              lastUserTransportImages.length > 0)
          ) {
            const lastUserIndex = chatMessages.length - 2;
            const lastUserMessage = chatMessages[lastUserIndex];

            if (lastUserMessage.role === "user") {
              chatMessages[lastUserIndex] = await preflight.time(
                "prepare-attachments",
                () =>
                  prepareMessageWithAttachments({
                    message: lastUserMessage,
                    attachmentInfoForModel,
                    imageAttachments: visionOk ? lastUserTransportImages : [],
                  }),
              );
            }
          }

          if (isSummarizeIntent) {
            const priorTransportId = parseInt(req.prompt.split("=")[1], 10);
            const priorEphemeral = Number.isFinite(priorTransportId)
              ? getStreamTransport(priorTransportId)
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

          /** Shared cap for length + pending-step continuations per user turn.
           *  Raised 3 → 50 so a long, legitimately-truncated (finish_reason=length)
           *  response isn't cut short; high but finite to avoid pathological runaway. */
          const STREAM_CONTINUATION_MAX = 50;

          // simpleStreamText extracted to ./chat_stream/turn-runner/simple-stream-text;
          // its enclosing captures are threaded via this deps bundle (built after
          // the assembly IIFE so systemPrompt/budgetTracker hold their final values).
          const simpleStreamTextDeps: SimpleStreamTextDeps = {
            req,
            settings,
            updatedChat,
            effectiveAppId,
            effectiveModel,
            appPath,
            engineRequestId,
            isEngineEnabled,
            isDeepContextEnabled,
            enableNativeReasoning,
            forceCollectOnWake,
            proactiveContextReminderForStream,
            modeReanchorNote,
            taskLedgerBlock,
            systemPrompt,
            budgetTracker,
            streamId,
            event,
            placeholderAssistantMessage,
            preflight,
            stopStreamForCompassLimit,
            ttftStartRef,
            abortController,
          };



          // processResponseChunkUpdate extracted to
          // ./chat_stream/turn-runner/response-chunk-update; bound to the turn
          // config here so the two callback slots keep their (args) => Promise
          // shape. Its own `fullResponse` param is the live text, not ctx.fullResponse.
          const processResponseChunkUpdate = (args: { fullResponse: string }) =>
            runProcessResponseChunkUpdate(
              { req, updatedChat, event, streamId },
              args,
            );

          // v11.1: the ask_user "breakpoint" split (segment A + fresh
          // placeholder for in-turn continuation) is gone — the turn ENDS at
          // the question and a new turn carries the continuation.

          // v12 0.1 Phase D: the vestigial "agent" chat-mode path was DELETED.
          // The UI has only emitted ask/build since work-mode.ts; legacy
          // "agent" settings rows and custom-command modeOverrides are coerced
          // to "build" (readSettings + the modeOverride accept set above). The
          // dead block carried real bugs killed by deletion: double-dispatch
          // into the build branch, no workspace injection, and no permission/
          // repetition/delegation wiring.

          ctx.filesWrittenInThisExchange = [];

          // Ask mode with workspace: read-only tools + ATLARIX_PLAN writes (approval) + exploration
          if (settings.selectedChatMode === "ask" && effectiveApp) {
            logger.log(
              `Ask tier with workspace — read-only${effectiveWorkMode === "plan" ? " + Plan tools" : ""} (approval where required)`,
            );

            const askPermissionInterceptor = new PermissionInterceptor(
              appPath,
              effectiveAppId ?? undefined,
              // Ask chats never write workspace snapshots (no snapshotTurnId);
              // Build passes its stable stream turn id instead.
              undefined,
              req.chatId,
            );
            registerInterceptor(req.chatId, askPermissionInterceptor);

            // Forward agent command output to the renderer (in-chat command card
            // + Agent terminal tab) — parity with Build mode. Ask runs read-only
            // run_command, but without this its output never reaches the UI tab.
            askPermissionInterceptor.on('terminal-output', (payload: any) => {
              feedTerminalOutput(req.chatId, payload.output ?? "");
              handleStreamActivityPulse();
              safeSend(event.sender, "terminal-output", {
                chatId: req.chatId,
                commandId: payload.operationId,
                command: payload.command,
                output: payload.output,
                status: payload.status,
                exitCode: payload.exitCode,
                background: payload.background === true,
                source: "agent",
                isPermissionBased: true,
              });
            });

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
              // Fix R: corrections short-circuit in the execute wrapper; only
              // the escalated backstop aborts here.
              if (o.kind !== "loop_abort") return;
              // Doom loop (9 consecutive byte-identical calls, corrections ignored) — wrap up.
              safeSend(event.sender, "chat:activity", {
                id: `loop-abort-${Date.now()}`,
                type: "loop_repetition_aborted",
                label: "Wrapping up — repeated action",
                detail:
                  "Repeated the same call identically — finishing with a summary of what was done.",
                status: "running",
                timestamp: Date.now(),
                chatId: req.chatId,
                toolName: o.toolName,
                loopTarget: o.target,
                loopCount: o.count,
              });
              // Interrupt the in-flight stream — the SDK's multi-step loop never
              // returns to the round boundary while the model keeps calling
              // tools. FORCE_TEXT_FINISH (vs a hard stop) lets the engine run one
              // final tools-off round so the model summarizes instead of the turn
              // dying with a stub.
              try {
                abortController.abort(
                  streamStopAbortReason(FORCE_TEXT_FINISH_STREAM_STOP),
                );
              } catch {
                /* noop */
              }
            };

            const askToolStreamOpts = () => ({
              turnId: streamTurnId,
              abortController,
              workspaceSessionId: req.workspaceSessionId ?? undefined,
              unattended: Boolean(req.automation),
            });

            // v12 S19 (closes 3.10): the 4-stage resolution pipeline
            // (registry metadata → mode allowlist → session loader →
            // capability trim, + plan-tool union + user-agent intersection)
            // lives in ONE place — resolve-toolset.ts. Both branches call it.
            const modeAllowlist = getModeToolAllowSets();
            const askResolved = resolveToolsetForSession({
              branch: "ask",
              effectiveWorkMode,
              hasWorkspace,
              workspaceIntegrationEligible:
                hasWorkspace && effectiveAppId != null,
              model: {
                name: effectiveModel?.name,
                provider: effectiveModel?.provider,
                builtinProviderId: modelClient.builtinProviderId,
              },
              userAgentTools: activeUserAgent?.tools ?? null,
              unattended: Boolean(req.automation),
            });
            const askToolsToInclude = askResolved.tools;
            const askCapabilityProfile = askResolved.capabilityProfile;
            // v13: no progressive reveal — every offered tool's schema is
            // bound upfront; the manifest lists exactly these names.
            const askOfferedNames = askToolsToInclude.map((t) => t.name);

            const askTools: ToolSet = {};
            for (const tool of askToolsToInclude) {
              askTools[tool.name] = {
                description: tool.description,
                inputSchema: normalizeToolInputSchemaForAiSdk(
                  simplifyToolParametersForProfile(
                    tool.parameters ??
                      (tool as { function?: { parameters?: unknown } }).function
                        ?.parameters,
                    askCapabilityProfile,
                  ),
                ) as never,
                // v12 0.2: typed tool outputs (screenshot media / text fallback).
                toModelOutput: (output: unknown) =>
                  buildToolModelOutput(tool.name, output, {
                    builtinProviderId: modelClient.builtinProviderId,
                    modelApiId: resolveReasoningCatalogModelId(effectiveModel),
                  }) ?? {
                    type: "text",
                    value:
                      typeof output === "string" ? output : JSON.stringify(output),
                  },
                execute: async (
                  args: any,
                  { toolCallId }: { toolCallId: string },
                ) => {
                  const askIsStream = tool.name === "stream_terminal_output";
                  // Per-invocation id (Fix 2) — see the build wrapper.
                  const toolActivityId = toolCallId;
                  let askActivityStatus: "done" | "error" = "done";
                  let toolResultForActivity: unknown;
                  // Fix: Finding 4
                  if (!askIsStream) {
                    safeSend(event.sender, "chat:tool:start", {
                      chatId: req.chatId,
                      toolId: tool.name,
                      toolCallId,
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
                      toolCallId,
                      toolArgs: args,
                    });
                  }
                  try {
                    // v14.8.10 Fix R: staged repetition guard (see build wrapper).
                    if (askAgenticRepetition.isEnabled()) {
                      const rep = askAgenticRepetition.record(tool.name, args);
                      if (rep.kind === "loop_correct") {
                        const guidance = JSON.stringify({
                          success: false,
                          loop_guidance: buildLoopCorrectionMessage(rep),
                        });
                        toolResultForActivity = guidance;
                        return guidance;
                      }
                      if (rep.kind === "loop_abort") {
                        handleAskAgenticRepetitionOutcome(rep);
                        const stopMsg = JSON.stringify({
                          success: false,
                          error:
                            "Repeated the same call identically despite corrections — wrapping up.",
                        });
                        toolResultForActivity = stopMsg;
                        return stopMsg;
                      }
                    }
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
                        const { getStreamTransport } = await import("@/lib/chat/stream-transport");
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
                            systemPromptTokens: estimateTokens(systemPrompt),
                            inputTokens: 0,
                            providerId,
                            sessionStats: { toolCallCount: 0, delegationCount: 0 },
                            // Known-good session id so the [COMPACTION MARKER] persists
                            // even when chatId is the live (negative) transport id.
                            workspaceSessionId: req.workspaceSessionId,
                            setMessages: (next) => {
                              updatedChat.messages = next as typeof updatedChat.messages;
                              const ec = getStreamTransport(req.chatId);
                              if (ec) ec.messages = next as typeof ec.messages;
                            },
                          },
                        );
                        emitModelCompactionActivity(event.sender, req.chatId, outcome, reason);
                        // Context meter: push the new model-facing size so the UI
                        // DROPS after compression, mirroring the summarize path
                        // (useContextReport keeps the prior contextWindow). Without
                        // this the meter stayed at the pre-compression count.
                        if (outcome.success && outcome.tokensAfter > 0) {
                          if (process.env.ATLARIX_DIAG_146 === "1") {
                            logger.info(
                              `[DIAG_146] compress(ask) chat=${req.chatId} ${outcome.tokensBefore}→${outcome.tokensAfter} persisted=${outcome.summaryPersisted} → emit context-report dispatchedTokens=${outcome.tokensAfter}`,
                            );
                          }
                          safeSend(event.sender, "chat:context-report", {
                            chatId: req.chatId,
                            sections: [],
                            trimReport: [],
                            dispatchedTokens: outcome.tokensAfter,
                          } satisfies ChatContextReport);
                        }
                        return JSON.stringify({
                          success: outcome.success,
                          reason: outcome.reason,
                          tokensBefore: outcome.tokensBefore,
                          tokensAfter: outcome.tokensAfter,
                          tokensFreed: outcome.tokensFreed,
                          strategy: outcome.strategy,
                          summary: outcome.summary,
                          status: outcome.status,
                          summaryPersisted: outcome.summaryPersisted,
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
                          toolCallId,
                          toolName: label,
                          toolArgs: execArgs,
                        });
                        return () => {
                          safeSend(event.sender, "chat:tool:end", {
                            chatId: req.chatId,
                            toolCallId,
                          });
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
                      { onAskUserEndTurn: () => { ctx.askUserEndedTurn = true; } },
                    );
                    if (askUserResolvedEarly !== null) {
                      return askUserResolvedEarly;
                    }

                    if (tool.name === "plan") {
                      try {
                        const envelope =
                          typeof result === "string" ? JSON.parse(result) : result;
                        // runToolExecute wraps tool output in the ToolRegistry
                        // {success, result, cost} envelope — unwrap to reach
                        // the tool's own {success, planId} payload.
                        const parsed =
                          envelope?.result && typeof envelope.result === "object"
                            ? envelope.result
                            : envelope;
                        if (parsed?.success && parsed?.planId) {
                          const { emitPlanArtifactUpdated } = await import(
                            "@/ipc/utils/emit_plan_artifact"
                          );
                          const {
                            getPlanArtifact,
                            planArtifactMarker,
                          } = await import("@/lib/plans/plan-artifacts");
                          const marker = planArtifactMarker(parsed.planId);
                          if (!ctx.fullResponse.includes(marker)) {
                            ctx.fullResponse = `${ctx.fullResponse.trimEnd()}\n\n${marker}\n`;
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
                            // v14.7: BLOCK mid-loop until the user decides (no
                            // park); Stop (abort) cancels and unwinds the round.
                            const outcome =
                              await askPermissionInterceptor.waitForApproval(operationId, {
                                abortSignal: abortController.signal,
                              });
                            approved = outcome === "approved";
                          }

                          if (approved) {
                            const execResult = askPermissionInterceptor.getExecutionResult(operationId);
                            logger.log(`[Ask Mode] Permission approved: ${operationId}`);

                            const preview = permRequest.preview as { path?: string; paths?: string[] };
                            if (permRequest.operation === "write_multiple_files" && preview.paths?.length) {
                              ctx.filesWrittenInThisExchange.push(...preview.paths);
                            } else if (preview.path) {
                              ctx.filesWrittenInThisExchange.push(preview.path);
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
                              message: `Successfully ${(permRequest.operation === "write_file" || permRequest.operation === "edit_file") ? "wrote" : "executed"} ${(permRequest.preview as { path?: string }).path || "operation"}`,
                              path: execResult.path,
                              output: execResult.output,
                              // Persist the command + exit code so the thread renders
                              // a command card (Ask mode is read-only: run_command only).
                              ...(execResult.command ? { command: execResult.command } : {}),
                              ...(execResult.exitCode !== undefined ? { exitCode: execResult.exitCode } : {}),
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

                    // v12 0.2: redacted display copy + structured screenshot
                    // return (media part via toModelOutput).
                    toolResultForActivity = redactToolMediaForDisplay(result);
                    // v13.8: a screenshot payload (browser_inspect mode:"screenshot"
                    // or legacy browser_screenshot) returns the STRUCTURED object so
                    // toModelOutput can emit a native media part; detect by shape so
                    // browser_inspect's text/snapshot results keep the string contract.
                    if (extractImageMedia(result)) {
                      return result;
                    }
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
                      safeSend(event.sender, "chat:tool:end", {
                        chatId: req.chatId,
                        toolCallId,
                      });
                      safeSend(event.sender, "chat:activity", {
                        id: toolActivityId,
                        type: "tool_use",
                        label: getToolActivityLabel(tool.name),
                        status: askActivityStatus,
                        timestamp: Date.now(),
                        chatId: req.chatId,
                        toolName: tool.name,
                        toolCallId,
                        toolArgs: args,
                        ...(activityDetail ? { detail: activityDetail } : {}),
                        ...(resultText ? { resultText } : {}),
                      });
                    }
                  }
                },
              };
            }

            // v12 2.1/7A: the delegation-surface decision (trim + user-agent
            // gates) is computed inside resolveToolsetForSession (S19).
            if (askResolved.delegationAllowed) {
              attachDelegationToolsToSet(askTools, {
                sender: event.sender,
                chatId: req.chatId,
                effectiveWorkMode,
                workspacePath: appPath,
                workspaceId: effectiveAppId ?? undefined,
                turnId: streamTurnId,
                safeSend,
                onDelegated: (agentId) => ctx.delegatedAgentsThisTurn.push(agentId),
                getDelegationCount: () => ctx.delegationsStartedThisTurn,
                onDelegationStart: () => {
                  ctx.delegationsStartedThisTurn += 1;
                },
                tryAcquireDedupeKey: (key) => {
                  if (ctx.inFlightDelegationKeys.has(key)) return false;
                  ctx.inFlightDelegationKeys.add(key);
                  return true;
                },
                releaseDedupeKey: (key) => {
                  ctx.inFlightDelegationKeys.delete(key);
                },
              });
            }

            // Pass 7: MCP tools are no longer pre-merged for workspace Ask chats.
            // The model calls list_available_mcps + mcp_call from the registry on demand.
            logger.log(
              `Ask tier: ${Object.keys(askTools).length} tools (read-only${effectiveWorkMode === "plan" ? " + Plan tools" : ""}; MCP via list_available_mcps + mcp_call)`,
            );

            let askStreamMessages: ModelMessage[] = [...chatMessages];
            askAgenticRepetition.setEnabled(true);
            // v12 0.1: the unified runAgentTurn engine with the ask profile
            // (singleRound: a completed round ends the turn — the old outer
            // ask loop only ever served truncation continuations; deleted at
            // the 0.1 close-out). Ask gains the 0.2 native turn envelope via
            // the shared tail (B2). Known delta vs the legacy loop:
            // truncation-continuation rounds skip mid-loop compaction/
            // escalation (rare path).
            {
              const turnResult = await runAgentTurn(
                {
                  mode: "ask",
                  loopLogLabel: "[Ask tier]",
                  compactionLabel: "Ask tier",
                  proseOnlyStreakMax: undefined,
                  singleRound: true,
                  escalationMode:
                    effectiveWorkMode === "plan" ? "plan" : "ask",
                  tools: askTools,
                  repetition: askAgenticRepetition,
                  buildRoundSystemPrompt: async () => {
                    const askParts = constructSystemPromptParts({
                      chatMode: "ask",
                      effectiveWorkMode: modeBlockKey,
                      contextSize: await getContextWindow(
                        effectiveModel,
                        req.chatId,
                      ),
                      enableTurboEditsV2: false,
                      hasWorkspace,
                      registeredToolNames: askOfferedNames,
                      ...promptIdentityOpts,
                    });
                    const askHeader = activeUserAgent
                      ? `${renderUserAgentSystemBlock(activeUserAgent)}\n\n${askParts.stableHeader}`
                      : askParts.stableHeader;
                    return {
                      systemPromptOverride: askHeader,
                      dynamicSystemTail: askParts.dynamicTail,
                    };
                  },
                },
                {
                  chatId: req.chatId,
                  settings,
                  abortController,
                  continuationTurnId: String(placeholderAssistantMessage.id),
                  streamTurnId,
                  tierLimit: modelContextResolved.tierLimit,
                  contextWindowTokens,
                  maxContinuationAttempts: STREAM_CONTINUATION_MAX,
                  taskLedger: taskLedgerBlock,
                  permissionInterceptor: askPermissionInterceptor,
                  seedMessages: askStreamMessages,
                  nativeTurnMessages: ctx.nativeTurnMessages,
                  initialFullResponse: ctx.fullResponse,
                  safeSend: (channel, payload) =>
                    safeSend(event.sender, channel, payload),
                  emitCompactionActivity: emitCompactionMirroredActivity(
                    event.sender,
                    req.chatId,
                  ),
                  simpleStreamText: (opts) =>
                    simpleStreamText(ctx, simpleStreamTextDeps, {
                      chatMessages: opts.chatMessages,
                      modelClient,
                      tools: opts.tools as ToolSet,
                      systemPromptOverride: opts.systemPromptOverride,
                      dynamicSystemTail: opts.dynamicSystemTail,
                      files: files,
                      repetition: askAgenticRepetition,
                      abortSignalOverride: opts.abortSignal,
                    }),
                  runStreamRound: (
                    params: Parameters<
                      typeof runStreamRoundWithEmptyOutputRetry
                    >[2],
                  ) => runStreamRoundWithEmptyOutputRetry(ctx, { event }, params),
                  processResponseChunkUpdate,
                  onFirstTextDelta: logTtftOnce,
                  onStreamStall: handleStreamStall,
                  onToolInputProgress: handleToolInputProgress,
                  onToolInputDelta: handleToolInputDelta,
                  onStreamActivityPulse: handleStreamActivityPulse,
                  // Legacy ask streams deltas unsanitized (native-only mode —
                  // no hallucinated-XML stripping, unlike build).
                  sanitizeTextDelta: (t) => t,
                  applyTierEscalation,
                },
              );
              ctx.fullResponse = turnResult.fullResponse;
              ctx.turnParked = turnResult.parked;
              ctx.turnForcedTextFinish = turnResult.forcedTextFinish;
            }
            askAgenticRepetition.setEnabled(false);
          } else {
            // BUILD MODE - Native tool calling (like Agent mode)
            // AI has access to all workspace tools via function calling
            // Permission interceptor buffers write operations for user approval
            logger.log("Build mode with native tool calling + permission system");

            // Per-turn revert is provided by the incremental shadow-git snapshot
            // system (captureSnapshot via the PermissionInterceptor, staged per
            // approved write). The former per-exchange full-copy createSnapshot
            // (workspace-snapshots.ts) was removed from the hot path — it walked +
            // read up to 500 files into a SQLite row every turn, dominated TTFT,
            // and its result was never read (its list/restore IPC is unwired).

            const workspacePath = appPath;
            let workspaceOverride: { path: string; id: number } | null = null;
            // v12 S19 (closes 3.10): single resolution pipeline — see the
            // ask-branch note and resolve-toolset.ts.
            const buildResolved = resolveToolsetForSession({
              branch: "build",
              effectiveWorkMode,
              hasWorkspace,
              workspaceIntegrationEligible:
                hasWorkspace && effectiveAppId != null,
              model: {
                name: effectiveModel?.name,
                provider: effectiveModel?.provider,
                builtinProviderId: modelClient.builtinProviderId,
              },
              userAgentTools: activeUserAgent?.tools ?? null,
              unattended: Boolean(req.automation),
            });
            const buildToolsToInclude = buildResolved.tools;
            const buildCapabilityProfile = buildResolved.capabilityProfile;
            // Create permission interceptor for this session
            const permissionInterceptor = new PermissionInterceptor(
              workspacePath,
              effectiveAppId ?? undefined,
              streamTurnId,
              req.chatId,
            );

            // Register interceptor for IPC handlers (so UI can approve/reject)
            registerInterceptor(req.chatId, permissionInterceptor);

            const autonomousTurnId = String(placeholderAssistantMessage.id);

            // Listen for terminal output events and forward to frontend; v3.9: also feed to StreamManager for stream_terminal_output
            permissionInterceptor.on('terminal-output', (payload: any) => {
              feedTerminalOutput(req.chatId, payload.output ?? "");
              // Streaming output IS activity — pulse so the inline status doesn't
              // falsely flip to "Reconnecting…" during a long/quiet command.
              handleStreamActivityPulse();
              safeSend(event.sender, "terminal-output", {
                chatId: req.chatId,
                commandId: payload.operationId,
                command: payload.command,
                output: payload.output,
                status: payload.status,
                exitCode: payload.exitCode,
                background: payload.background === true,
                source: "agent",
                isPermissionBased: true, // Don't force-switch to terminal tab
              });
              logger.log(`[Build Mode] Terminal output sent: ${payload.command} (${payload.status})`);
            });

            const recentCompletedBuildToolNames: string[] = [];

            const agenticRepetition = createAgenticRepetitionState();
            const handleAgenticRepetitionOutcome = (o: AgenticRepetitionOutcome) => {
              // Fix R: corrections are handled in the execute wrapper (synthetic
              // tool result, no abort). Only the escalated backstop aborts here.
              if (o.kind !== "loop_abort") return;
              // Doom loop (9 consecutive byte-identical calls, corrections ignored) — wrap up.
              safeSend(event.sender, "chat:activity", {
                id: `loop-abort-${Date.now()}`,
                type: "loop_repetition_aborted",
                label: "Wrapping up — repeated action",
                detail:
                  "Repeated the same call identically — finishing with a summary of what was done and what remains.",
                status: "running",
                timestamp: Date.now(),
                chatId: req.chatId,
                toolName: o.toolName,
                loopTarget: o.target,
                loopCount: o.count,
              });
              // Interrupt the in-flight stream — the SDK's multi-step loop never
              // returns to the round boundary while the model keeps calling
              // tools. FORCE_TEXT_FINISH (vs a hard stop) lets the engine run one
              // final tools-off round so the model summarizes instead of the turn
              // dying with a stub.
              try {
                abortController.abort(
                  streamStopAbortReason(FORCE_TEXT_FINISH_STREAM_STOP),
                );
              } catch {
                /* noop */
              }
            };

            const tools: ToolSet = {};
            for (const toolMeta of buildToolsToInclude) {
              const toolName = toolMeta.name;
              tools[toolName] = {
                description: toolMeta.description,
                inputSchema: aiJsonSchema(
                  sanitizeJsonSchemaForProvider(
                    simplifyToolParametersForProfile(
                      toolMeta.parameters ?? { type: "object", properties: {} },
                      buildCapabilityProfile,
                    ),
                  ),
                ),
                // v12 0.2: typed tool outputs — screenshots become media
                // content parts on vision providers; everything else keeps
                // today's text behavior.
                toModelOutput: (output: unknown) =>
                  buildToolModelOutput(toolName, output, {
                    builtinProviderId: modelClient.builtinProviderId,
                    modelApiId: resolveReasoningCatalogModelId(effectiveModel),
                  }) ?? {
                    type: "text",
                    value:
                      typeof output === "string" ? output : JSON.stringify(output),
                  },
                execute: async (
                  args: any,
                  { toolCallId }: { toolCallId: string },
                ) => {
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
                  // Per-invocation id (Fix 2): key the UI thread item by the AI
                  // SDK's toolCallId, NOT the tool name — so two calls of the
                  // same tool render as two cards (no merge/reorder/rejump). The
                  // matching chat:tool:end + activity-done legs echo the same id.
                  const toolActivityId = toolCallId;
                  let activityStatus: "done" | "error" = "done";
                  let toolResultForActivity: unknown;
                  const isStreamTool = toolName === "stream_terminal_output";
                  // Fix: Finding 4 — status line (stream tools use inner _sendToolActivity only)
                  const uiToolLabel = getToolActivityLabel(toolName);
                  if (!isStreamTool) {
                    safeSend(event.sender, "chat:tool:start", {
                      chatId: req.chatId,
                      toolId: toolName,
                      toolCallId,
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
                    toolCallId,
                    toolArgs: args,
                  });
                  try {
                    // v14.8.10 Fix R: staged repetition guard, checked BEFORE
                    // execution with the FULL byte-identical args (the old
                    // post-execution permission-path record keyed edit_file by
                    // {path} only, so 3 consecutive different edits to one file
                    // tripped the doom loop). A repeated call is answered with
                    // corrective guidance INSTEAD of being executed; only the
                    // 9th identical call fires the FORCE_TEXT_FINISH backstop.
                    if (agenticRepetition.isEnabled()) {
                      const rep = agenticRepetition.record(toolName, args);
                      if (rep.kind === "loop_correct") {
                        safeSend(event.sender, "chat:activity", {
                          id: `loop-correct-${toolCallId}`,
                          type: "loop_detected",
                          label: "Nudged — repeated action",
                          detail: `Same ${toolName} call repeated ${rep.count}× — steered instead of executed.`,
                          status: "done",
                          timestamp: Date.now(),
                          chatId: req.chatId,
                          toolName,
                        });
                        const guidance = JSON.stringify({
                          success: false,
                          loop_guidance: buildLoopCorrectionMessage(rep),
                        });
                        toolResultForActivity = guidance;
                        return guidance;
                      }
                      if (rep.kind === "loop_abort") {
                        handleAgenticRepetitionOutcome(rep);
                        const stopMsg = JSON.stringify({
                          success: false,
                          error:
                            "Repeated the same call identically despite corrections — wrapping up.",
                        });
                        toolResultForActivity = stopMsg;
                        return stopMsg;
                      }
                    }
                    // A per-turn workModeOverride (resend/edit, background
                    // agents) wins over the live persisted preference; only
                    // fall back to the live re-read (mid-turn picker change)
                    // when there's no explicit override for this turn.
                    const buildLiveWorkMode: WorkMode =
                      req.workModeOverride ??
                      readSettings().workModePreference ??
                      effectiveWorkMode;
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
                        const { getStreamTransport } = await import("@/lib/chat/stream-transport");
                        const msgList = updatedChat.messages as { id: number; role: string; content: string }[];
                        const outcome = await executeCompressContext(
                          { reason },
                          {
                            chatId: req.chatId,
                            messages: msgList.map((m) => ({ id: m.id, role: m.role, content: m.content || "" })),
                            systemPromptTokens: estimateTokens(systemPrompt),
                            inputTokens: 0,
                            providerId,
                            sessionStats: { toolCallCount: 0, delegationCount: 0 },
                            // Known-good session id so the [COMPACTION MARKER] persists
                            // even when chatId is the live (negative) transport id.
                            workspaceSessionId: req.workspaceSessionId,
                            // C-1: parity with the Ask-mode site — without this the
                            // Build-mode compress never replaced the live transport
                            // messages, so the next dispatch still used full history.
                            setMessages: (next) => {
                              updatedChat.messages = next as typeof updatedChat.messages;
                              const ec = getStreamTransport(req.chatId);
                              if (ec) ec.messages = next as typeof ec.messages;
                            },
                          },
                        );

                        emitModelCompactionActivity(event.sender, req.chatId, outcome, reason);

                        // Context meter: push the new model-facing size so the UI
                        // DROPS after compression, mirroring the summarize path
                        // (useContextReport keeps the prior contextWindow). Without
                        // this the meter stayed at the pre-compression count.
                        if (outcome.success && outcome.tokensAfter > 0) {
                          if (process.env.ATLARIX_DIAG_146 === "1") {
                            logger.info(
                              `[DIAG_146] compress(build) chat=${req.chatId} ${outcome.tokensBefore}→${outcome.tokensAfter} persisted=${outcome.summaryPersisted} → emit context-report dispatchedTokens=${outcome.tokensAfter}`,
                            );
                          }
                          safeSend(event.sender, "chat:context-report", {
                            chatId: req.chatId,
                            sections: [],
                            trimReport: [],
                            dispatchedTokens: outcome.tokensAfter,
                          } satisfies ChatContextReport);
                        }

                        return JSON.stringify({
                          success: outcome.success,
                          reason: outcome.reason,
                          tokensBefore: outcome.tokensBefore,
                          tokensAfter: outcome.tokensAfter,
                          tokensFreed: outcome.tokensFreed,
                          strategy: outcome.strategy,
                          summary: outcome.summary,
                          status: outcome.status,
                          summaryPersisted: outcome.summaryPersisted,
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
                          toolCallId,
                          toolName: label,
                          toolArgs: executeArgs,
                        });
                        return () => {
                          safeSend(event.sender, "chat:tool:end", {
                            chatId: req.chatId,
                            toolCallId,
                          });
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
                      { onAskUserEndTurn: () => { ctx.askUserEndedTurn = true; } },
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
                      // DIAG_146 (bug 8): time the main-side permission path
                      // (preflight + buffer + UI enrich/diff) for slow edit cards.
                      const __permEditT0 = Date.now();
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
                          ctx.filesWrittenInThisExchange.push(...preview.paths);
                        } else if (preview.path) {
                          ctx.filesWrittenInThisExchange.push(preview.path);
                        }
                      };

                      const jsonAfterSuccessfulExec = (execResult: {
                        path?: string;
                        output?: string;
                        exitCode?: number;
                        error?: string;
                        operation?: string;
                        oldContent?: string;
                        newContent?: string;
                        command?: string;
                        verified?: boolean;
                      }) => {
                        if (!permRequest) return "";
                        pushWrittenPaths();
                        // Self-review state: accumulate the running true/false of
                        // each write's disk re-check under the turn. A consolidated
                        // nudge fires only at the task_complete gate (zero tokens on
                        // the happy path); a later good write of the same path clears
                        // its prior failure.
                        if (
                          execResult.path &&
                          (permRequest.operation === "write_file" ||
                            permRequest.operation === "edit_file")
                        ) {
                          if (execResult.verified === false) {
                            recordUnverifiedEdit(streamTurnId, execResult.path);
                          } else {
                            clearUnverifiedEdit(streamTurnId, execResult.path);
                          }
                        }
                        // v14.8.10 Fix R: the permission-path repetition record
                        // moved to the execute-wrapper top (full byte-identical
                        // args). The old record here keyed edit_file/write_file
                        // by {path} ONLY — 3 consecutive DIFFERENT edits to one
                        // file read as a doom loop (observed live force-finish).
                        recordBuildToolLedger(permRequest.operation, {
                          path: (permRequest.preview as { path?: string }).path,
                          success: true,
                          output: execResult.output?.slice(0, 200),
                        });
                        const output = execResult.output || "";
                        // The chat-thread cards need: a write/edit → a diff; a
                        // command → command + exit code. v13.8.1: the diff content
                        // is NO LONGER echoed into the model result (the model's own
                        // tool-call args already hold the content — echoing it is a
                        // pure duplicate). The completed/persisted card renders the
                        // diff from those args (see buildDiffView). We send only tiny
                        // line COUNTS so the collapsed summary stays accurate without
                        // costing transcript tokens.
                        const isFileWrite =
                          permRequest.operation === "write_file" ||
                          permRequest.operation === "edit_file" ||
                          permRequest.operation === "write_multiple_files";
                        const displayFields: Record<string, unknown> = isFileWrite
                          ? (() => {
                              const oldC =
                                typeof execResult.oldContent === "string" ? execResult.oldContent : "";
                              const newC =
                                typeof execResult.newContent === "string" ? execResult.newContent : "";
                              let added = 0;
                              let removed = 0;
                              try {
                                const hunks = computeDiffHunks(oldC, newC, 0);
                                added = hunks.reduce((a, h) => a + h.addedCount, 0);
                                removed = hunks.reduce((a, h) => a + h.removedCount, 0);
                              } catch {
                                /* counts best-effort */
                              }
                              return {
                                ...(execResult.operation ? { operation: execResult.operation } : {}),
                                added,
                                removed,
                              };
                            })()
                          : permRequest.operation === "run_command"
                            ? {
                                ...(execResult.command ? { command: execResult.command } : {}),
                                ...(execResult.exitCode !== undefined ? { exitCode: execResult.exitCode } : {}),
                              }
                            : {};
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
                            ...displayFields,
                          });
                        }
                        return JSON.stringify({
                          success: true,
                          message: `Successfully ${(permRequest.operation === "write_file" || permRequest.operation === "edit_file") ? "wrote" : "executed"} ${(permRequest.preview as { path?: string }).path || "operation"}`,
                          path: execResult.path,
                          output: execResult.output,
                          ...displayFields,
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
                            // Auto-approved write → no preview reached the renderer;
                            // push the diff content display-only so the card is accurate.
                            emitAutoApprovedWritePreview(
                              event.sender,
                              req.chatId,
                              permRequest.operation,
                              execResult,
                            );
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
                      const __enrichT0 = Date.now();
                      const __enriched = enrichPermissionRequestForUi(permRequest, effectiveAppId);
                      if (process.env.ATLARIX_DIAG_146 === "1") {
                        const prev = permRequest.preview as { path?: string; command?: string };
                        logger.info(
                          `[DIAG_146] perm-edit op=${permRequest.operation} target=${prev.path ?? prev.command ?? ""} preflight+buffer=${__enrichT0 - __permEditT0}ms enrich/diff=${Date.now() - __enrichT0}ms (then awaits the user)`,
                        );
                      }
                      safeSend(event.sender, "permission-request", {
                        chatId: req.chatId,
                        operationId,
                        request: __enriched,
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
                        // v14.7: BLOCK mid-loop until the user decides — the turn
                        // stays live (Stop button shows, no premature "done").
                        // Stop (abort) cancels the wait and unwinds the round.
                        const outcome = await permissionInterceptor.waitForApproval(
                          operationId,
                          { abortSignal: abortController.signal },
                        );
                        const approved = outcome === "approved";
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
                        // Stop pressed during the wait → re-throw so streamText
                        // unwinds the round (don't feed the model a tool result).
                        if (abortController.signal.aborted) throw error;
                        logger.error(`[Build Mode] Permission error: ${operationId}`, error);
                        return JSON.stringify({
                          success: false,
                          error: `Permission request failed: ${error instanceof Error ? error.message : String(error)}`,
                        });
                      }
                    }
                  }

                    // Not a permission request - return result directly.
                    // (Repetition is recorded once at the wrapper top — Fix R.)
                    recordBuildToolLedger(toolName, result);
                    // v12 0.2: display copy never carries base64 (cards show a
                    // size placeholder instead of megabytes of image data).
                    toolResultForActivity = redactToolMediaForDisplay(result);
                    // Screenshot returns the STRUCTURED object so toModelOutput
                    // can emit a native media content part; other tools keep
                    // the string contract. v13.8: detect by shape so screenshots
                    // from browser_inspect(mode:"screenshot") are covered while its
                    // text/snapshot results stay stringified.
                    if (extractImageMedia(result)) {
                      return result;
                    }
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
                      safeSend(event.sender, "chat:tool:end", {
                        chatId: req.chatId,
                        toolCallId,
                      });
                      safeSend(event.sender, "chat:activity", {
                        id: toolActivityId,
                        type: "tool_use",
                        label: getToolActivityLabel(toolName),
                        status: activityStatus,
                        timestamp: Date.now(),
                        chatId: req.chatId,
                        toolName,
                        toolCallId,
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

            // v12 2.1/7A: delegation-surface decision computed in
            // resolveToolsetForSession (S19).
            if (buildResolved.delegationAllowed) {
              attachDelegationToolsToSet(tools, {
                sender: event.sender,
                chatId: req.chatId,
                effectiveWorkMode,
                workspacePath: workspacePath || undefined,
                workspaceId: effectiveAppId ?? undefined,
                turnId: autonomousTurnId,
                safeSend,
                onDelegated: (agentId) => ctx.delegatedAgentsThisTurn.push(agentId),
                getDelegationCount: () => ctx.delegationsStartedThisTurn,
                onDelegationStart: () => {
                  ctx.delegationsStartedThisTurn += 1;
                },
                tryAcquireDedupeKey: (key) => {
                  if (ctx.inFlightDelegationKeys.has(key)) return false;
                  ctx.inFlightDelegationKeys.add(key);
                  return true;
                },
                releaseDedupeKey: (key) => {
                  ctx.inFlightDelegationKeys.delete(key);
                },
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
                recordToolOnLedger(streamTurnId, {
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
            // Prose-only-streak break DISABLED (Infinity): the loop no longer
            // ends a turn just because the model replied without tools or
            // <task_complete> for N rounds — that was an unintended limit that
            // abandoned tasks mid-way. The "continue" nudge below still fires;
            // the turn ends only on <task_complete>, abort, or the model
            // genuinely yielding. (Ask tier's proseOnlyStreakMax == null branch
            // is unaffected.)
            const AGENTIC_PROSE_ONLY_MAX_DEFAULT = Number.POSITIVE_INFINITY;
            const AGENTIC_PROSE_ONLY_MAX_REASONING = Number.POSITIVE_INFINITY;
            const isReasoningModelForCap = (() => {
              try {
                const cap = detectReasoningCapability(
                  resolveReasoningCatalogModelId(effectiveModel),
                  modelClient.builtinProviderId,
                );
                return (
                  cap.useOpenRouterReasoning ||
                  cap.useGoogleThoughts ||
                  cap.useOpenAiReasoningSummary
                );
              } catch {
                return false;
              }
            })();
            const AGENTIC_PROSE_ONLY_MAX = isReasoningModelForCap
              ? AGENTIC_PROSE_ONLY_MAX_REASONING
              : AGENTIC_PROSE_ONLY_MAX_DEFAULT;
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
            // v12 0.1: text-tool execution extracted to ONE implementation shared
            // by the legacy loop and the unified engine (profile.executeTextToolCalls).
            // Closure over the build-branch scope (tools / interceptor / gates /
            // ctx.filesWrittenInThisExchange / ctx.askUserEndedTurn) is intentional.
            const execBuildTextToolCalls = async (
              textToolCalls: Array<{ toolName: string; args: Record<string, unknown> }>,
            ): Promise<{
              iterationResults: Array<{ tool: string; result: string }>;
              hasPermissionRequest: boolean;
            }> => {
                // Execute text-based tools. When all are read-only, run in parallel (Phase 5).
                const iterationResults: { tool: string; result: string }[] = [];
                let hasPermissionRequest = false; // native carry-forward happens at the call site

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

                for (let i = 0; i < textToolCalls.length; i++) {
                  const toolCall = textToolCalls[i];
                  // v14.8.10 Fix R: staged repetition guard, pre-execution (see
                  // the native build wrapper). Replaces the old success-only
                  // post-execution record — identical FAILING retries are the
                  // loop we most need to steer.
                  if (agenticRepetition.isEnabled()) {
                    const rep = agenticRepetition.record(
                      toolCall.toolName,
                      toolCall.args,
                    );
                    if (rep.kind === "loop_correct") {
                      iterationResults.push({
                        tool: toolCall.toolName,
                        result: JSON.stringify({
                          success: false,
                          loop_guidance: buildLoopCorrectionMessage(rep),
                        }),
                      });
                      continue;
                    }
                    if (rep.kind === "loop_abort") {
                      handleAgenticRepetitionOutcome(rep);
                      iterationResults.push({
                        tool: toolCall.toolName,
                        result: JSON.stringify({
                          success: false,
                          error:
                            "Repeated the same call identically despite corrections — wrapping up.",
                        }),
                      });
                      continue;
                    }
                  }
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
                      { onAskUserEndTurn: () => { ctx.askUserEndedTurn = true; } },
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
                            ctx.filesWrittenInThisExchange.push(...preview.paths);
                          } else if (preview.path) {
                            ctx.filesWrittenInThisExchange.push(preview.path);
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
                              emitAutoApprovedWritePreview(
                                event.sender,
                                req.chatId,
                                permRequest.operation,
                                execResult,
                              );
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
                            // v14.7: BLOCK mid-loop until the user decides (no
                            // park); Stop (abort) cancels and unwinds the round.
                            const outcome = await permissionInterceptor.waitForApproval(
                              operationId,
                              { abortSignal: abortController.signal },
                            );
                            if (outcome === "approved") {
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
                            if (abortController.signal.aborted) throw error;
                            iterationResults.push({
                              tool: toolCall.toolName,
                              result: JSON.stringify({
                                success: false,
                                error: `Permission error: ${error instanceof Error ? error.message : String(error)}`,
                              }),
                            });
                          }
                        }
                      }
                    } else {
                      const resultStr = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
                      iterationResults.push({ tool: toolCall.toolName, result: resultStr });
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
                return { iterationResults, hasPermissionRequest };
            };

              // v12 0.1: the extracted runAgentTurn engine — a faithful
              // control-flow port of the legacy build for(;;) loop (deleted
              // at the 0.1 close-out after the eval matrix proved parity in
              // both flag states).
              {
                const turnResult = await runAgentTurn(
                  {
                    mode: "build",
                    loopLogLabel: "[Agentic Loop]",
                    compactionLabel: "Agentic Loop",
                    proseOnlyStreakMax: AGENTIC_PROSE_ONLY_MAX,
                    escalationMode:
                      effectiveWorkMode === "plan"
                        ? "plan"
                        : effectiveWorkMode === "build"
                          ? "build"
                          : "agent",
                    tools,
                    repetition: agenticRepetition,
                    buildRoundSystemPrompt: () => systemPrompt,
                    detectTextToolCalls: (fr) =>
                      useTextToolFallback && containsTextToolCall(fr)
                        ? (parseTextToolCalls(fr) as Array<{
                            toolName: string;
                            args: Record<string, unknown>;
                          }>)
                        : null,
                    executeTextToolCalls: (calls) =>
                      execBuildTextToolCalls(
                        calls as Array<{ toolName: string; args: Record<string, unknown> }>,
                      ),
                    stripTextToolXML: stripToolCallXML,
                    // v12 2.2/7B: workspace `stop` hooks gate <task_complete>
                    // ("require tests before done"). Attached only when the
                    // workspace declares stop hooks (cheap pre-check).
                    ...(appPath && hasStopHooks(appPath)
                      ? { taskCompleteGate: () => runStopHooks(appPath) }
                      : {}),
                    // v14.8.9 continue-until-done: drive an active session plan to
                    // completion (self-gates on plan existence + pending steps).
                    // NOT in plan mode: there the plan itself is the deliverable —
                    // a fresh plan's steps are pending by construction and the mode
                    // has no build tools, so the nudge reads as "proceed without
                    // the user" (observed: model started implementing right after
                    // presenting the plan).
                    ...(effectiveWorkMode !== "plan"
                      ? {
                          planCompletionGate: () =>
                            getPlanCompletionFeedback(req.workspaceSessionId),
                        }
                      : {}),
                  },
                  {
                    chatId: req.chatId,
                    settings,
                    abortController,
                    continuationTurnId: String(placeholderAssistantMessage.id),
                    streamTurnId,
                    tierLimit: modelContextResolved.tierLimit,
                    contextWindowTokens,
                    maxContinuationAttempts: STREAM_CONTINUATION_MAX,
                    taskLedger: taskLedgerBlock,
                    permissionInterceptor,
                    seedMessages: chatMessages,
                    nativeTurnMessages: ctx.nativeTurnMessages,
                    initialFullResponse: ctx.fullResponse,
                    safeSend: (channel, payload) =>
                      safeSend(event.sender, channel, payload),
                    emitCompactionActivity: emitCompactionMirroredActivity(
                      event.sender,
                      req.chatId,
                    ),
                    simpleStreamText: (opts) =>
                      simpleStreamText(ctx, simpleStreamTextDeps, {
                        chatMessages: opts.chatMessages,
                        modelClient,
                        tools: opts.tools as ToolSet,
                        systemPromptOverride: opts.systemPromptOverride,
                        dynamicSystemTail: opts.dynamicSystemTail,
                        files: files,
                        repetition: agenticRepetition,
                        abortSignalOverride: opts.abortSignal,
                        maxStepsPerRound: opts.maxStepsPerRound,
                      }),
                    runStreamRound: (
                    params: Parameters<
                      typeof runStreamRoundWithEmptyOutputRetry
                    >[2],
                  ) => runStreamRoundWithEmptyOutputRetry(ctx, { event }, params),
                    processResponseChunkUpdate,
                    onFirstTextDelta: logTtftOnce,
                    onStreamStall: handleStreamStall,
                    onToolInputProgress: handleToolInputProgress,
                    onToolInputDelta: handleToolInputDelta,
                    onStreamActivityPulse: handleStreamActivityPulse,
                    sanitizeTextDelta: stripHallucinatedAtlarixToolTagsFromDelta,
                    applyTierEscalation,
                  },
                );
                ctx.fullResponse = turnResult.fullResponse;
                agenticIteration = turnResult.iterations;
                totalToolExecutions = turnResult.totalToolExecutions;
                ctx.turnParked = turnResult.parked;
                ctx.turnForcedTextFinish = turnResult.forcedTextFinish;
              }

              ctx.fullResponse = stripToolCallXML(ctx.fullResponse);

              // Structured metrics logging
              logger.info(`[Agentic Loop] Completed:`, {
                chatId: req.chatId,
                iterations: agenticIteration,
                toolsExecuted: totalToolExecutions,
                durationMs: Date.now() - loopStartTime,
                completedNaturally: !ctx.turnParked,
              });
              ctx.hadToolCallsOrPermissions =
                totalToolExecutions > 0 || permissionInterceptor.getAllOperationsCount() > 0;
              // ═══════════════════════════════════════════════════════════════

            } catch (streamError) {
              const stopSentinel = abortReasonSentinel(
                abortController.signal.reason,
              );
              const ledgerCompleteStop =
                ctx.askUserEndedTurn ||
                stopSentinel === ASK_USER_STREAM_STOP;
              if (abortController.signal.aborted && !ledgerCompleteStop) {
                const chatId = req.chatId;
                const partialResponse = partialResponses.get(req.chatId);
                // If we have a partial response, save it to the database
                if (partialResponse) {
                  try {
                    const stopNote =
                      stopSentinel === COMPASS_LIMIT_STREAM_STOP
                        ? "[Stopped — monthly Atlarix Core token limit reached]"
                        : stopSentinel === LOOP_REPETITION_STREAM_STOP
                          ? "[Repeated action — task stopped. Review the activity log and send a message to continue.]"
                          : "[Response cancelled by user]";
                    const cancelledContent = `${partialResponse}

${stopNote}`;
                    const { appendTransportMessage } = await import("@/lib/chat/stream-transport");
                    appendTransportMessage(req.chatId, {
                      role: "assistant",
                      content: stripThinkBlocks(cancelledContent),
                    });
                    // Issue 4: persist the partial to the session DB as an
                    // interrupted row so it survives reload and offers Continue.
                    if (req.workspaceSessionId) {
                      await flushInterruptedDraft(
                        req.chatId,
                        req.workspaceSessionId,
                        partialResponse,
                        { force: true },
                      );
                    }
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

        // Only save the response and process it if we weren't user-aborted
        // (ledger-complete, ask_user end-turn, and forced-text-finish stops
        // still save — the latter two leave the controller aborted by design).
        if (
          !abortController.signal.aborted ||
          ctx.askUserEndedTurn ||
          ctx.turnForcedTextFinish
        ) {
          if (!ctx.fullResponse.trim()) {
            ctx.fullResponse = AI_STREAM_EMPTY_RESPONSE_FALLBACK;
          }
          let responseToStore = stripQuestionsBlockFromResponse(ctx.fullResponse);
          responseToStore = sanitizeAssistantOutput(responseToStore);
          const { ensurePlanMarkersInAssistantContent } = await import(
            "@/lib/plans/plan-artifacts"
          );
          responseToStore = ensurePlanMarkersInAssistantContent(responseToStore);
          // v11.1: the turn ended at an ask_user call — embed the pending
          // questions in the persisted content so the inline card survives
          // reloads (answers arrive as the next user message).
          if (ctx.askUserEndedTurn) {
            const pendingArtifact = pendingAskUserArtifactByChatId.get(req.chatId);
            if (pendingArtifact) {
              const { appendQuestionsArtifact } = await import(
                "@/lib/chat/ask-user-artifacts"
              );
              responseToStore = appendQuestionsArtifact(
                responseToStore,
                pendingArtifact,
              );
            }
          }
          // v12 0.2 (B2): persist the turn's native model messages as a
          // versioned envelope on the assistant message's modelContent — the
          // next turn's assembly splices them back natively instead of
          // re-ingesting flattened prose. Empty when no native tools ran.
          const assistantModelContent = hasNativeToolParts(ctx.nativeTurnMessages)
            ? serializeNativeHistory(ctx.nativeTurnMessages, {
                builtinProviderId: modelClient.builtinProviderId,
              })
            : "";
          {
            const ec = getStreamTransport(req.chatId);
            const finalContent = stripThinkBlocks(responseToStore);
            const lastInUpdated =
              updatedChat.messages.length > 0
                ? updatedChat.messages[updatedChat.messages.length - 1]
                : null;
            if (lastInUpdated?.role === "assistant") {
              lastInUpdated.content = finalContent;
              if (assistantModelContent) {
                lastInUpdated.modelContent = assistantModelContent;
              }
            } else if (ec) {
              const last = ec.messages[ec.messages.length - 1];
              if (last?.role === "assistant") {
                last.content = finalContent;
                if (assistantModelContent) {
                  last.modelContent = assistantModelContent;
                }
              }
            }
            if (ec) {
              ec.messages = updatedChat.messages;
            }
          }

          // v14.7: rolling session-memory recording removed (see the injection
          // site) — the full native history is the single source of truth.
          const settings = readSettings();
          const isBuildModeTurn = settings.selectedChatMode === "build";
          {
            const newReviewSystemActiveElse =
              ctx.delegatedAgentsThisTurn.includes("reviewer");

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
            // v12 2.6/2.7: Agent Lightning trace stub deleted (collectData was
            // never UI-wired; .atlarix/training_data/ stays a reserved dir for
            // the Tier-7 "learning workspace" research idea).
            if (
              isBuildModeTurn &&
              effectiveAppId != null &&
              appPath &&
              ctx.filesWrittenInThisExchange.length > 0
            ) {
              const { recordBuildCompleteSnapshot } = await import("@/lib/project-memory/service");
              // v12 3.7: tracked — snapshot write must survive a quick quit.
              trackPendingWork(
                recordBuildCompleteSnapshot(
                  effectiveAppId,
                  appPath,
                  userPrompt?.slice(0, 500),
                ),
                "build-complete-snapshot",
              );
            }
            // Plan-lifecycle safety net: a Build turn that wrote files and finished
            // cleanly marks the session's "building" plan as built if the model
            // didn't call update_plan_status itself.
            if (
              isBuildModeTurn &&
              req.workspaceSessionId &&
              ctx.filesWrittenInThisExchange.length > 0 &&
              !abortController.signal.aborted
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
              !abortController.signal.aborted
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
            markLedgerStreamComplete(streamTurnId);
            clearMutationOutcomes(streamTurnId);
            ctx.inFlightDelegationKeys.clear();
            notifyPlanUiForTurnIfPresent(streamTurnId);
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
                ctx.compassStreamTokens = (ctx.compassStreamTokens ?? 0) + auxUsage.totalTokens;
                ctx.compassUsedThisTurn += auxUsage.totalTokens;
                // Turn is over at this point — record for the pool, no abort
                // needed. v12 1.5: AWAIT the record (it used to be
                // fire-and-forget) and surface a visible notice when the pool
                // ran out — the next turn's pre-flight will hard-block, so
                // tell the user now instead of letting that block surprise
                // them.
                try {
                  const r = await recordCompassUsageTokens(auxUsage.totalTokens);
                  if (!r.ok && r.error === "limit_exceeded") {
                    logger.warn("[compass] Monthly limit hit while recording aux usage");
                    safeSend(event.sender, "chat:activity", {
                      id: `compass-limit-aux-${req.chatId}-${Date.now()}`,
                      type: "compass_limit",
                      label: "Monthly Atlarix Core token limit reached",
                      detail: compassExhaustedUserMessage(ctx.compassStreamTier ?? "free"),
                      status: "error",
                      timestamp: Date.now(),
                      chatId: req.chatId,
                    });
                  }
                } catch (auxRecordErr) {
                  // Transient RPC/network failure must never block the turn end.
                  logger.warn(
                    `[compass] aux usage record failed: ${String(auxRecordErr)}`,
                  );
                }
              }
            }
            safeSend(event.sender, "chat:response:end", {
              chatId: req.chatId,
              streamId,
              updatedFiles: false,
              hadToolCallsOrPermissions: ctx.hadToolCallsOrPermissions,
              usedCompass: usedCompassThisStream,
              compassTier: ctx.compassStreamTier,
              compassTokens: ctx.compassStreamTokens,
              ...(auxUsage ? { auxTokens: auxUsage.totalTokens } : {}),
              ...(ctx.maxReasoningTokensUsed != null && ctx.maxReasoningTokensUsed > 0
                ? { reasoningTokens: ctx.maxReasoningTokensUsed }
                : {}),
              // Fix 6: this turn's billed tokens (input+output) so the renderer
              // can accumulate a cumulative session total — the context meter is
              // occupancy, not spend, and undercounts a resend loop.
              ...(ctx.turnInputTokens + ctx.turnOutputTokens > 0
                ? { turnTokens: ctx.turnInputTokens + ctx.turnOutputTokens }
                : {}),
              // v12 7D: BYOK per-turn USD estimate (omitted for Core/Compass
              // and for models with no known price — never a guessed number).
              ...(() => {
                const cost = estimateTurnCostUsd(
                  {
                    name: effectiveModel?.name ?? "",
                    builtinProviderId: modelClient.builtinProviderId,
                  },
                  ctx.turnInputTokens + ctx.turnOutputTokens > 0
                    ? {
                        inputTokens: ctx.turnInputTokens,
                        outputTokens: ctx.turnOutputTokens,
                        ...(ctx.turnCachedInputTokens > 0
                          ? { cachedInputTokens: ctx.turnCachedInputTokens }
                          : {}),
                        ...(ctx.turnCacheCreationTokens > 0
                          ? { cacheCreationInputTokens: ctx.turnCacheCreationTokens }
                          : {}),
                      }
                    : null,
                  ctx.turnActualCostUsd > 0 ? ctx.turnActualCostUsd : null,
                );
                return cost != null ? { turnCostUsd: cost } : {};
              })(),
              // v12 0.2 (B2): renderer passes this through to the session
              // store as extras.modelContent when persisting the assistant
              // message (native-history envelope).
              ...(assistantModelContent ? { assistantModelContent } : {}),
              // v12 2.3: lets a background agent revert this turn's writes.
              snapshotTurnId: streamTurnId,
              // A2: turn parked on outstanding background work (auto-resumes).
              ...(ctx.turnParked
                ? {
                    parked: true,
                    parkedCommands: listBackgroundJobs(req.chatId).length,
                    parkedSubagents: runningSubagentCount(req.chatId),
                  }
                : {}),
            } satisfies ChatResponseEnd);
            if (activeStreamId.get(req.chatId) === streamId) activeStreams.delete(req.chatId);
            // Issue 4: turn completed cleanly — drop the interrupted draft so the
            // renderer's authoritative finished message is the only copy. v14.7 bug 7:
            // AWAIT it so the draft is gone before the handler returns — otherwise a
            // close-right-after (e.g. an ask_user-parked turn) can leave the stale
            // "interrupted" row, which reopens as the error/Continue UI.
            await clearInterruptedDraft(req.chatId);
            streamSessionByChatId.delete(req.chatId);
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
        // v11.1: an ask_user end-turn aborts the in-flight stream — the AI
        // SDK's pending promises then reject (AI_NoOutputGeneratedError /
        // AbortError), which is BENIGN here: the question card is already up.
        // Finalize the turn cleanly instead of surfacing an error banner.
        if (
          abortController.signal.aborted &&
          abortReasonSentinel(abortController.signal.reason) ===
            ASK_USER_STREAM_STOP
        ) {
          logger.log(
            `[ask_user] Stream ended at question (benign: ${error instanceof Error ? error.name : String(error)})`,
          );
          try {
            const { getStreamTransport } = await import("@/lib/chat/stream-transport");
            const chat = getStreamTransport(req.chatId);
            const pendingArtifact = pendingAskUserArtifactByChatId.get(req.chatId);
            if (chat) {
              const last = chat.messages[chat.messages.length - 1];
              if (last?.role === "assistant") {
                let content = stripThinkBlocks(
                  partialResponses.get(req.chatId) ?? last.content ?? "",
                ).trim();
                if (pendingArtifact) {
                  const { appendQuestionsArtifact } = await import(
                    "@/lib/chat/ask-user-artifacts"
                  );
                  content = appendQuestionsArtifact(content, pendingArtifact);
                }
                last.content = content;
              }
              safeSend(event.sender, "chat:response:chunk", {
                chatId: req.chatId,
                streamId,
                messages: [...chat.messages],
              });
            }
          } catch (finalizeErr) {
            logger.warn("[ask_user] Question-turn finalize failed:", finalizeErr);
          }
          partialResponses.delete(req.chatId);
          safeSend(event.sender, "chat:response:end", {
            chatId: req.chatId,
            streamId,
            updatedFiles: false,
            hadToolCallsOrPermissions: true,
          } satisfies ChatResponseEnd);
          if (activeStreamId.get(req.chatId) === streamId) activeStreams.delete(req.chatId);
          ctx.streamTerminated = true;
          FileUploadsState.getInstance().clear(req.chatId);
          return;
        }
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
          if (activeStreamId.get(req.chatId) === streamId) activeStreams.delete(req.chatId);
          ctx.streamTerminated = true;
          FileUploadsState.getInstance().clear(req.chatId);
          return;
        }
        if (error instanceof EmptyModelOutputAfterRetryError) {
          safeSend(event.sender, "chat:response:error", {
            chatId: req.chatId,
            streamId,
            error: MODEL_EMPTY_RESPONSE_USER_MESSAGE,
          });
          safeSend(event.sender, "chat:response:end", {
            chatId: req.chatId,
            streamId,
            updatedFiles: false,
            hadToolCallsOrPermissions: false,
          } satisfies ChatResponseEnd);
          if (activeStreamId.get(req.chatId) === streamId) activeStreams.delete(req.chatId);
          FileUploadsState.getInstance().clear(req.chatId);
          return;
        }
        if (
          error instanceof TypeError &&
          (error.message === "terminated" || error.message === "fetch failed")
        ) {
          safeSend(event.sender, "chat:response:error", {
            chatId: req.chatId,
            streamId,
            error: "Connection interrupted. Please try again.",
          });
          safeSend(event.sender, "chat:response:end", {
            chatId: req.chatId,
            streamId,
            updatedFiles: false,
            hadToolCallsOrPermissions: false,
          } satisfies ChatResponseEnd);
          if (activeStreamId.get(req.chatId) === streamId) activeStreams.delete(req.chatId);
          ctx.streamTerminated = true;
          FileUploadsState.getInstance().clear(req.chatId);
          return;
        }
        if (error instanceof ChatPromptSafetyError) {
          safeSend(event.sender, "chat:response:error", {
            chatId: req.chatId,
            streamId,
            error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${SAFETY_FILTER_BLOCKED_MESSAGE}`,
          });
          safeSend(event.sender, "chat:response:end", {
            chatId: req.chatId,
            streamId,
            updatedFiles: false,
            hadToolCallsOrPermissions: false,
          } satisfies ChatResponseEnd);
          if (activeStreamId.get(req.chatId) === streamId) activeStreams.delete(req.chatId);
          ctx.streamTerminated = true;
          FileUploadsState.getInstance().clear(req.chatId);
          return;
        }
        {
          const { isContextOverflowError } = await import("@/lib/context/compaction");
          if (isContextOverflowError(error)) {
            // v11.1: the provider just told us our context estimate was too
            // big. Lower the cached window estimate (feedback loop), force one
            // aggressive compaction round, and retry the dispatch ONCE.
            if (!retriedAfterOverflowCompaction) {
              retriedAfterOverflowCompaction = true;
              try {
                const { reportContextOverflowForModel } = await import(
                  "@/lib/context/resolve-model-context-limit"
                );
                reportContextOverflowForModel(getEffectiveModel(readSettings()));
              } catch {
                /* best-effort */
              }
              const { forceCompactEphemeralChat } = await import("@/lib/tools/workspace");
              const compacted = await forceCompactEphemeralChat(
                req.chatId,
                readSettings().selectedModel?.provider,
              ).catch(() => false);
              if (compacted) {
                logger.warn(
                  `[stream:${req.chatId}] Context overflow — compacted and retrying dispatch once`,
                );
                safeSend(event.sender, "chat:activity", {
                  id: `overflow-compact-${Date.now()}`,
                  type: "tool_use",
                  label: "Context overflow — summarized and retrying",
                  status: "done",
                  timestamp: Date.now(),
                  chatId: req.chatId,
                });
                // The user message from the first attempt is already in the
                // (compacted) history — continue without re-adding it.
                req.continueAfterQuestions = true;
                return runStream();
              }
            }
            safeSend(event.sender, "chat:response:error", {
              chatId: req.chatId,
              streamId,
              error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${error instanceof Error ? error.message : String(error)}`,
            });
            safeSend(event.sender, "chat:response:end", {
              chatId: req.chatId,
              streamId,
              updatedFiles: false,
              hadToolCallsOrPermissions: false,
            } satisfies ChatResponseEnd);
            if (activeStreamId.get(req.chatId) === streamId) activeStreams.delete(req.chatId);
            ctx.streamTerminated = true;
            FileUploadsState.getInstance().clear(req.chatId);
            return;
          }
        }
        const errMessage = isNoUsableModelOutputError(error)
          ? AI_STREAM_EMPTY_RESPONSE_FALLBACK
          : modelFailureUserMessage(
              error instanceof Error ? error.message : String(error),
            );
        safeSend(event.sender, "chat:response:error", {
          chatId: req.chatId,
          streamId,
          error: errMessage,
        });
        safeSend(event.sender, "chat:response:end", {
          chatId: req.chatId,
          streamId,
          updatedFiles: false,
          hadToolCallsOrPermissions: false,
        } satisfies ChatResponseEnd);
        if (activeStreamId.get(req.chatId) === streamId) activeStreams.delete(req.chatId);
        ctx.streamTerminated = true;
        FileUploadsState.getInstance().clear(req.chatId);
      } finally {
        // Finalize any browser/preview session recordings captured this turn and
        // hand the renderer a reference to play them back (proof of work).
        // Finalize browser/preview session reels (emits the final, live:false
        // event per reel itself — see browser-reel.finalizeReels).
        void finalizeReels(req.chatId).catch(() => {});
        ctx.stopAgentOrchestrator?.();
        unregisterLedgerPlanUiNotifier(req.chatId);
        clearActiveModelDisplayName();
        ensureTerminal();
      }
    };

    // Bug A: track the live run promise so the NEXT chat:stream for this chat
    // can await its real termination before starting (see the supersede guard
    // above). The identity check keeps a stale finally from evicting a newer run.
    const runPromise = runStream();
    activeStreamRuns.set(req.chatId, runPromise);
    void runPromise.finally(() => {
      if (activeStreamRuns.get(req.chatId) === runPromise) {
        activeStreamRuns.delete(req.chatId);
      }
    });
    // Reply immediately so renderer does not get "reply was never sent".
    // v14.8.10 Fix S: return this leg's streamId so the renderer can drop
    // lifecycle events from a superseded (older) leg on the same chatId.
    return { streamId };
  };

  ipcMain.handle("chat:stream", chatStreamHandler);
  // Automations execute unattended turns by invoking this exact handler with a
  // recording sender (see src/lib/automations/execute-run.ts) — the handler was
  // structured for in-process programmatic reuse from the start.
  setChatStreamHandlerRef(chatStreamHandler);

  registerLifecycleHandlers(chatStreamHandler);
  registerRevertHandlers();
}

// --- pure post-processing helpers moved to ./chat_stream/message-postprocess (re-exported below) ---

// v11.1: dead createDiagramFirstPrompt deleted (only caller was a removed if(false) block).

// `normalizeToolInputSchemaForAiSdk` + `PERMISSIVE_TOOL_JSON_SCHEMA` were moved
// to `@/lib/ai/normalize-tool-schema` so that delegation sub-agents
// (`src/lib/tools/agent.ts`) can reuse the exact same wiring.

