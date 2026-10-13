import { ipcMain } from "electron";
import { ModelMessage } from "ai";

import { db } from "../../db";
import { apps } from "../../db/schema";
import { eq } from "drizzle-orm";
import type { WorkMode } from "../../lib/schemas";
import {
  constructSystemPrompt,
  buildSystemPromptWithProjectInstructions,
  type ModeSystemKey,
} from "../../prompts/system_prompt";
import { getActiveModeReanchor } from "@/lib/tools/mode-prompt-bundle";
import {
  parseNativeHistory,
  isNativeHistoryEnvelope,
  regateNativeMediaForProvider,
} from "@/lib/ai/native-history";
import { PreflightTimer } from "@/lib/agent/preflight-timing";
import { buildAttachmentRecord } from "@/lib/attachment-upload";
import { resolveAppPath } from "../../paths/paths";
import { readSettings } from "../../main/settings";
import type { ChatResponseEnd, ChatStreamParams } from "../ipc_types";
import { streamTestResponse } from "./testing_chat_handlers";
import { getTestResponse } from "./testing_chat_handlers";
import {
  getModelClient,
  getEffectiveModel,
  type GetModelClientOptions,
} from "../utils/get_model_client";
import { buildAtlarixCoreTierCatalog } from "@/lib/atlarix-core-catalog";
import { resolveActiveModelIdentity } from "@/lib/model-identity-prompt";
import {
  setActiveModelDisplayName,
  clearActiveModelDisplayName,
} from "@/ipc/utils/active-model-identity";
import { resetAuxUsage } from "@/lib/usage/turn-usage-aggregator";
import {
  SUPERSEDED_STREAM_STOP,
  streamStopAbortReason,
} from "../../lib/stream/stream-stop-sentinels";
import log from "electron-log";
import fs from "node:fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { readFile, writeFile, unlink } from "fs/promises";

import { safeSend } from "../utils/safe_sender";
import {
  buildContinueAfterQuestionsPrompt,
  buildInterruptedContinuePrompt,
  nextEphemeralMessageId,
  getStreamTransport,
} from "@/lib/chat/stream-transport";
import { isStreamDebugLoggingEnabled } from "@/lib/stream/stream-debug";
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
  PDF_MIME_TYPE,
} from "./chat_stream/message-postprocess";
import { detectPdfCapability } from "@/lib/routing/model-capability-profile";
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

import {
  takePendingBackgroundCommandResults,
  listBackgroundJobs,
} from "@/lib/agent/background-commands";
import {
  takePendingSubagentResults,
  runningSubagentCount,
} from "@/lib/agents/subagent-results";
import { computeWakePendingResults } from "@/lib/agent/collect-results";
import { takeEarlierDeliveredResults } from "@/lib/agent/delivered-results";
import { takePendingAutomationResults } from "@/lib/agent/automation-results";
import {
  AI_STREAMING_ERROR_MESSAGE_PREFIX,
  SAFETY_FILTER_BLOCKED_MESSAGE,
} from "@/shared/texts";
import {
  prepareUserChatTurnInput,
  ChatPromptSafetyError,
} from "../../lib/security/chat-prompt-gate";
import {
  resolveMediaModelId,
  resolveReasoningCatalogModelId,
  resolveCapabilityProviderId,
  resolveDispatchCapabilityProviderId,
  hasNativeDeepThinkingSupport,
} from "@/lib/routing/reasoning-detector";
import {
  catalogSaysReasons,
  resolveReasoningRequest,
} from "@/lib/routing/model-reasoning-profile";
import { enforceContextBudget } from "@/lib/routing/tier_context_budget";
import { resolveUsableBudget } from "@/lib/context/compaction";
import { AttachmentStore } from "../../lib/attachment-store";
import {
  buildPasteAttachmentDirective,
  ensurePasteAttachmentIds,
  pasteToAttachmentData,
} from "../../lib/attachment-persistence";
import type { StoredFileAttachment } from "../ipc_types";
import { unregisterLedgerPlanUiNotifier } from "@/lib/tasks/task-ledger";
import { clearPlanLedgerRefresh } from "@/lib/tasks/plan-ledger-refresh";
import { type ContextSection } from "@/lib/context/ContextAssembler";
import { ContextBudgetTracker } from "@/lib/context/context-budget-tracker";
import {
  describeBudgetPruning,
  pruneContextSectionsForBudget,
} from "@/lib/context/context-budget-pruning";
import { resolveModelContextLimit } from "@/lib/context/resolve-model-context-limit";
import { estimateDispatchTokens } from "@/lib/routing/tier_context_budget";
import { measureToolSurface } from "@/lib/context/prompt-budget";
// Skills reach the model as an INDEX (skill-index.ts) — names, descriptions and
// paths. Bodies are read on demand with read_file; nothing is auto-injected.
import {
  requireAuthSession,
  formatAuthRequiredIpcError,
  AuthRequiredError,
} from "../../lib/auth/require_auth_session";
import {
  getContextWindowDetailed,
  getEffectiveBudget,
  setCompassContextWindow,
} from "../utils/token_utils";
import {
  isReadOnlyWorkMode,
  resolveEffectiveWorkMode,
} from "../../lib/work-mode";
import { getToolActivityLabel } from "../../lib/tool-activity-labels";
import { awaitWithTimeout, isTextFile } from "./chat_stream/stream-misc";
import {
  activeStreams,
  activeStreamRuns,
  activeStreamId,
  nextStreamId,
  lastStreamRequest,
  streamSessionByChatId,
  streamTurnIdByChatId,
  lastTurnModeByChat,
  pendingAskUserArtifactByChatId,
  getLastSkillCacheAppId,
  setLastSkillCacheAppId,
  getChatStreamHandler,
  setChatStreamHandlerRef,
  SUPERSEDE_AWAIT_TIMEOUT_MS,
  shouldDropSystemWake,
  isChatStreamLive,
  isChatUserStopped,
  clearChatUserStopped,
  shouldClearUserStopLatch,
} from "./chat_stream/stream-state";
import {
  resolveModeChange,
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
import { type SimpleStreamTextDeps } from "./chat_stream/turn-runner/simple-stream-text";
import { processResponseChunkUpdate as runProcessResponseChunkUpdate } from "./chat_stream/turn-runner/response-chunk-update";
import { runContextAssembly } from "./chat_stream/turn-runner/context-assembly";
import {
  runAskBranch,
  type AskBranchDeps,
} from "./chat_stream/turn-runner/ask-branch";
import {
  runBuildBranch,
  type BuildBranchDeps,
} from "./chat_stream/turn-runner/build-branch";
import {
  finalizeTurn,
  handleTurnError,
} from "./chat_stream/turn-runner/finalize";
import {
  loadModeSkillSection,
  loadSkillsIndexSection,
  loadWorkspaceCapsSection,
  loadWorkspaceRootSection,
  loadActivePlanSection,
  loadAtlarixMdSection,
  loadMemoryMdSection,
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
    // Admission control for SYSTEM wakes, before the supersede below.
    //
    // A wake exists to deliver a finished background result to an IDLE chat; if a
    // turn is already live it drains those results itself via prepareStep. Letting
    // a wake supersede was what turned two open windows into a runaway: the other
    // window's guards read its own per-window store, so it happily woke a chat this
    // one was mid-turn on, and each superseded end triggered the next wake.
    //
    // Only wakes are dropped. A user message still supersedes — that is the user
    // redirecting the agent, and it has to keep working.
    const wakeDrop = shouldDropSystemWake(req, {
      isStreaming: isChatStreamLive(req.chatId),
      userStopped: isChatUserStopped(req.chatId),
    });
    if (wakeDrop) {
      logger.log(
        `[wake] dropped system wake for chat ${req.chatId}: ${wakeDrop}`,
      );
      // Report the CURRENT stream id, not a new one: the renderer keys
      // late-event filtering on it (`shouldDropStreamEvent`), and minting a
      // higher id here would make it discard the live turn's real events.
      return {
        streamId: activeStreamId.get(req.chatId) ?? 0,
        dropped: wakeDrop,
      };
    }

    // The user is driving again — release the stop latch.
    //
    // KEYED ON `systemWake`, NOT ON PROMPT CONTENT. It used to require
    // `req.prompt.trim().length > 0`, on the reasoning that a wake's empty prompt
    // must never clear its own suppression — right goal, wrong discriminator.
    // Several USER actions also send an empty prompt, because their content
    // travels out of band: answering `ask_user`
    // (`InlineUserQuestions.tsx` → `{ prompt: "", continueAfterQuestions: true }`,
    // where the answers are persisted as their own user message) and clicking
    // Continue on an interrupted turn.
    //
    // OBSERVED 2026-09-03: a chat that went through one `ask_user` round was
    // latched `user-stopped` FOREVER. Closing the question flow aborts the stream,
    // which latches the stop; the answer turn then could not clear it. Five
    // sub-agents finished over the next five minutes and all five wakes were
    // dropped — `[wake] dropped system wake for chat -42: user-stopped` ×5 — so
    // their results only arrived when the user next TYPED something. Every
    // background source loses eager delivery the same way: commands, automations,
    // scheduled self-wakes.
    //
    // `systemWake` is the property that actually means "machine-originated", and
    // every such call site sets it. So a wake still cannot clear its own
    // suppression, and a user action clears it whether or not it carries text.
    if (shouldClearUserStopLatch(req)) {
      clearChatUserStopped(req.chatId);
    }

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
    const overflowRetried = { value: false };

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
        logger.warn(
          `[stream] Stall detected for chat ${req.chatId} — retrying`,
        );
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
            if (activeStreamId.get(req.chatId) === streamId)
              activeStreams.delete(req.chatId);
            return;
          }
          throw e;
        }

        try {
          if (!req.continueAfterQuestions && !req.continueInterrupted) {
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
            if (activeStreamId.get(req.chatId) === streamId)
              activeStreams.delete(req.chatId);
            return;
          }
          if (
            e instanceof Error &&
            /maximum length|Invalid prompt/i.test(e.message)
          ) {
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
            if (activeStreamId.get(req.chatId) === streamId)
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
        const { isStreamTransportId, getStreamTransportAppId } = await import(
          "@/lib/chat/stream-transport"
        );

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
            logger.log(
              `Chat ${req.chatId} is ephemeral workspace chat for app: ${ephemeralAppId}`,
            );
          } else {
            const noWorkspaceMsg =
              "Open a workspace folder to start chatting. Use Open folder on the welcome screen.";
            logger.warn(
              `Chat ${req.chatId} rejected: ephemeral chat without workspace`,
            );
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
          const { getStreamTransport } = await import(
            "@/lib/chat/stream-transport"
          );
          const ephemeralChat = getStreamTransport(req.chatId);

          appData = await db.query.apps.findFirst({
            where: eq(apps.id, ephemeralAppId!),
          });

          if (!appData) {
            throw new Error(
              `App not found for ephemeral workspace chat: ${ephemeralAppId}`,
            );
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

          logger.log(
            `Ephemeral workspace chat loaded for app: ${appData.name} (${appData.path})`,
          );
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
          const composed = buildContinueAfterQuestionsPrompt(
            ephemeral.messages,
          );
          if (!composed.trim()) {
            throw new Error(
              "Continue after questions: no user message content found",
            );
          }
          userPrompt = prepareUserChatTurnInput(composed);
        } else if (req.continueInterrupted) {
          // Resume an interrupted turn (e.g. after a disconnect). No new user message
          // is shown or persisted; the model receives an out-of-band directive so it
          // continues rather than mistaking a harness resume for a user "continue" turn.
          userPrompt = buildInterruptedContinuePrompt();
        }

        // Process attachments if any (skip when continuing after questions)
        // NOTE: Attachment *context* must not be appended to the user-visible message content.
        // We keep UI message content clean, but inject attachment info into the model prompt later.
        let attachmentInfoForModel = "";
        let attachmentPaths: string[] = [];
        let attachmentInfosForMessage: {
          id: string;
          filename: string;
          mimeType: string;
          size: number;
        }[] = [];
        let storedFileAttachments: StoredFileAttachment[] = [];
        let pasteAttachmentsForMessage =
          req.pasteAttachments && req.pasteAttachments.length > 0
            ? ensurePasteAttachmentIds(req.pasteAttachments)
            : null;

        const mimeTypes: Record<string, string> = {
          ".pdf": "application/pdf",
          ".doc": "application/msword",
          ".docx":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          ".xls": "application/vnd.ms-excel",
          ".xlsx":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ".ppt": "application/vnd.ms-powerpoint",
          ".pptx":
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
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

        if (
          !req.continueAfterQuestions &&
          !req.continueInterrupted &&
          req.attachments &&
          req.attachments.length > 0
        ) {
          // Model-only attachment directive (do not leak into user-visible bubble).
          attachmentInfoForModel =
            "\n\nFILES ATTACHED (already uploaded; do NOT ask the user to attach again):\n";

          // W10: temp-file writes + AttachmentStore/PDF pre-extract are real
          // I/O that previously fell into the "unaccounted" preflight gap.
          // Backstop dedup: the client already collapses duplicate chips, but an
          // edit/resend or any client that sends the same file twice must not
          // produce two directive lines + two inline previews + two image embeds.
          // Key on the content id (deterministic content hash from the client, or
          // a content-hash fallback) so identical bytes ingest exactly once.
          const seenAttachmentHashes = new Set<string>();
          await preflight.time("ingest-attachments", async () => {
            for (const [index, attachment] of req.attachments!.entries()) {
              // Extract the base64 data (remove the data:mime/type;base64, prefix)
              const base64Data = attachment.data.split(";base64,").pop() || "";
              // Generate a unique filename — content-derived so it's stable across
              // encodes (no Date.now(), which would defeat dedup).
              const hash =
                attachment.id ||
                crypto.createHash("md5").update(base64Data).digest("hex");
              if (seenAttachmentHashes.has(hash)) continue;
              seenAttachmentHashes.add(hash);
              const fileExtension = path.extname(attachment.name);
              const filename = `${hash}${fileExtension}`;
              const filePath = path.join(TEMP_DIR, filename);

              await writeFile(filePath, Buffer.from(base64Data, "base64"));
              attachmentPaths.push(filePath);

              // Store in AttachmentStore for read_attachment tool
              const resolvedMimeType =
                mimeTypes[fileExtension] || "application/octet-stream";
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
          // Inline is canonical: images are embedded (seen directly) and short
          // text files may be fully shown in the preview above — read_attachment
          // is for the FULL body of a file whose inline preview is clipped or that
          // is non-text, NOT a mandatory re-fetch of content already in context.
          attachmentInfoForModel +=
            '\nReading attached files:\n- Attached IMAGES are embedded in this message — look at them directly; do NOT call read_attachment for them.\n- For any other attached file, call read_attachment({ "attachmentId": "<id>" }) to read its FULL content when the inline preview is clipped or the file is non-text (a short preview shown above may already be the whole file).\n';
        }

        if (pasteAttachmentsForMessage?.length) {
          for (const paste of pasteAttachmentsForMessage) {
            AttachmentStore.add(
              pasteToAttachmentData(paste),
              req.chatId,
              req.workspaceSessionId ?? undefined,
            );
          }
          // The full paste body is already inline in the user message; the
          // directive lists ids + notes read_attachment is optional (no MANDATORY
          // re-fetch of content the model already has).
          attachmentInfoForModel += buildPasteAttachmentDirective(
            pasteAttachmentsForMessage,
          );
        }

        // Add user message to database (skip when continueAfterQuestions).
        // Display text uses stub attachment tags; model uses full bodies in req.prompt.
        let userDisplayContent = userPrompt;
        if (!req.continueAfterQuestions && !req.continueInterrupted) {
          userDisplayContent = req.displayPrompt ?? req.prompt;
          userPrompt = req.prompt;
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
        if (
          req.workspaceSessionId &&
          !req.continueAfterQuestions &&
          !req.continueInterrupted
        ) {
          const {
            persistWorkspaceSessionUserMessage,
            titleSessionFromFirstMessage,
          } = await import("./workspace_session_handlers");
          const { titleSourceText } = await import("@/lib/session-title/title-text");
          const persistOnce = () =>
            persistWorkspaceSessionUserMessage(
              req.workspaceSessionId!,
              userDisplayContent,
              {
                modelContent:
                  userPrompt !== userDisplayContent ? userPrompt : null,
                pasteAttachments: pasteAttachmentsForMessage,
                fileAttachments:
                  storedFileAttachments.length > 0
                    ? storedFileAttachments
                    : null,
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
            // Name the session from this message if it is the first — in the
            // background, parallel to the turn, never awaited by it.
            void titleSessionFromFirstMessage(
              req.workspaceSessionId,
              titleSourceText(userDisplayContent, userPrompt),
              { chatId: req.chatId },
            );
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
          settings = {
            ...settings,
            ...settingsPatchForWorkMode(req.workModeOverride),
          };
        }

        // v12 7A: user-defined agent (.atlarix/agents/<name>.md). Resolved
        // BEFORE the model + work-mode resolve below so its base mode, model
        // override, and (later) custom system block + tool allowlist all take
        // effect. Composes with everything downstream (capability trim, hooks).
        let activeUserAgent:
          | import("@/lib/agents/user-agents").UserAgent
          | null = null;
        // Per-turn req override wins; else the persisted picker selection.
        const agentName =
          req.agentOverride ?? settings.selectedAgent ?? undefined;
        if (agentName && chat?.app?.path) {
          const { loadUserAgent } = await import("@/lib/agents/user-agents");
          activeUserAgent = loadUserAgent(
            resolveAppPath(chat.app.path),
            agentName,
          );
          if (activeUserAgent) {
            const { settingsPatchForWorkMode } = await import(
              "@/lib/work-mode"
            );
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
                  : {
                      provider: settings.selectedModel.provider,
                      name: activeUserAgent.model,
                    };
            }
            logger.log(
              `[user-agent] active: ${activeUserAgent.name} (mode=${activeUserAgent.mode}${activeUserAgent.model ? `, model=${activeUserAgent.model}` : ""})`,
            );
          } else {
            logger.warn(
              `[user-agent] "${req.agentOverride}" not found — ignored`,
            );
          }
        }

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

        if (req.continueAfterQuestions || req.continueInterrupted) {
          updatedChat.messages = [...existingMessages, placeholderMessage];
        } else {
          const newUserMessage = {
            id: newUserMessageId,
            chatId: req.chatId,
            role: "user",
            content: userDisplayContent,
            // v12 0.4-C2: direct DB-row identity for edits (no ordinal mapping).
            ...(persistedUserRowId ? { sessionRowId: persistedUserRowId } : {}),
            modelContent: userPrompt !== userDisplayContent ? userPrompt : null,
            pasteAttachments:
              pasteAttachmentsForMessage &&
              pasteAttachmentsForMessage.length > 0
                ? pasteAttachmentsForMessage
                : null,
            createdAt: new Date(),
            sourceCommitHash: null,
            commitHash: null,
            attachments:
              attachmentInfosForMessage.length > 0
                ? attachmentInfosForMessage
                : null,
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
        // Publish it so `chat:cancel` — which cannot see this scope — can report the
        // same id on a user-stopped end. Without it the Revert affordance never appears
        // for the one turn you most want to revert. Cleared on terminal below.
        streamTurnIdByChatId.set(req.chatId, streamTurnId);
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
            // Paid Atlarix Auto routes on the work mode, so it is resolved here
            // from the same inputs as `effectiveWorkMode` below (which needs the
            // client to exist first).
            purpose: "main",
            workMode: resolveEffectiveWorkMode({
              workModeOverride: req.workModeOverride,
              intentMode: settings.intentMode,
              workModePreference: settings.workModePreference,
              selectedChatMode: settings.selectedChatMode ?? "ask",
            }),
            escalate: req.escalate === true,
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
          // Usage by who pays for it (Core, own key, local), for people who
          // opted in to analytics: own-key turns never reach Core's numbers.
          {
            const { trackModelTurn } = await import("@/main/lib/analytics");
            const { getLanguageModelProviders } = await import("@/ipc/shared/language_model_helpers");
            const providerType = (await getLanguageModelProviders().catch(() => [])).find(
              (p) => p.id === effectiveModel.provider,
            )?.type;
            trackModelTurn({
              provider: initialModelClientBundle.fellBackToCore ? "compass" : effectiveModel.provider,
              providerType,
              model: effectiveModel.name,
              mode: mainOptions.workMode,
              fellBackToCore: initialModelClientBundle.fellBackToCore,
            });
          }
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
          // Native extended-thinking/reasoning turns on whenever the selected
          // model + gateway support it (the fast/balanced/thinking tiers are gone;
          // a model now delivers its full capability).
          const enableNativeReasoning = hasNativeDeepThinkingSupport(
            effectiveModel,
            modelClient.builtinProviderId,
            settings,
          );
          // Say WHY, not just whether. A hidden Deep-thinking toggle has three very
          // different causes — the model declares no reasoning, it declares reasoning
          // but no control to change, or models.dev has no row for it at all (a real
          // case: a Core model live on a vendor's own API before the catalog lists it).
          // Only the last one is a bug on our side, and without the resolved vendor +
          // catalog id in the log there is no way to tell them apart from a report.
          const reasoningCapabilityProvider =
            resolveDispatchCapabilityProviderId(
              effectiveModel,
              modelClient.builtinProviderId,
            );
          const reasoningCatalogModelId =
            resolveReasoningCatalogModelId(effectiveModel);
          logger.log(
            `[stream:${req.chatId}] model=${effectiveModel.provider}/${effectiveModel.name} ` +
              `reasoning=${enableNativeReasoning} ` +
              `wire=${modelClient.builtinProviderId ?? "?"} ` +
              `vendor=${reasoningCapabilityProvider ?? "?"}/${reasoningCatalogModelId} ` +
              `catalog=${
                catalogSaysReasons(
                  reasoningCapabilityProvider,
                  reasoningCatalogModelId,
                ) ?? "miss"
              } ` +
              `control=${
                resolveReasoningRequest({
                  providerId: reasoningCapabilityProvider,
                  modelId: reasoningCatalogModelId,
                  deepThinking: !!settings.deepThinking,
                }).kind
              }`,
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

          // True when this turn dispatched to the managed Atlarix Core provider
          // (used only to flag the terminal payload for usage refresh; the PAYG
          // wallet reserve gate + proxy metering enforce spend, not the client).
          const usedCompassThisStream =
            modelClient.builtinProviderId === "compass";

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
          let appPath = effectiveApp?.path
            ? resolveAppPath(effectiveApp.path)
            : "";
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

          // PASS1: no proactive codebase-context injection — the model explores
          // via grep, glob and read_file on demand. Do not re-enable it.
          //
          // A `files: any[]` used to be declared here, set to `[]`, walked to mark
          // "selected components" focused (a loop over an empty array), and then
          // threaded through both branches into `simpleStreamText` and out as
          // the legacy files field. Its own comment said "kept for backward compatibility".
          const codebaseInfo = ""; // Diagram context injected via systemPrompt instead

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
            type Msg = {
              role: string;
              content?: string;
              sourceCommitHash?: string;
              commitHash?: string;
            };
            let messageHistory = updatedChat.messages.map(
              (
                message: Msg & { modelContent?: string | null; kind?: string },
              ) => {
                const content =
                  message.role === "user"
                    ? (message.modelContent ?? message.content ?? "")
                    : message.content || "";
                // `kind` rides along so `sliceFromLastCompactionSummary` can identify
                // a durable compaction marker structurally. Note the `content` above
                // prefers `modelContent` for user rows — so WITHOUT `kind` the slice
                // here and the one in token_count_handlers (which reads `content`)
                // can disagree about where the boundary is.
                const baseMessage: {
                  role: "user" | "assistant" | "system";
                  content: string;
                  kind?: string;
                } = {
                  role: message.role as "user" | "assistant" | "system",
                  content,
                  ...(message.kind ? { kind: message.kind } : {}),
                };

                // Only include commit hash fields if they're defined (DB messages have them, ephemeral don't)
                // These are used for Atlarix Pro engine features
                const commitFields: {
                  sourceCommitHash?: string;
                  commitHash?: string;
                } = {};
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
              },
            );

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

            // NO count-based history cap. Context is bounded by TOKENS only:
            // `enforceContextBudget` below, mid-turn `compactAgenticMessagesIfNeeded`
            // inside the SMART AGENTIC TOOL LOOP, and `compress_context` as the
            // model-triggered escape hatch; durable summaries flow through
            // [COMPACTION MARKER] message slices. The old 11-turn cap deleted half a
            // 124,907-token session on a 1M-token model at 8.9% fill — see
            // dropped-history-notice.ts.
            let limitedMessageHistory = messageHistory;

            // The number the model is TOLD, and its only two consumers are the two
            // system-prompt builders below.
            //
            // `getContextWindow` ignores `tokenBudgetOverrides`, so a user who capped
            // a provider at 16,000 was told "Your context window this session is
            // 1,048,576 tokens" while every budget that governs the request used
            // 16,000. Observed 2026-08-31. `getEffectiveBudget` respects the cap, so
            // the stated fact matches the budget the request is actually held to —
            // the same rule as not letting a doc restate a number the config decides.
            const contextSize = (
              await getEffectiveBudget(
                effectiveModel.provider ??
                  settings.selectedModel?.provider ??
                  "auto",
                req.chatId,
              )
            ).budget;
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
              effectiveWorkMode === "ask" ||
              effectiveWorkMode === "plan" ||
              effectiveWorkMode === "build" ||
              effectiveWorkMode === "debug" ||
              effectiveWorkMode === "review"
                ? (effectiveWorkMode as ModeSystemKey)
                : "ask";

            /**
             * The bound tool surface, in tokens, computed ONCE for this turn.
             *
             * Every budget decision below needs it and none of them had it: the
             * dispatch estimate, `enforceContextBudget` (which decides what to
             * TRIM to fit the window) and the compactor's `alreadyUsedTokens` all
             * priced the prefix as system TEXT only. The tool descriptions and
             * parameter schemas — ~6,700 tokens in Explore, ~9,300 in Build — ride
             * in the same request and are billed on every turn, so Atlarix
             * believed it had that much more headroom than it had.
             *
             * Measured through `measureToolSurface`, which resolves the toolset via
             * `resolveToolsetForSession` — the same single assembly point both
             * stream branches use, so this cannot drift from what dispatches.
             * Computed here rather than at each site because four independent
             * derivations is exactly how the context meter came to disagree with
             * the dispatch in the first place.
             *
             * Failure is non-fatal and LOUD: a budget that silently reverts to the
             * old under-count is the bug, so it logs rather than throwing (a turn
             * must still run) and 0 only ever means "we said so".
             */
            let toolSurfaceTokens = 0;
            try {
              toolSurfaceTokens = measureToolSurface({
                workMode: effectiveWorkMode,
                hasWorkspace,
                workspaceIntegrationEligible: hasWorkspace,
                model: {
                  name: effectiveModel?.name,
                  provider: effectiveModel?.provider,
                  builtinProviderId: modelClient?.builtinProviderId,
                },
                unattended: Boolean(req.automation),
              }).total;
            } catch (e) {
              logger.warn(
                `[budget] tool-surface measurement failed; budget decisions this turn use the system prompt alone: ${String(e)}`,
              );
            }

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
                  hasAnsweredQuestions:
                    updatedChat?.hasAnsweredQuestions ?? false,
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
                hasAnsweredQuestions:
                  updatedChat?.hasAnsweredQuestions ?? false,
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
            //
            // The signal must be the MODEL's nature, not the user's Deep-thinking
            // toggle. `enableNativeReasoning` says only "we ASKED for reasoning";
            // deepseek-v4-pro thinks by DEFAULT and rejected the forced tool_choice
            // with Deep OFF, killing every background-resume turn on Core. Ask the
            // catalog whether the model reasons at all, keyed on the vendor actually
            // serving the request (Core has no models.dev row of its own).
            // Unknown → assume it reasons and don't force, matching the
            // catalog-miss convention in model-reasoning-profile.ts. The forced path
            // is a belt-and-braces guarantee for weak models; skipping it costs
            // nothing but a channel, while getting it wrong costs the whole turn.
            const modelReasonsNatively =
              catalogSaysReasons(
                resolveCapabilityProviderId(effectiveModel),
                resolveReasoningCatalogModelId(effectiveModel),
              ) ?? true;
            const forceCollectOnWake =
              wakeHasPendingResults &&
              !enableNativeReasoning &&
              !modelReasonsNatively;

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

            // Results an earlier turn was given by injection (never saved), so
            // this turn still has them instead of redoing the work.
            const turnStartedAt = Date.now();
            const loadEarlierDeliveredResultsSection = (): ContextSection | null => {
              const earlier = takeEarlierDeliveredResults(req.chatId, turnStartedAt);
              return earlier ? { name: "taskProgress", priority: 1.6, content: earlier } : null;
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

            // Finished AUTOMATION runs, same drain.
            //
            // This loader was missing, and the omission was invisible: automations
            // record their results (keyed by workspace) and deliberately do NOT
            // wake a turn, so delivery depends entirely on the next turn draining
            // them — and the next turn is a NON-wake turn, where only the two
            // loaders above ran. `computeWakePendingResults` already counted
            // automations, so the wake path looked complete, but nothing wakes for
            // an automation by design. Result: `notifyAgent: true` runs finished
            // `ok` and the model was never told, which is exactly what was
            // reported.
            const loadAutomationResultsSection = (): ContextSection | null => {
              // A wake turn delivers them as fresh input: collect_results when
              // forced, else prepareStep's injection, as for finished commands
              // and sub-agents. Here, in the context, a woken model read them as
              // standing information and did nothing (QA). Ordinary turns take
              // them here at the start.
              if (wakeHasPendingResults) return null;
              const pending = takePendingAutomationResults(req.chatId);
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
              skillsIndexSection,
              workspaceCapsSection,
              activePlanResult,
              atlarixMdSection,
              memoryMdSection,
            ] = await Promise.all([
              loadModeSkillSection(contextSectionParams),
              loadSkillsIndexSection(contextSectionParams),
              loadWorkspaceCapsSection(contextSectionParams),
              loadActivePlanSection(contextSectionParams),
              loadAtlarixMdSection(contextSectionParams),
              loadMemoryMdSection(contextSectionParams),
            ]);
            // loadActivePlanSection is the sole writer of taskLedgerBlock.
            //
            // Drop any ledger the PREVIOUS turn rendered first. The refresh module
            // keeps its newest block until the end of a turn (so a round boundary
            // gets fresh counts instead of this frozen snapshot), and this preflight
            // is the once-per-turn seam where that stickiness has to end — a block
            // left over from the last turn would otherwise outrank the row we just
            // read.
            clearPlanLedgerRefresh(req.chatId);
            taskLedgerBlock = activePlanResult.taskLedgerBlock;
            const loadedSections = [
              // Cheap + synchronous: the absolute workspace path, so the model
              // never has to invent a `cwd`.
              loadWorkspaceRootSection(contextSectionParams),
              modeSkillSection,
              skillsIndexSection,
              workspaceCapsSection,
              activePlanResult.section,
              atlarixMdSection,
              memoryMdSection,
              loadBackgroundResultsSection(),
              loadSubagentResultsSection(),
              loadAutomationResultsSection(),
              loadEarlierDeliveredResultsSection(),
            ];
            for (const section of loadedSections) {
              if (section) contextSections.push(section);
            }

            // (fileSystemTruth is loaded concurrently above — S18.)

            // Pass 7: Workforce workspace context block deleted along with the
            // Legacy hosted credential store removed; per-extension state lives in MCP server
            // env vars.

            // Architecture exploration is tool-driven via grep + read_file — no
            // symbol index or map tool (pure ripgrep, like Claude Code / opencode).

            // PASS5: SQLite project memory is tool-driven — the model calls
            // get_project_memory when it needs project context. (v11.1: the
            // dead pre-injection block was deleted; table + builder remain.)

            // (projectMemory / atlarix.md is loaded concurrently above — S18.)

            // A `contextSummaryForSystem` block used to sit here, injecting a
            // "## Session Summary (earlier conversation)" section. It was hardcoded
            // `null` and threaded through this handler and `context-assembly.ts` to
            // two `if` statements that could never be true — compaction's summary
            // reaches the model as a `[COMPACTION MARKER]` MESSAGE, not as a system
            // prompt section, and has since v11.1. Removed with the whole thread.

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
            /**
             * What a request may actually OCCUPY: the window minus the room this
             * model's reply needs, from its models.dev `maxOutputTokens`. Resolved
             * once per turn and threaded down, so the pre-dispatch gate, the
             * mid-turn loop and the compactor all size themselves against one
             * number instead of each applying its own fraction of the window.
             */
            const usableTokens = await resolveUsableBudget(
              effectiveModel,
              contextWindowTokens,
            );
            logger.info(
              `[budget] window=${contextWindowTokens} usable=${usableTokens} reserve=${contextWindowTokens - usableTokens}`,
            );

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
              toolSurfaceTokens,
            });
            let budgetTracker = new ContextBudgetTracker(
              modelContextResolved.tierLimit,
              dispatchEstimate,
            );
            let contextBudgetPruningApplied = false;
            let workingSections = [...contextSections];
            let pruningNotes: string[] = [];
            for (let br = 0; br < 3; br++) {
              if (
                budgetTracker.isHealthy() ||
                dispatchEstimate < modelContextResolved.tierLimit * 0.85
              ) {
                break;
              }
              contextBudgetPruningApplied = true;
              const beforePrune = workingSections;
              workingSections = pruneContextSectionsForBudget(
                workingSections,
                budgetTracker.getBudgetTier(),
              );
              // Report what the pruner dropped/trimmed — otherwise it happens
              // silently and the context meter shows a smaller number with no
              // explanation.
              pruningNotes = [
                ...pruningNotes,
                ...describeBudgetPruning(beforePrune, workingSections),
              ];
              promptBundle = await buildPromptBundle(workingSections, {
                ...promptBundleDeps,
                extraTrimNotes: pruningNotes,
              });
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
                toolSurfaceTokens,
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
                toolSurfaceTokens,
              }),
            );
            systemPrompt = tierBudgeted.systemPrompt;
            limitedMessageHistory = tierBudgeted.limitedMessageHistory;
            contextAssemblerBlob = tierBudgeted.contextAssemblerBlob;
            // Compaction is no longer done here — see enforceContextBudget's header.
            // What this backstop still reports is how many messages it had to DROP.
            const budgetDroppedMessages = tierBudgeted.droppedMessageCount ?? 0;

            dispatchEstimate = estimateDispatchTokens({
              systemPrompt,
              history: limitedMessageHistory,
              codebasePrefixMessages: [...codebasePrefix],
              otherCodebasePrefixMessages: [...otherCodebasePrefix],
              toolSurfaceTokens,
            });
            budgetTracker = new ContextBudgetTracker(
              modelContextResolved.tierLimit,
              dispatchEstimate,
            );

            let proactiveContextReminderForStream: string | undefined;
            // Assembly compaction IIFE extracted to
            // ./chat_stream/turn-runner/context-assembly (runCompressAndRebuild
            // nested inside). Threaded return-style: pass the working set, write
            // back the (possibly compacted) result.
            const asmResult = await runContextAssembly(
              {
                systemPrompt,
                limitedMessageHistory,
                contextAssemblerBlob,
                codebasePrefix,
                otherCodebasePrefix,
                dispatchEstimate,
                budgetTracker,
                workingSections,
                promptBundle,
                contextSections,
              },
              {
                settings,
                effectiveModel,
                userPrompt,
                req,
                updatedChat,
                event,
                modelContextResolved,
                promptBundleDeps,
                // Both, deliberately: `usableTokens` is what the compaction gate
                // DECIDES on, `contextWindowTokens` is the raw window the fill
                // percentage and the context meter are REPORTED against. Conflating
                // them would either make the meter lie about the model's capacity or
                // make the gate ignore the room the reply needs.
                usableTokens,
                contextWindowTokens,
                toolSurfaceTokens,
              },
            );
            systemPrompt = asmResult.systemPrompt;
            limitedMessageHistory = asmResult.limitedMessageHistory;
            contextAssemblerBlob = asmResult.contextAssemblerBlob;
            codebasePrefix = asmResult.codebasePrefix;
            otherCodebasePrefix = asmResult.otherCodebasePrefix;
            dispatchEstimate = asmResult.dispatchEstimate;
            budgetTracker = asmResult.budgetTracker;
            workingSections = asmResult.workingSections;
            promptBundle = asmResult.promptBundle;
            contextSections = asmResult.contextSections;
            proactiveContextReminderForStream =
              asmResult.proactiveContextReminderForStream;

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
                  `[TTFT] provider=${String(modelClient.builtinProviderId)} model=${String((effectiveModel as { name?: string })?.name ?? "")} contextLength=${modelContextResolved.rawContextLength ?? "unknown"} ttft=${Date.now() - ttftStartRef.ms}ms budgetTier=${budgetTracker.getBudgetTier()} estimatedTokens=${dispatchEstimate} pruningApplied=${contextBudgetPruningApplied} compressionApplied=${openRouterCompressionApplied} budgetDroppedMessages=${budgetDroppedMessages}`,
                );
              };
            })();

            type HistoryMsg = {
              role: string;
              content?: string;
              sourceCommitHash?: string;
              commitHash?: string;
              modelContent?: string | null;
            };
            let limitedHistoryChatMessages: ModelMessage[] =
              limitedMessageHistory.flatMap(
                (msg: HistoryMsg): ModelMessage[] => {
                  // v12 0.2 (B2): assistant turns with a native-history envelope
                  // expand into their NATIVE messages (assistant tool_use + tool
                  // results) — the model replays real tool blocks, byte-stable
                  // across turns (prompt cache holds). Media re-gated when the
                  // dispatching provider can't take images in tool results.
                  if (
                    msg.role === "assistant" &&
                    isNativeHistoryEnvelope(msg.modelContent)
                  ) {
                    const envelope = parseNativeHistory(msg.modelContent);
                    if (envelope) {
                      return regateNativeMediaForProvider(
                        envelope.messages,
                        modelClient.builtinProviderId,
                        resolveMediaModelId(effectiveModel),
                      );
                    }
                  }

                  const baseMsg: {
                    role: "user" | "assistant" | "system";
                    content: string;
                    providerOptions?: Record<string, Record<string, unknown>>;
                  } = {
                    role: msg.role as "user" | "assistant" | "system",
                    // Why remove thinking tags?
                    // Thinking tags are generally not critical for the context
                    // and eats up extra tokens.
                    content: removeAtlarixTags(
                      removeNonEssentialTags(msg.content ?? ""),
                    ),
                  };

                  return [baseMsg as ModelMessage];
                },
              );

            // OpenRouter-backed (Compass + BYOK): last-resort safety cap. The
            // per-model budget pass runs first; this only kicks in when history is
            // still over the window.
            const isOpenRouterBacked =
              modelClient.builtinProviderId === "compass" ||
              modelClient.builtinProviderId === "openrouter";
            if (isOpenRouterBacked && budgetTracker.isOverLimit()) {
              const nonSystem = limitedHistoryChatMessages.filter(
                (m: ModelMessage) => m.role !== "system",
              );
              const MAX_EXCHANGES = 7;
              const maxMsgs = MAX_EXCHANGES * 2;
              if (nonSystem.length > maxMsgs) {
                let recent = nonSystem.slice(-maxMsgs);
                if (recent.length > 0 && recent[0]?.role !== "user") {
                  const firstUser = recent.findIndex(
                    (m: ModelMessage) => m.role === "user",
                  );
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

            // Current-turn image attachments ride the user message as native image
            // parts (embedded immediately, no tool round-trip) for every model.

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
            // User-attached images ride the current user message as native image
            // parts for EVERY model — no vision-capability pre-filter (opencode /
            // Claude Code parity). Most models accept image input; if a provider
            // genuinely can't, let the SDK surface that honestly rather than
            // silently dropping the image (and lying "this model can't view
            // images"). prepareMessageWithAttachments filters to image/* and caps
            // count/size. Tool-RESULT media keeps its own transport gate in
            // tool-model-output.ts — a real OpenAI-compatible limitation, distinct
            // from this user-image path.
            const lastUserTransportImages = ((): Array<{
              filename: string;
              mimeType: string;
              data: string;
            }> => {
              if (storedFileAttachments.length > 0)
                return storedFileAttachments;
              return (lastUserTransportMessage?.fileAttachments ?? [])
                .filter((f: { mimeType?: string }) =>
                  f.mimeType?.startsWith("image/"),
                )
                .map(
                  (f: {
                    filename: string;
                    mimeType: string;
                    data: string;
                  }) => ({
                    filename: f.filename,
                    mimeType: f.mimeType,
                    data: f.data,
                  }),
                );
            })();
            // PDFs, unlike images, ARE capability-gated. The image path can send
            // optimistically because a rejection is cheap and recoverable; a PDF
            // is megabytes, and a model that cannot take a document part is the
            // common case, not the exception. Gating on the models.dev `pdf`
            // input modality means a "no" simply leaves the local text extraction
            // running — which is what every PDF has always used, and is the right
            // answer for a text-based one regardless.
            //
            // What this buys is the case extraction cannot serve at all: a SCANNED
            // or image-only PDF, where extraction returns nothing and the tool has
            // to say so.
            const lastUserTransportPdfs = ((): Array<{
              filename: string;
              mimeType: string;
              data: string;
            }> => {
              if (
                !detectPdfCapability(
                  modelClient.builtinProviderId,
                  resolveMediaModelId(effectiveModel),
                )
              ) {
                return [];
              }
              const source =
                storedFileAttachments.length > 0
                  ? storedFileAttachments
                  : (lastUserTransportMessage?.fileAttachments ?? []);
              return source
                .filter(
                  (f: { mimeType?: string }) => f.mimeType === PDF_MIME_TYPE,
                )
                .map(
                  (f: {
                    filename: string;
                    mimeType: string;
                    data: string;
                  }) => ({
                    filename: f.filename,
                    mimeType: f.mimeType,
                    data: f.data,
                  }),
                );
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
                lastUserTransportImages.length > 0 ||
                lastUserTransportPdfs.length > 0)
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
                      imageAttachments: lastUserTransportImages,
                      pdfAttachments: lastUserTransportPdfs,
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
              effectiveAppId,
              effectiveModel,
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
              ttftStartRef,
              abortController,
            };

            // processResponseChunkUpdate extracted to
            // ./chat_stream/turn-runner/response-chunk-update; bound to the turn
            // config here so the two callback slots keep their (args) => Promise
            // shape. Its own `fullResponse` param is the live text, not ctx.fullResponse.
            const processResponseChunkUpdate = (args: {
              fullResponse: string;
            }) =>
              runProcessResponseChunkUpdate(
                {
                  req,
                  updatedChat,
                  event,
                  streamId,
                  placeholderAssistantMessage,
                },
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

            /**
             * Which turn runner? Answered from the WORK MODE, not from the persisted
             * `selectedChatMode`.
             *
             * It used to read `settings.selectedChatMode === "ask"`, and
             * `chatModeForWorkMode` maps everything except `build` to "ask" — so
             * **debug ran through the ask branch**, which sets `singleRound: true`.
             * Debug kept the SDK's inner multi-step loop but lost the OUTER agentic
             * loop and the completion gates, and three places in this codebase say
             * that is wrong: `mode-tool-registry` ("debug = full surface, differs from
             * build by prompt discipline only"), `isReadOnlyWorkMode` (debug is not
             * read-only), and `run-agent-turn`, which says "Build/debug: run the
             * completion gates before ending".
             *
             * Fixed HERE rather than in the mapping for two reasons. Anyone already on
             * Debug has `selectedChatMode: "ask"` persisted, so a mapping-only fix
             * would do nothing for them until they re-picked a mode. And the real
             * question is "is this mode read-only?" — `selectedChatMode` was a proxy
             * for it, and deriving the decision from the work mode leaves one source
             * of truth instead of two that can disagree.
             */
            if (isReadOnlyWorkMode(effectiveWorkMode) && effectiveApp) {
              // Ask/explore arm extracted to ./chat_stream/turn-runner/ask-branch.
              const askBranchDeps: AskBranchDeps = {
                req,
                event,
                settings,
                updatedChat,
                appPath,
                effectiveAppId,
                effectiveModel,
                effectiveWorkMode,
                modeBlockKey,
                modelClient,
                modelContextResolved,
                placeholderAssistantMessage,
                systemPrompt,
                taskLedgerBlock,
                simpleStreamTextDeps,
                streamTurnId,
                STREAM_CONTINUATION_MAX,
                chatMessages,
                activeUserAgent,
                hasWorkspace,
                promptIdentityOpts,
                logTtftOnce,
                handleStreamStall,
                handleStreamActivityPulse,
                handleToolInputProgress,
                handleToolInputDelta,
                abortController,
                usableTokens,
                processResponseChunkUpdate,
                applyTierEscalation,
              };
              await runAskBranch(ctx, askBranchDeps);
            } else {
              // Build/debug arm extracted to ./chat_stream/turn-runner/build-branch.
              const buildBranchDeps: BuildBranchDeps = {
                req,
                event,
                settings,
                updatedChat,
                appPath,
                effectiveAppId,
                effectiveModel,
                effectiveWorkMode,
                modelClient,
                modelContextResolved,
                placeholderAssistantMessage,
                systemPrompt,
                taskLedgerBlock,
                simpleStreamTextDeps,
                streamTurnId,
                STREAM_CONTINUATION_MAX,
                chatMessages,
                activeUserAgent,
                hasWorkspace,
                logTtftOnce,
                handleStreamStall,
                handleStreamActivityPulse,
                handleToolInputProgress,
                handleToolInputDelta,
                abortController,
                usableTokens,
                processResponseChunkUpdate,
                applyTierEscalation,
                buildToolStreamOpts,
                streamDebugLogging,
              };
              const buildResult = await runBuildBranch(ctx, buildBranchDeps);
              // Preserve the inline original's early return from runStream.
              if (buildResult?.earlyReturn) return buildResult.value;
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
            // Save-gated finalization extracted to ./chat_stream/turn-runner/finalize.
            await finalizeTurn(ctx, {
              req,
              event,
              updatedChat,
              appPath,
              effectiveAppId,
              effectiveModel,
              modelClient,
              placeholderAssistantMessage,
              streamId,
              streamTurnId,
              usedCompassThisStream,
              userPrompt,
              abortController,
            });
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
        // Outer-catch body extracted to ./chat_stream/turn-runner/finalize.
        const outcome = await handleTurnError(error, ctx, {
          overflowRetried,
          req,
          event,
          abortController,
          streamId,
        });
        // Preserve the inline original's context-overflow retry (return runStream()).
        if (outcome?.rerun) return runStream();
      } finally {
        // Finalize any browser/preview session recordings captured this turn and
        // hand the renderer a reference to play them back (proof of work).
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
