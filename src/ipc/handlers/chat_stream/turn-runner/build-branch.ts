/**
 * runBuildBranch — the build/debug arm of runStream: build-profile
 * PermissionInterceptor, full write-capable toolset, the agentic tool loop with
 * repetition guard + tier escalation, and runAgentTurn({ mode: "build" }) with
 * its own try/catch(streamError)/finally. Extracted verbatim from runStream;
 * results flow back through `ctx`. Enclosing config + helper closures via `deps`.
 *
 * (Satellite: never imports the parent handler.)
 */

import type { IpcMainInvokeEvent } from "electron";
import { recordFileWrite, resolveReadScope } from "@/lib/tools/file-read-log";
import type { ModelMessage } from "ai";
import type { WorkMode, UserSettings, LargeLanguageModel } from "@/lib/schemas";
import type { ChatStreamParams } from "@/ipc/ipc_types";
import type { StreamTurnContext } from "@/ipc/handlers/chat_stream/turn-context";
import type { ModelClient } from "@/ipc/utils/get_model_client";
import type { SimpleStreamTextDeps } from "@/ipc/handlers/chat_stream/turn-runner/simple-stream-text";
import type { UserAgent } from "@/lib/agents/user-agents";
import { shouldAutoApprovePermissions } from "@/lib/agents/agent-runtime";
import { attachDelegationToolsToSet } from "@/lib/agents/register-delegation-tools";
import { ASK_USER_STREAM_STOP, LOOP_REPETITION_STREAM_STOP, FORCE_TEXT_FINISH_STREAM_STOP, abortReasonSentinel, streamStopAbortReason } from "@/lib/stream/stream-stop-sentinels";
import { createAgenticRepetitionState, buildLoopCorrectionMessage, type AgenticRepetitionOutcome } from "@/lib/streaming/agentic-loop-repetition";
import { feedTerminalOutput } from "@/lib/streams/StreamManager";
import { getToolActivityLabel } from "@/lib/tool-activity-labels";
import { ToolRegistry } from "@/lib/tools";
import { toolExecutionChatMode } from "@/lib/work-mode";
import { captureSafe } from "@/main/lib/analytics";
import { type ChatContextReport } from "@/ipc/ipc_types";
import { getEffectiveModelForOptions } from "@/ipc/utils/get_model_client";
import { safeSend } from "@/ipc/utils/safe_sender";
import { cwdNoteForCommand } from "@/lib/commands/cwd-note";
import { stripThinkBlocks } from "@/ipc/utils/thinking_tags";
import { estimateTokens } from "@/ipc/utils/token_utils";
import { appendAutonomousOp, autonomousOpFromPermissionExec } from "@/ipc/handlers/autonomous-session-state";
import { emitCompactionMirroredActivity, emitModelCompactionActivity } from "@/ipc/handlers/chat_stream/compaction-activity";
import { runCommandGateResult, emitFilePermissionActivity, enrichPermissionRequestForUi, emitAutoApprovedWritePreview, runCommandCategoryGateToolResult, shouldSkipPermissionWaitForRunCommand, requiresHumanReviewDespiteAutoApprove } from "@/ipc/handlers/chat_stream/permission-ui";
import { isSystemScopeCommand } from "@/lib/system-scope-commands";
import { resolveAskUserToolResult, flushInterruptedDraft } from "@/ipc/handlers/chat_stream/stream-lifecycle";
import { partialResponses } from "@/ipc/handlers/chat_stream/stream-state";
import { runToolExecute, attachSearchRoutingActivity } from "@/ipc/handlers/chat_stream/tool-execute";
import { runStreamRoundWithEmptyOutputRetry } from "@/ipc/handlers/chat_stream/turn-runner/round-retry";
import { simpleStreamText } from "@/ipc/handlers/chat_stream/turn-runner/simple-stream-text";
import { applyFileScopePreflightInStream } from "@/ipc/handlers/file_permission_preflight";
import { registerInterceptor } from "@/ipc/handlers/permissions/handlers";
import { PermissionInterceptor } from "@/ipc/handlers/permissions/interceptor";
import { recordUnverifiedEdit, clearUnverifiedEdit } from "@/lib/agent/mutation-verify";
import { runAgentTurn } from "@/lib/agent/run-agent-turn";
import { sanitizeJsonSchemaForProvider } from "@/lib/ai/normalize-tool-schema";
import { buildToolModelOutput, redactToolMediaForDisplay, extractImageMedia } from "@/lib/ai/tool-model-output";
import { toolActivityStatusFor } from "@/lib/tools/tool-result-status";
import { stripHallucinatedAtlarixToolTagsFromDelta } from "@/lib/chat/answer-display";
import { summarizeToolResultForActivityDetail, toolResultTextForExpand } from "@/lib/chat/stream-tool-display";
import { computeDiffHunks } from "@/lib/diff/compose-hunks";
import { simplifyToolParametersForProfile } from "@/lib/routing/model-capability-profile";
import { detectReasoningCapability, resolveReasoningCatalogModelId } from "@/lib/routing/reasoning-detector";
import { shouldUseTextToolFallback } from "@/lib/stream/text-tool-fallback";
import { getPlanCompletionFeedback } from "@/lib/tasks/plan-completion-gate";
import { recordToolOnLedger } from "@/lib/tasks/task-ledger";
import { resolveToolsetForSession } from "@/lib/tools/resolve-toolset";
import {
  describeToolForMode,
  peripheralToolNames,
  revealSavings,
} from "@/lib/tools/tool-reveal";
import { ToolSet, jsonSchema as aiJsonSchema } from "ai";
import log from "electron-log";
import {
  resolveEditStatsModel,
  dispatchedModelIdentity,
} from "@/lib/stats/edit-stats";

const logger = log.scope("chat_stream_handlers");

export interface BuildBranchDeps {
  req: ChatStreamParams;
  event: IpcMainInvokeEvent;
  settings: UserSettings;
  updatedChat: any;
  appPath: string;
  effectiveAppId: number | undefined;
  effectiveModel: LargeLanguageModel;
  effectiveWorkMode: WorkMode;
  modelClient: ModelClient;
  modelContextResolved: { tierLimit: number };
  placeholderAssistantMessage: any;
  systemPrompt: string;
  taskLedgerBlock: string | null;
  simpleStreamTextDeps: SimpleStreamTextDeps;
  streamTurnId: string;
  STREAM_CONTINUATION_MAX: number;
  chatMessages: ModelMessage[];
  activeUserAgent: UserAgent | null;
  hasWorkspace: boolean;
  logTtftOnce: () => void;
  handleStreamStall: () => void;
  handleStreamActivityPulse: () => void;
  handleToolInputProgress: (info: { toolName: string; deltaCount: number }) => void;
  handleToolInputDelta: (info: {
    toolCallId: string;
    toolName: string;
    argsTextSoFar: string;
  }) => void;
  abortController: AbortController;
  /** Window minus the reply reserve — what a request may actually occupy. */
  usableTokens: number;
  processResponseChunkUpdate: (args: { fullResponse: string }) => Promise<string>;
  applyTierEscalation: (args: {
    agenticIteration: number;
    iterationInterval: number;
    runningTokens: number;
    mode: string;
  }) => Promise<boolean>;
  buildToolStreamOpts: () => {
    turnId: string;
    abortController: AbortController;
    workspaceSessionId: string | undefined;
    unattended: boolean;
  };
  streamDebugLogging: boolean;
}

/** Sentinel: the build arm hit its user-abort partial-save path, which in the
 * inline original returned from runStream. The caller must `return` this value. */
export type BuildBranchResult = { earlyReturn: true; value: number } | undefined;

export async function runBuildBranch(
  ctx: StreamTurnContext,
  deps: BuildBranchDeps,
): Promise<BuildBranchResult> {
  const {
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
  } = deps;
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
              // THIS turn's mode, so the command sandbox cannot be retuned by
              // another window's mode picker mid-turn.
              effectiveWorkMode,
              // THIS turn's abort signal, so Stop can unwind an approval the
              // interceptor is blocked on (the escalation lanes sit too deep to
              // reach the controller themselves).
              abortController.signal,
              // THIS turn's model, so what it writes is attributed to it. Taken from
              // the client that actually DISPATCHED: when the selected provider has
              // no usable key the turn silently falls back to Atlarix Core, and
              // `effectiveModel` still names the original choice — crediting that
              // would put Core's work under the user's own key.
              resolveEditStatsModel(
                effectiveModel,
                dispatchedModelIdentity(modelClient),
              ),
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
                // v14.34 per-mode progressive reveal — see ask-branch and
                // lib/tools/tool-reveal.ts. Name + schema always bind; only a
                // peripheral tool's description is trimmed to a pointer.
                description: describeToolForMode(toolMeta, effectiveWorkMode),
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
                // v7: the callback receives an options OBJECT (toolCallId, input,
                // output) rather than the bare output. Only `output` is needed here.
                toModelOutput: ({ output }: { output: unknown }) =>
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
                  /**
                   * Return a tool result AND record it for the activity event.
                   *
                   * The `finally` below builds the completion event from
                   * `toolResultForActivity`, which only the direct-return path
                   * assigned — so every permission-gated tool (i.e. every command)
                   * emitted a completion with no result attached. Routing those
                   * returns through here keeps the two in step by construction
                   * rather than by remembering.
                   */
                  const recordActivityResult = <T>(value: T): T => {
                    toolResultForActivity = value;
                    return value;
                  };
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
                    // THIS turn's mode. `effectiveWorkMode` already folds in
                    // `req.workModeOverride` (chat_stream_handlers computes it via
                    // resolveEffectiveWorkMode with the override passed in), so it
                    // is the whole answer.
                    //
                    // It used to re-read `workModePreference` from global settings
                    // to honour a mid-turn picker change. That setting is ONE
                    // app-wide value, so it could not tell this window's picker from
                    // another window's — and a second window opening in Ask mode
                    // started refusing this Build turn's file writes at
                    // `edit.ts:727/740`. Same defect as the sandbox one, different
                    // symptom. Re-supporting mid-turn switching needs a per-chat
                    // channel, not a global read.
                    const buildLiveWorkMode: WorkMode = effectiveWorkMode;
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
                        // This turn's mode — never a global re-read (see
                        // buildLiveWorkMode above).
                        const gate = runCommandGateResult(cmd, effectiveWorkMode);
                        if (gate) return gate;
                        const categoryBlock = runCommandCategoryGateToolResult(
                          cmd,
                          effectiveAppId,
                          req.chatId,
                          event.sender,
                          workspacePath,
                        );
                        if (categoryBlock) return categoryBlock;
                      }
                      // DIAG_146 (bug 8): time the main-side permission path
                      // (preflight + buffer + UI enrich/diff) for slow edit cards.
                      const __permEditT0 = Date.now();
                      const filePref = await applyFileScopePreflightInStream(
                        permRequest,
                        effectiveAppId,
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
                        !requiresHumanReviewDespiteAutoApprove(permRequest) &&
                        (filePref.skipPermissionWait ||
                          (permRequest.operation === "run_command" &&
                            shouldSkipPermissionWaitForRunCommand(
                              buildRunCmd,
                              effectiveAppId,
                              req.chatId,
                              event.sender,
                              workspacePath,
                            )) ||
                          shouldAutoApprovePermissions(settings.agentMode, req.chatId) ||
                          permissionInterceptor.shouldAlwaysAutoApprove(permRequest));
                      // System-scope marker — set true ONLY when a human will approve
                      // (attended). Lets the interceptor run an approved on-device
                      // install / outside-workspace write unsandboxed; unattended runs
                      // never get it (stay sandboxed, handled by the headless approver).
                      if (permRequest.operation === "run_command") {
                        (permRequest.preview as { systemScopeInteractive?: boolean }).systemScopeInteractive =
                          !req.automation && isSystemScopeCommand(buildRunCmd, workspacePath);
                      }
                      permissionInterceptor.bufferOperation(operationId, permRequest, skipPermissionWait);

                      const pushWrittenPaths = () => {
                        if (!permRequest) return;
                        const preview = permRequest.preview as { path?: string; content?: string };
                        if (preview.path) {
                          ctx.filesWrittenInThisExchange.push(preview.path);
                          // The write LANDED, so the agent's view of this file is current
                          // again — refresh the read record. Without this, every edit in a
                          // multi-step change would demand a re-read of a file the agent
                          // itself had just authored.
                          if (typeof preview.content === "string") {
                            recordFileWrite(
                              resolveReadScope({
                                _scopeSessionId: req.workspaceSessionId ?? undefined,
                                _scopeChatId: req.chatId,
                              }),
                              preview.path,
                              preview.content,
                            );
                          }
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
                        automationId?: string;
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
                          permRequest.operation === "edit_file"
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
                        const isFileWrite = permRequest.operation === "edit_file";
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
                                // A `cd` inside a command lasts exactly as long as
                                // that shell. Without saying so, a model that
                                // prefixed `cd /somewhere &&` believes it moved,
                                // and every relative path it uses afterwards
                                // silently resolves somewhere else — which is
                                // precisely how one run ended up hunting for a
                                // workspace file inside the installed app bundle.
                                // Claude Code hit the same failure and fixed it
                                // the same way: state the working directory did
                                // not change.
                                ...cwdNoteForCommand(
                                  String(execResult.command ?? ""),
                                  (permRequest.preview as { workingDirectory?: string } | undefined)
                                    ?.workingDirectory,
                                ),
                              }
                            : permRequest.operation === "automation_write"
                              ? {
                                  // The id only exists after approval. The tool
                                  // description tells the model to run the
                                  // automation it just created, and name is not a
                                  // key — two automations may share one — so
                                  // without this it could only guess via `list`.
                                  ...(execResult.automationId
                                    ? { automation_id: execResult.automationId }
                                    : {}),
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
                        // A non-zero exit is NOT a success, and must not be
                        // described as one. The failure was already reachable —
                        // `exitCode` rides in displayFields, tool-execute.ts
                        // attaches per-exit-code `guidance`, and the completion
                        // gate refuses to finish on it — but the message still
                        // read "Successfully executed" in the same payload as
                        // `exitCode: 1`. Mixed signals in one result are how a
                        // model ends up reporting a failed command as done.
                        const failedExit =
                          typeof execResult.exitCode === "number" && execResult.exitCode !== 0;
                        const verb =
                          permRequest.operation === "edit_file" ? "wrote" : "executed";
                        const target =
                          (permRequest.preview as { path?: string }).path || "operation";
                        return JSON.stringify({
                          success: true,
                          message: failedExit
                            ? `Ran ${target} — it FAILED with exit code ${execResult.exitCode}. Read the output and fix the cause before continuing.`
                            : `Successfully ${verb} ${target}`,
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
                            // This is the branch UNATTENDED runs take — headless,
                            // benchmarks, the automations path — so it is the one
                            // whose missing result actually reaches a trajectory.
                            return recordActivityResult(jsonAfterSuccessfulExec(execResult));
                          }
                          if (execResult.exitCode !== undefined) {
                            logger.log(
                              `[Build Mode] Autonomous exec command failed: ${operationId} (exit ${execResult.exitCode})`,
                            );
                            activityStatus = "error";
                            return recordActivityResult(JSON.stringify({
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
                            }));
                          }
                          activityStatus = "error";
                          return recordActivityResult(JSON.stringify({
                            success: false,
                            error: execMeta.error ?? execResult.error ?? "Execution failed",
                            operation: permRequest.operation,
                            path: (permRequest.preview as { path?: string }).path,
                          }));
                        } catch (error) {
                          logger.error(`[Build Mode] Autonomous permission error: ${operationId}`, error);
                          activityStatus = "error";
                          return recordActivityResult(JSON.stringify({
                            success: false,
                            error: `Permission request failed: ${error instanceof Error ? error.message : String(error)}`,
                            timedOut: true,
                          }));
                        }
                      }

                      // Send permission request to frontend for display
                      const __enrichT0 = Date.now();
                      const __enriched = enrichPermissionRequestForUi(permRequest, effectiveAppId, workspacePath);
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

                          // Record what the activity event should carry. Every
                          // return in this permission branch used to leave
                          // `toolResultForActivity` unassigned, so the `finally`
                          // below computed `resultText` from `undefined` and
                          // dropped it — which is why `run_command`, the tool that
                          // ALWAYS takes this branch, reported no output anywhere
                          // downstream. Benchmark trajectories are audited by
                          // reading what the agent did; a command with no visible
                          // output is materially weaker evidence than one with it.
                          return recordActivityResult(jsonAfterSuccessfulExec(execResult));
                        } else {
                          // Check if this was a command failure vs user rejection
                          const execResult = permissionInterceptor.getExecutionResult(operationId);

                          if (execResult.exitCode !== undefined) {
                            // Command was executed but failed - include error details for AI
                            logger.log(`[Build Mode] Command failed: ${operationId} (exit ${execResult.exitCode})`);
                            // "error", not the default "done": a non-zero exit
                            // rendered with a green tick and a past-tense success
                            // label. Same defect the comment further down records
                            // fixing for RETURNED failures — this branch was missed,
                            // and it is the one every command goes through.
                            activityStatus = "error";
                            return recordActivityResult(JSON.stringify({
                              success: false,
                              error: execResult.error || `Command failed with exit code ${execResult.exitCode}`,
                              exitCode: execResult.exitCode,
                              output: execResult.output,  // Include terminal output for AI context
                              operation: permRequest.operation,
                              path: (permRequest.preview as any).path || (permRequest.preview as any).command,
                            }));
                          } else {
                            // User actually rejected or timeout
                            logger.log(`[Build Mode] Permission denied: ${operationId}`);
                            activityStatus = "error";
                            return recordActivityResult(JSON.stringify({
                              success: false,
                              error: "Permission denied by user",
                              operation: permRequest.operation,
                              path: (permRequest.preview as any).path,
                            }));
                          }
                        }
                      } catch (error) {
                        // Stop pressed during the wait → re-throw so streamText
                        // unwinds the round (don't feed the model a tool result).
                        if (abortController.signal.aborted) throw error;
                        logger.error(`[Build Mode] Permission error: ${operationId}`, error);
                        activityStatus = "error";
                        return recordActivityResult(JSON.stringify({
                          success: false,
                          error: `Permission request failed: ${error instanceof Error ? error.message : String(error)}`,
                        }));
                      }
                    }
                  }

                    // Not a permission request - return result directly.
                    // (Repetition is recorded once at the wrapper top — Fix R.)
                    recordBuildToolLedger(toolName, result);
                    // A tool reports failure two ways: by THROWING, and by RETURNING a
                    // failure shape (`{success:false}`, or the legacy bare `{error}`).
                    // `activityStatus` was only set in the `catch` below, so a RETURNED
                    // failure emitted status "done" and the card rendered with a green
                    // tick and the past-tense success label — `glob` refusing a pattern
                    // showed as "Found files matching …" beside its own error text.
                    // Same class as v14.22.0's "Successfully executed" next to a non-zero
                    // exit, and it affected every tool using the return convention.
                    activityStatus = toolActivityStatusFor(result);
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
            {
              const trimmed = peripheralToolNames(buildToolsToInclude, effectiveWorkMode);
              const { full, bound } = revealSavings(buildToolsToInclude, effectiveWorkMode);
              logger.log(
                `[tool-reveal] mode=${effectiveWorkMode} core=${buildToolsToInclude.length - trimmed.length} peripheral=${trimmed.length} ` +
                  `desc ${full}→${bound} chars (−${full - bound}); pointer=tool_help` +
                  (trimmed.length > 0 ? ` [${trimmed.join(", ")}]` : ""),
              );
            }

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

            const { containsTextToolCall, parseTextToolCalls, stripToolCallXML } = await import("@/ipc/utils/text_tool_parser");
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
                          // This turn's mode — never a global re-read (see
                          // buildLiveWorkMode above).
                          const gate = runCommandGateResult(cmd, effectiveWorkMode);
                          if (gate) {
                            iterationResults.push({ tool: toolCall.toolName, result: gate });
                            continue;
                          }
                          const categoryBlock = runCommandCategoryGateToolResult(
                            cmd,
                            effectiveAppId,
                            req.chatId,
                            event.sender,
                            workspacePath,
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
                          !requiresHumanReviewDespiteAutoApprove(permRequest) &&
                          (filePref.skipPermissionWait ||
                            (permRequest.operation === "run_command" &&
                              shouldSkipPermissionWaitForRunCommand(
                                agenticRunCmd,
                                effectiveAppId,
                                req.chatId,
                                event.sender,
                                workspacePath,
                              )) ||
                            shouldAutoApprovePermissions(settings.agentMode, req.chatId) ||
                            permissionInterceptor.shouldAlwaysAutoApprove(permRequest));
                        // System-scope marker (see the native-FC site above) — attended-only.
                        if (permRequest.operation === "run_command") {
                          (permRequest.preview as { systemScopeInteractive?: boolean }).systemScopeInteractive =
                            !req.automation && isSystemScopeCommand(agenticRunCmd, workspacePath);
                        }
                        permissionInterceptor.bufferOperation(operationId, permRequest, skipPermissionWait);
                        const pushAgenticWrittenPaths = () => {
                          if (!permRequest) return;
                          const preview = permRequest.preview as { path?: string };
                          if (preview.path) {
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
                            request: enrichPermissionRequestForUi(permRequest, effectiveAppId, workspacePath),
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
                    abortController,
                    continuationTurnId: String(placeholderAssistantMessage.id),
                    streamTurnId,
                    tierLimit: modelContextResolved.tierLimit,
                    usableTokens,
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
                      stopSentinel === LOOP_REPETITION_STREAM_STOP
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
                // In the inline original this `return req.chatId` exited runStream
                // entirely (skipping finalization, still running the outer finally).
                // Extracted: signal the caller to do the same via this sentinel.
                return { earlyReturn: true as const, value: req.chatId };
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
}
