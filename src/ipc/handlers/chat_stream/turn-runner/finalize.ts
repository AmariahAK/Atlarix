/**
 * finalizeTurn + handleTurnError — the save-gated finalization block and the
 * runStream outer-catch body, extracted verbatim from runStream. finalizeTurn
 * runs only inside the save gate (the gate + try/catch/finally shell + the
 * temp-file cleanup + ensureTerminal stay in runStream). handleTurnError returns
 * a { rerun } signal for the context-overflow retry arm (the original inline
 * `return runStream()`); the caller re-invokes. retriedAfterOverflowCompaction
 * stays in the outer shell, threaded as the `overflowRetried` ref so it survives
 * the recursion.
 *
 * (Satellite: never imports the parent handler.)
 */

import type { IpcMainInvokeEvent } from "electron";
import type { ChatStreamParams } from "@/ipc/ipc_types";
import type { StreamTurnContext } from "@/ipc/handlers/chat_stream/turn-context";
import type { LargeLanguageModel } from "@/lib/schemas";
import type { ModelClient } from "@/ipc/utils/get_model_client";
import { getAutonomousSessionLog, getAgentActivityForTurn } from "@/ipc/handlers/autonomous-session-state";
import { NetworkStreamDisconnectedError } from "@/ipc/handlers/chat_stream/network-retry";
import { clearInterruptedDraft } from "@/ipc/handlers/chat_stream/stream-lifecycle";
import { activeStreams, activeStreamId, streamSessionByChatId, pendingAskUserArtifactByChatId, partialResponses } from "@/ipc/handlers/chat_stream/stream-state";
import { type ChatResponseEnd } from "@/ipc/ipc_types";
import { stripQuestionsBlockFromResponse } from "@/ipc/utils/cleanFullResponse";
import { FileUploadsState } from "@/ipc/utils/file_uploads_state";
import { getEffectiveModel } from "@/ipc/utils/get_model_client";
import { EmptyModelOutputAfterRetryError, isNoUsableModelOutputError, MODEL_EMPTY_RESPONSE_USER_MESSAGE } from "@/ipc/utils/no_usable_model_output";
import { safeSend } from "@/ipc/utils/safe_sender";
import { stripThinkBlocks } from "@/ipc/utils/thinking_tags";
import { listBackgroundJobs } from "@/lib/agent/background-commands";
import { clearMutationOutcomes } from "@/lib/agent/mutation-verify";
import { runningSubagentCount } from "@/lib/agents/subagent-results";
import { hasNativeToolParts, serializeNativeHistory } from "@/lib/ai/native-history";
import { getStreamTransport } from "@/lib/chat/stream-transport";
import { trackPendingWork } from "@/lib/pending-work";
import { estimateTurnCostUsd } from "@/lib/routing/byok-pricing";
import { ChatPromptSafetyError } from "@/lib/security/chat-prompt-gate";
import { sanitizeAssistantOutput } from "@/lib/security/profanity-filter";
import { ASK_USER_STREAM_STOP, abortReasonSentinel } from "@/lib/stream/stream-stop-sentinels";
import { markLedgerStreamComplete, notifyPlanUiForTurnIfPresent } from "@/lib/tasks/task-ledger";
import {
  takeAuxUsage,
  summarizeAuxBySource,
} from "@/lib/usage/turn-usage-aggregator";
import { readSettings } from "@/main/settings";
import { AI_STREAM_EMPTY_RESPONSE_FALLBACK, AI_STREAMING_ERROR_MESSAGE_PREFIX, SAFETY_FILTER_BLOCKED_MESSAGE, modelFailureUserMessage } from "@/shared/texts";
import log from "electron-log";

const logger = log.scope("chat_stream_handlers");

export interface FinalizeTurnDeps {
  req: ChatStreamParams;
  event: IpcMainInvokeEvent;
  updatedChat: any;
  appPath: string;
  effectiveAppId: number | undefined;
  effectiveModel: LargeLanguageModel;
  modelClient: ModelClient;
  placeholderAssistantMessage: any;
  streamId: number;
  streamTurnId: string;
  usedCompassThisStream: boolean;
  userPrompt: string;
  abortController: AbortController;
}

export async function finalizeTurn(
  ctx: StreamTurnContext,
  deps: FinalizeTurnDeps,
): Promise<void> {
  const {
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
  } = deps;
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
                  getPlanArtifact,
                  setPlanArtifactStatus,
                  updatePlanArtifactContent,
                  withPlanArtifactLock,
                } = await import("@/lib/plans/plan-artifacts");
                // Genuinely "building" only. `status` is a real filter now, so
                // this no longer falls back to the newest plan of any status —
                // which is how a plan the model had just written, and not
                // started, got every step ticked and marked built.
                const buildingPlan = await getLatestPlanArtifact(req.workspaceSessionId, "building");
                if (buildingPlan) {
                  // v10: close out any checklist steps the model left open.
                  const { markAllChecklistStepsDone } = await import(
                    "@/lib/tasks/plan-checklist"
                  );
                  // Under the per-plan lock, re-reading the body inside it. This
                  // runs at turn end, exactly when the model's last update_step
                  // calls may still be in flight — closing out a snapshot fetched
                  // before them would silently revert those marks.
                  await withPlanArtifactLock(buildingPlan.id, async () => {
                    const fresh = await getPlanArtifact(buildingPlan.id);
                    if (!fresh) return;
                    const closed = markAllChecklistStepsDone(fresh.content);
                    if (closed.changed) {
                      await updatePlanArtifactContent(buildingPlan.id, closed.content);
                    }
                  });
                  const updated = await setPlanArtifactStatus(buildingPlan.id, "built");
                  if (updated) {
                    const { emitPlanArtifactUpdated } = await import("@/ipc/utils/emit_plan_artifact");
                    emitPlanArtifactUpdated(event.sender, {
                      planId: updated.id,
                      sessionId: updated.sessionId,
                      content: updated.content,
                      planStatus: updated.planStatus,
                      title: updated.title,
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
            // turn's totals so the usage meter is exact.
            const auxUsage = takeAuxUsage(req.chatId);
            const auxBySource = summarizeAuxBySource(auxUsage);
            if (auxUsage) {
              logger.log(
                `[usage] auxiliary LLM tokens this turn: ${auxUsage.totalTokens} across ${auxUsage.calls} call(s) — ${Object.entries(
                  auxUsage.byLabel,
                )
                  .map(([k, v]) => `${k}=${v.tokens}(${v.calls} call${v.calls === 1 ? "" : "s"})`)
                  .join(", ")}`,
              );
            }
            safeSend(event.sender, "chat:response:end", {
              chatId: req.chatId,
              streamId,
              updatedFiles: false,
              hadToolCallsOrPermissions: ctx.hadToolCallsOrPermissions,
              // The turn ended by asking the user (ask_user) vs finishing normally —
              // drives the "needs your answer" vs "finished responding" notification.
              endedWaitingOnUser: ctx.askUserEndedTurn === true,
              usedCompass: usedCompassThisStream,
              ...(auxUsage ? { auxTokens: auxUsage.totalTokens } : {}),
              // Per-source split so the UI can separate work the user asked for
              // (sub-agents) from work the app did on their behalf (compaction).
              // The old single figure lumped both under a "Sub-agents" label.
              ...(auxBySource.length > 0 ? { auxBySource } : {}),
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

export type HandleTurnErrorResult = { rerun: true } | undefined;

export interface HandleTurnErrorDeps {
  overflowRetried: { value: boolean };
  req: ChatStreamParams;
  event: IpcMainInvokeEvent;
  abortController: AbortController;
  streamId: number;
}

export async function handleTurnError(
  error: unknown,
  ctx: StreamTurnContext,
  deps: HandleTurnErrorDeps,
): Promise<HandleTurnErrorResult> {
  const { overflowRetried, req, event, abortController, streamId } = deps;
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
          // Image- or PDF-content rejection (text-only chat API): surface a
          // friendly "switch model" message instead of the raw provider dump.
          // Handled in simple-stream-text's onError for the streaming path; this
          // covers a pre-stream throw that reaches the outer catch.
          const {
            isImageContentRejectionError,
            imageUnsupportedUserMessage,
            isPdfContentRejectionError,
            pdfUnsupportedUserMessage,
          } = await import("@/lib/chat/image-embed-gate");
          // PDF first — same ordering reason as the streaming path: a turn can
          // carry both, and the image matcher would otherwise claim it.
          const contentRejectionMessage = isPdfContentRejectionError(error)
            ? pdfUnsupportedUserMessage()
            : isImageContentRejectionError(error)
              ? imageUnsupportedUserMessage()
              : null;
          if (contentRejectionMessage) {
            safeSend(event.sender, "chat:response:error", {
              chatId: req.chatId,
              streamId,
              error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${contentRejectionMessage}`,
            });
            safeSend(event.sender, "chat:response:end", {
              chatId: req.chatId,
              streamId,
              updatedFiles: false,
              hadToolCallsOrPermissions: false,
            } satisfies ChatResponseEnd);
            if (activeStreamId.get(req.chatId) === streamId)
              activeStreams.delete(req.chatId);
            ctx.streamTerminated = true;
            FileUploadsState.getInstance().clear(req.chatId);
            return;
          }
        }
        {
          const { isContextOverflowError } = await import("@/lib/context/compaction");
          if (isContextOverflowError(error)) {
            // v11.1: the provider just told us our context estimate was too
            // big. Lower the cached window estimate (feedback loop), force one
            // aggressive compaction round, and retry the dispatch ONCE.
            if (!overflowRetried.value) {
              overflowRetried.value = true;
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
                return { rerun: true as const };
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
}
