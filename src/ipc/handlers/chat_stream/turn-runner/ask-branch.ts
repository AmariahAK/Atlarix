/**
 * runAskBranch — the ask/explore (read-only) arm of runStream: builds the
 * ask-profile PermissionInterceptor, wires terminal-output forwarding + the
 * read-only toolset, and drives runAgentTurn({ mode: "ask", singleRound: true }).
 * Extracted verbatim from runStream; results flow back through `ctx`
 * (fullResponse / turnParked / turnForcedTextFinish). Enclosing config +
 * helper closures are threaded via `deps`.
 *
 * (Satellite: never imports the parent handler.)
 */

import log from "electron-log";
import type { IpcMainInvokeEvent } from "electron";
import type { ModelMessage, ToolSet } from "ai";
import type { WorkMode, UserSettings, LargeLanguageModel } from "@/lib/schemas";
import type { ChatContextReport, ChatStreamParams } from "@/ipc/ipc_types";
import type { StreamTurnContext } from "@/ipc/handlers/chat_stream/turn-context";
import type { ModeSystemKey } from "@/prompts/system_prompt";
import type { ModelClient } from "@/ipc/utils/get_model_client";
import type { SimpleStreamTextDeps } from "@/ipc/handlers/chat_stream/turn-runner/simple-stream-text";
import type { UserAgent } from "@/lib/agents/user-agents";
import { shouldAutoApprovePermissions } from "@/lib/agents/agent-runtime";
import { isSystemScopeCommand } from "@/lib/system-scope-commands";
import { attachDelegationToolsToSet } from "@/lib/agents/register-delegation-tools";
import {
  FORCE_TEXT_FINISH_STREAM_STOP,
  streamStopAbortReason,
} from "@/lib/stream/stream-stop-sentinels";
import {
  createAgenticRepetitionState,
  buildLoopCorrectionMessage,
  type AgenticRepetitionOutcome,
} from "@/lib/streaming/agentic-loop-repetition";
import { feedTerminalOutput } from "@/lib/streams/StreamManager";
import { getToolActivityLabel } from "@/lib/tool-activity-labels";
import { ToolRegistry } from "@/lib/tools";
import { getModeToolAllowSets } from "@/lib/tools/mode-tool-registry";
import { toolExecutionChatMode } from "@/lib/work-mode";
import { constructSystemPromptParts } from "@/prompts/system_prompt";
import { getEffectiveModelForOptions } from "@/ipc/utils/get_model_client";
import { safeSend } from "@/ipc/utils/safe_sender";
import { estimateTokens, getContextWindow } from "@/ipc/utils/token_utils";
import {
  emitCompactionMirroredActivity,
  emitModelCompactionActivity,
} from "@/ipc/handlers/chat_stream/compaction-activity";
import {
  runCommandGateResult,
  emitFilePermissionActivity,
  enrichPermissionRequestForUi,
  runCommandCategoryGateToolResult,
  shouldSkipPermissionWaitForRunCommand,
} from "@/ipc/handlers/chat_stream/permission-ui";
import { resolveAskUserToolResult } from "@/ipc/handlers/chat_stream/stream-lifecycle";
import {
  runToolExecute,
  attachSearchRoutingActivity,
} from "@/ipc/handlers/chat_stream/tool-execute";
import { runStreamRoundWithEmptyOutputRetry } from "@/ipc/handlers/chat_stream/turn-runner/round-retry";
import { simpleStreamText } from "@/ipc/handlers/chat_stream/turn-runner/simple-stream-text";
import { applyFileScopePreflightInStream } from "@/ipc/handlers/file_permission_preflight";
import { registerInterceptor } from "@/ipc/handlers/permissions/handlers";
import { PermissionInterceptor } from "@/ipc/handlers/permissions/interceptor";
import { runAgentTurn } from "@/lib/agent/run-agent-turn";
import { renderUserAgentSystemBlock } from "@/lib/agents/user-agents";
import { normalizeToolInputSchemaForAiSdk } from "@/lib/ai/normalize-tool-schema";
import {
  buildToolModelOutput,
  redactToolMediaForDisplay,
  extractImageMedia,
} from "@/lib/ai/tool-model-output";
import { toolActivityStatusFor } from "@/lib/tools/tool-result-status";
import {
  summarizeToolResultForActivityDetail,
  toolResultTextForExpand,
} from "@/lib/chat/stream-tool-display";
import { simplifyToolParametersForProfile } from "@/lib/routing/model-capability-profile";
import { resolveReasoningCatalogModelId } from "@/lib/routing/reasoning-detector";
import { resolveToolsetForSession } from "@/lib/tools/resolve-toolset";
import {
  describeToolForMode,
  peripheralToolNames,
  revealSavings,
} from "@/lib/tools/tool-reveal";

const logger = log.scope("chat_stream_handlers");

export interface AskBranchDeps {
  req: ChatStreamParams;
  event: IpcMainInvokeEvent;
  settings: UserSettings;
  updatedChat: any;
  appPath: string;
  effectiveAppId: number | undefined;
  effectiveModel: LargeLanguageModel;
  effectiveWorkMode: WorkMode;
  modeBlockKey: ModeSystemKey;
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
  promptIdentityOpts: {
    activeModel: LargeLanguageModel;
    modelDisplayName: string;
    providerBrand: string;
    labelWithProvider: string | undefined;
  };
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
  contextWindowTokens: number;
  processResponseChunkUpdate: (args: { fullResponse: string }) => Promise<string>;
  applyTierEscalation: (args: {
    agenticIteration: number;
    iterationInterval: number;
    runningTokens: number;
    mode: string;
  }) => Promise<boolean>;
}

export async function runAskBranch(
  ctx: StreamTurnContext,
  deps: AskBranchDeps,
): Promise<void> {
  const {
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
    contextWindowTokens,
    processResponseChunkUpdate,
    applyTierEscalation,
  } = deps;
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
              // THIS turn's mode, so the command sandbox cannot be retuned by
              // another window's mode picker mid-turn.
              effectiveWorkMode,
              // THIS turn's abort signal, so Stop can unwind an approval the
              // interceptor is blocked on (the escalation lanes sit too deep to
              // reach the controller themselves).
              abortController.signal,
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
            // v14.34 per-mode progressive reveal: every offered tool's NAME and
            // SCHEMA still bind upfront (so nothing is unreachable and nothing is
            // lost across compaction) — only a peripheral tool's DESCRIPTION is
            // trimmed to one line plus a `tool_help` pointer. The manifest lists
            // exactly these names either way.
            const askOfferedNames = askToolsToInclude.map((t) => t.name);

            const askTools: ToolSet = {};
            for (const tool of askToolsToInclude) {
              askTools[tool.name] = {
                description: describeToolForMode(tool, effectiveWorkMode),
                inputSchema: normalizeToolInputSchemaForAiSdk(
                  simplifyToolParametersForProfile(
                    tool.parameters ??
                      (tool as { function?: { parameters?: unknown } }).function
                        ?.parameters,
                    askCapabilityProfile,
                  ),
                ) as never,
                // v12 0.2: typed tool outputs (screenshot media / text fallback).
                // v7: the callback receives an options OBJECT (toolCallId, input,
                // output) rather than the bare output. Only `output` is needed here.
                toModelOutput: ({ output }: { output: unknown }) =>
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
                    // THIS turn's mode. `effectiveWorkMode` already folds in
                    // `req.workModeOverride`.
                    //
                    // This used to read `workModePreference` from global settings
                    // and — unlike the Build side — never consulted the override at
                    // all, which made it the worst of the set: an AUTOMATION run
                    // (which sets workModeOverride:"ask", automations/execute-run.ts)
                    // resolved to "build" whenever the user's global preference
                    // happened to be Build, so an unattended read-only run got
                    // Build-mode tool gating. It also let a second window's mode
                    // picker deny tools mid-turn in this one.
                    const liveWorkMode: WorkMode = effectiveWorkMode;
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
                              title: row.title,
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
                            appPath,
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
                              appPath,
                            )) ||
                          shouldAutoApprovePermissions(settings.agentMode, req.chatId) ||
                          askPermissionInterceptor.shouldAlwaysAutoApprove(permRequest);
                        // System-scope marker — attended-only (mirror build-branch).
                        if (permRequest.operation === "run_command") {
                          (permRequest.preview as { systemScopeInteractive?: boolean }).systemScopeInteractive =
                            !req.automation && isSystemScopeCommand(runCmd, appPath);
                        }
                        askPermissionInterceptor.bufferOperation(
                          operationId,
                          permRequest,
                          skipPermissionWait,
                        );

                        if (!skipPermissionWait) {
                          safeSend(event.sender, "permission-request", {
                            chatId: req.chatId,
                            operationId,
                            request: enrichPermissionRequestForUi(permRequest, effectiveAppId, appPath),
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

                    // A RETURNED failure (`{success:false}` / legacy bare `{error}`) is a
                    // failure just as much as a thrown one. `askActivityStatus` was set
                    // only in the `catch`, so a returned failure rendered with a green
                    // tick and a past-tense success label. Same fix as build-branch.
                    askActivityStatus = toolActivityStatusFor(result);
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
            {
              // A reveal that trims silently reads as "we bound everything" when
              // it did not. Say what was trimmed and what it bought.
              const trimmed = peripheralToolNames(askToolsToInclude, effectiveWorkMode);
              const { full, bound } = revealSavings(askToolsToInclude, effectiveWorkMode);
              logger.log(
                `[tool-reveal] mode=${effectiveWorkMode} core=${askToolsToInclude.length - trimmed.length} peripheral=${trimmed.length} ` +
                  `desc ${full}→${bound} chars (−${full - bound}); pointer=tool_help` +
                  (trimmed.length > 0 ? ` [${trimmed.join(", ")}]` : ""),
              );
            }

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
}
