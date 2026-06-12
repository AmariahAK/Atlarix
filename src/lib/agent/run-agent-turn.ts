/**
 * v12 0.1 — runAgentTurn: the unified agent-turn engine.
 *
 * A faithful extraction of the build-mode "SMART AGENTIC TOOL LOOP" from
 * chat_stream_handlers.ts, parameterized by AgentProfile (mode behavior) and
 * TurnRuntime (the handler-scope closures + live state the loop needs).
 *
 * Behavioral contract: with buildBuildProfile this MUST reproduce the legacy
 * build loop byte-for-byte — the Tier 4 eval suite (incl. the native-history
 * byte-stability assertions) runs with the unified flag ON and OFF to prove
 * it. Do not "improve" behavior here while the legacy branches still exist.
 *
 * Deliberately NOT imported: anything from chat_stream_handlers.ts (cycle).
 * All handler state arrives through TurnRuntime.
 */

import type { ModelMessage } from "ai";
import log from "electron-log";
import {
  shouldContinue,
  buildContinuationPrompt,
} from "@/lib/streaming/continuation-handler";
import { getLedger, getLedgerStateString } from "@/lib/tasks/task-ledger";
import {
  isTaskComplete as isLedgerTaskComplete,
  responseHasTaskCompleteTag as isTaskComplete,
  getRemainingSteps,
  buildPendingStepsContinuationPrompt,
} from "@/lib/tasks/completion-detector";
import { runMidLoopCompaction } from "@/lib/context/mid_loop_compaction";
import {
  hasNativeToolParts,
  flattenNativeForCompaction,
  estimateModelMessagesTokens,
} from "@/lib/ai/native-history";
import {
  stripAssistantDisplayContent,
  stripThinkBlocks,
} from "@/ipc/utils/thinking_tags";
import { estimateTokens } from "@/ipc/utils/token_utils";
import { isStreamDebugLoggingEnabled } from "@/lib/stream/stream-debug";
import { STREAM_TOOL_LOOP_DURATION_CAP_MS } from "@/constants/settings_constants";
import {
  hasRunningSubagents,
  hasPendingSubagentResults,
  runningSubagentCount,
} from "@/lib/agents/subagent-results";
import type { AgentProfile } from "./agent-profile";

const logger = log.scope("run-agent-turn");

/**
 * The handler-scope closures + live state the engine drives. 0.1 extracts
 * control flow, not state — these stay owned by `runStream` in the handler.
 */
export interface TurnRuntime {
  readonly chatId: number;
  readonly settings: { enableContextAutoSummarize?: boolean };
  readonly abortController: AbortController;
  /** placeholderAssistantMessage.id — continuation prompt turn id. */
  readonly continuationTurnId: string;
  readonly streamTurnIdForLedger: string;
  readonly tierLimit: number;
  readonly contextWindowTokens: number;
  readonly maxContinuationAttempts: number;
  readonly permissionInterceptor: {
    getAllOperationsCount(): number;
    getExecutedOperationsCount(): number;
  };
  /** Seed history for the turn (the legacy `agenticMessages` start). */
  readonly seedMessages: ModelMessage[];
  /** Turn-level native envelope accumulator (push-mutated in place — B2). */
  readonly nativeTurnMessages: ModelMessage[];
  /** Accumulated stream text at engine entry (usually ""). */
  readonly initialFullResponse: string;

  // ── handler closures (capture event/req/settings/modelClient/...) ──
  safeSend(channel: string, payload: unknown): void;
  emitCompactionActivity(payload: {
    id: string;
    type: string;
    label: string;
    status: "running" | "done";
    detail?: string;
    timestamp: number;
    chatId: number;
  }): void;
  simpleStreamText(opts: {
    chatMessages: ModelMessage[];
    tools: unknown;
    systemPromptOverride: string;
    /** Ask: the per-round dynamic tail (separate system block). */
    dynamicSystemTail?: string;
  }): Promise<unknown>;
  runStreamRound(params: {
    runSimpleStream: () => Promise<unknown>;
    fullResponse: string;
    abortController: AbortController;
    chatId: number;
    processResponseChunkUpdate: (args: { fullResponse: string }) => Promise<string>;
    onFirstModelActivity?: () => void;
    onFirstTextDelta?: () => void;
    onFirstReasoningDelta?: () => void;
    onFirstTextAfterReasoning?: () => void;
    onStreamStall?: () => void;
    onToolInputProgress?: (info: { toolName: string; deltaCount: number }) => void;
    onStreamActivityPulse?: () => void;
    sanitizeTextDelta?: (text: string) => string;
  }): Promise<{
    bundle: { response: Promise<{ messages: ModelMessage[] }> };
    fullResponse: string;
    finishReason: unknown;
  }>;
  processResponseChunkUpdate(args: { fullResponse: string }): Promise<string>;
  onFirstTextDelta(): void;
  onStreamStall(): void;
  onToolInputProgress(info: { toolName: string; deltaCount: number }): void;
  onStreamActivityPulse(): void;
  sanitizeTextDelta(text: string): string;
  applyTierEscalation(args: {
    agenticIteration: number;
    iterationInterval: number;
    runningTokens: number;
    mode: string;
  }): Promise<unknown>;
  getLedgerStateForContinuation(): string | undefined;
}

export interface AgentTurnResult {
  fullResponse: string;
  iterations: number;
  totalToolExecutions: number;
}

/** Normalize an AbortController reason into an Error for throw/propagation. */
function abortReasonError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(String(reason ?? "aborted"));
}

export async function runAgentTurn(
  profile: AgentProfile,
  rt: TurnRuntime,
): Promise<AgentTurnResult> {
  const L = profile.loopLogLabel;
  const streamDebugLogging = isStreamDebugLoggingEnabled();
  const stripXML = profile.stripTextToolXML ?? ((t: string) => t);

  const loopStartTime = Date.now();
  let agenticIteration = 0;
  let agenticProseOnlyStreak = 0;
  let agenticMessages: ModelMessage[] = [...rt.seedMessages];
  const allToolResults: Array<{ tool: string; result: string }> = [];
  let totalToolExecutions = 0;
  let fullResponse = rt.initialFullResponse;
  let streamContinuationAttempts = 0;
  // A model that keeps emitting <task_complete> while a workspace stop-hook is
  // red is nudged at most this many times before the break is honored anyway
  // (bounded loop). v13.1: this counter is now solely the stop-hook gate's
  // (post-write LSP verify was removed).
  const MAX_GATE_BLOCKED_BREAKS = 3;
  let gateBlockedBreaks = 0;

  // Sub-agent wait: when the model would END the turn but background sub-agents
  // are still running (or have a result not yet folded in), we suppress the end
  // and pause at the loop top until a result is ready — re-invoking the model
  // only when there's something new to feed it. Their results arrive via the
  // prepareStep injection on the round we run next.
  let deferEndForSubagents = false;
  const subagentsBlockingEnd = (): boolean =>
    hasRunningSubagents(rt.chatId) || hasPendingSubagentResults(rt.chatId);

  for (;;) {
    // Stream was aborted (compass token-pool stop, user stop, task-complete
    // stop). Do NOT start another round — issuing a request on an aborted
    // controller yields empty output and an AI_NoOutputGeneratedError that
    // would escape as an unhandled rejection. Throw so the handler's catch
    // takes its existing abort path (persist partial / honor ledger-complete).
    if (rt.abortController.signal.aborted) {
      logger.log(
        `${L} Stream aborted (${String(rt.abortController.signal.reason ?? "unknown")}) — stopping turn loop`,
      );
      throw abortReasonError(rt.abortController.signal.reason);
    }
    if (Date.now() - loopStartTime > STREAM_TOOL_LOOP_DURATION_CAP_MS) {
      logger.warn(`${L} Hit duration limit (30 minutes) mode=${profile.mode}`);
      rt.safeSend("chat:activity", {
        id: `duration-limit-${Date.now()}`,
        type: "duration_limit_reached",
        label: "Task paused after 30 minutes",
        detail: "Send a message to continue",
        status: "done",
        timestamp: Date.now(),
        chatId: rt.chatId,
      });
      break;
    }

    // Don't re-invoke the model while we're only waiting on background
    // sub-agents — pause cheaply until one reports (its result injects via
    // prepareStep on the round we run next). Bounded by abort + the 30-min cap.
    if (deferEndForSubagents) {
      deferEndForSubagents = false;
      const running = runningSubagentCount(rt.chatId);
      if (running > 0) {
        rt.safeSend("chat:activity", {
          id: `waiting-subagents-${rt.chatId}`,
          type: "waiting_on_subagents",
          label: `Waiting on ${running} sub-agent${running === 1 ? "" : "s"}`,
          detail: "Results fold in as each finishes",
          status: "running",
          timestamp: Date.now(),
          chatId: rt.chatId,
        });
      }
      while (
        !rt.abortController.signal.aborted &&
        Date.now() - loopStartTime <= STREAM_TOOL_LOOP_DURATION_CAP_MS &&
        hasRunningSubagents(rt.chatId) &&
        !hasPendingSubagentResults(rt.chatId)
      ) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    if (!profile.singleRound) {
      // Emit progress to frontend (maxIterations 0 = unbounded in UI) —
      // single-round (ask) turns have no iterations to report.
      rt.safeSend("chat:iteration:progress", {
        chatId: rt.chatId,
        iteration: agenticIteration + 1,
        maxIterations: 0,
        totalToolsExecuted: totalToolExecutions,
      });
      logger.log(`${L} Iteration ${agenticIteration + 1} (unbounded)`);
    }

    const promptSpec = await profile.buildRoundSystemPrompt();
    const roundPrompt =
      typeof promptSpec === "string"
        ? { systemPromptOverride: promptSpec }
        : promptSpec;
    // Token estimate covers BOTH system blocks (header + dynamic tail).
    const roundSystemPromptEstimateText =
      roundPrompt.systemPromptOverride +
      (roundPrompt.dynamicSystemTail
        ? "\n\n" + roundPrompt.dynamicSystemTail
        : "");

    let buildIterMessages: ModelMessage[] = agenticMessages;
    let streamRoundDone = false;
    // The final round's native response messages — continuation rounds
    // already append theirs to buildIterMessages.
    let finalRoundRespMsgs: ModelMessage[] = [];
    while (!streamRoundDone) {
      // Same guard inside the continuation loop: a mid-round abort must not
      // trigger another runStreamRound via the continuation `continue` below.
      if (rt.abortController.signal.aborted) {
        throw abortReasonError(rt.abortController.signal.reason);
      }
      const {
        bundle,
        fullResponse: roundFull,
        finishReason: fr,
      } = await rt.runStreamRound({
        runSimpleStream: async () =>
          rt.simpleStreamText({
            chatMessages: buildIterMessages,
            tools: profile.tools,
            systemPromptOverride: roundPrompt.systemPromptOverride,
            dynamicSystemTail: roundPrompt.dynamicSystemTail,
          }),
        fullResponse,
        abortController: rt.abortController,
        chatId: rt.chatId,
        processResponseChunkUpdate: rt.processResponseChunkUpdate,
        onFirstModelActivity: () => {
          rt.safeSend("chat:stream:phase", {
            chatId: rt.chatId,
            phase: "responding",
            label: "",
          });
        },
        onFirstTextDelta: rt.onFirstTextDelta,
        onFirstReasoningDelta: () => {
          rt.safeSend("chat:activity", {
            id: `reasoning-started-${rt.chatId}-${Date.now()}`,
            type: "reasoning_started",
            label: "Thinking deeply...",
            status: "running",
            timestamp: Date.now(),
            chatId: rt.chatId,
          });
        },
        onFirstTextAfterReasoning: () => {
          rt.safeSend("chat:activity", {
            id: `reasoning-${rt.chatId}`,
            type: "reasoning_complete",
            label: "Done thinking, writing response...",
            status: "done",
            timestamp: Date.now(),
            chatId: rt.chatId,
          });
        },
        onStreamStall: rt.onStreamStall,
        onToolInputProgress: rt.onToolInputProgress,
        onStreamActivityPulse: rt.onStreamActivityPulse,
        sanitizeTextDelta: rt.sanitizeTextDelta,
      });
      fullResponse = roundFull;
      const resp = await bundle.response;
      const respMsgs = resp.messages as ModelMessage[];
      finalRoundRespMsgs = respMsgs;

      if (
        shouldContinue(fr as never, {
          attemptCount: streamContinuationAttempts,
          maxAttempts: rt.maxContinuationAttempts,
        })
      ) {
        streamContinuationAttempts++;
        buildIterMessages = [
          ...buildIterMessages,
          ...respMsgs,
          {
            role: "user",
            content: buildContinuationPrompt({
              chatId: rt.chatId,
              turnId: rt.continuationTurnId,
              attemptCount: streamContinuationAttempts,
              maxAttempts: rt.maxContinuationAttempts,
              lastContent: stripThinkBlocks(fullResponse),
              ledgerState: rt.getLedgerStateForContinuation(),
            }),
          },
        ];
        continue;
      }

      const ledgerNow = getLedger(rt.streamTurnIdForLedger);
      const pendingForContinue =
        ledgerNow &&
        fr === "stop" &&
        !isLedgerTaskComplete(ledgerNow) &&
        streamContinuationAttempts < rt.maxContinuationAttempts
          ? getRemainingSteps(ledgerNow)
          : [];

      if (profile.honorTaskCompleteBreak && pendingForContinue.length > 0) {
        streamContinuationAttempts++;
        const ledgerSnap = getLedgerStateString(rt.streamTurnIdForLedger);
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

    // v12 0.2 (B1): this iteration's NATIVE delta = continuation appends
    // beyond the agenticMessages seed + the final round's response messages.
    const nativeIterMessages: ModelMessage[] = [
      ...buildIterMessages.slice(agenticMessages.length),
      ...finalRoundRespMsgs,
    ];
    const roundHadNativeToolMessages = hasNativeToolParts(nativeIterMessages);

    if (profile.singleRound) {
      // Ask semantics: a completed round ENDS the turn, tools or not — the
      // SDK inner loop already did the multi-step tool work, and truncation
      // continuations were handled inside the round loop above.
      if (roundHadNativeToolMessages) {
        // v12 0.2 (B2): ask inherits the turn envelope via the engine — the
        // shared post-stream tail persists it on the assistant message.
        rt.nativeTurnMessages.push(...nativeIterMessages);
      }
      if (profile.repetition.consumeLoopBreak()) {
        logger.warn(
          `${L} Stopping after repeated read/search (repetition guard)`,
        );
        fullResponse =
          fullResponse +
          "\n\n[Repeated action — task stopped. Review the activity log and send a message to continue.]";
      }
      break;
    }

    // Text-based tool calls (MiniMax, Claude XML, etc.) — profile-gated.
    // null = none detected; [] = detected but unparseable (break below).
    const textToolCalls = profile.detectTextToolCalls?.(fullResponse) ?? null;
    const hasTextToolCalls = textToolCalls !== null;

    const currentOpCount = rt.permissionInterceptor.getAllOperationsCount();
    const executedOpCount = rt.permissionInterceptor.getExecutedOperationsCount();
    logger.log(
      `${L} Operation counts: total=${currentOpCount}, executed=${executedOpCount}, tracked=${totalToolExecutions}`,
    );

    const hadNativeToolExecution = currentOpCount > totalToolExecutions;

    if (hasTextToolCalls) {
      logger.log(`${L} Detected text-based tool calls, parsing and executing...`);
    } else if (hadNativeToolExecution) {
      const newOps = currentOpCount - totalToolExecutions;
      logger.log(
        `${L} Native tool calls detected (${newOps} new operations, ${currentOpCount} total)`,
      );
      totalToolExecutions = currentOpCount;
    }

    if (streamDebugLogging) {
      logger.log(`${L} Round summary`, {
        iteration: agenticIteration + 1,
        hasTextToolCalls,
        hadNativeToolExecution,
        responseTail: fullResponse.slice(-200),
      });
    }

    let stopGateFeedback: string | null = null;
    if (profile.honorTaskCompleteBreak) {
      // End only on explicit <task_complete> or a completed task ledger —
      // unless a workspace stop-hook is red (2.2/7B): then suppress the break
      // (bounded) and feed the failure back instead.
      const tagComplete = isTaskComplete(fullResponse);
      const ledgerAfterRound = getLedger(rt.streamTurnIdForLedger);
      const ledgerComplete =
        !!ledgerAfterRound && isLedgerTaskComplete(ledgerAfterRound);

      if (
        (tagComplete || ledgerComplete) &&
        profile.taskCompleteGate &&
        gateBlockedBreaks < MAX_GATE_BLOCKED_BREAKS
      ) {
        try {
          stopGateFeedback = await profile.taskCompleteGate();
        } catch (gateErr) {
          logger.warn(`${L} stop-hook gate failed to run: ${String(gateErr)}`);
        }
      }
      const gateBlocksBreak =
        stopGateFeedback != null && gateBlockedBreaks < MAX_GATE_BLOCKED_BREAKS;

      if (tagComplete && !gateBlocksBreak) {
        if (subagentsBlockingEnd()) {
          // Sub-agents still in flight — suppress the end and fall through to
          // the normal native/text folding; we wait at the loop top.
          deferEndForSubagents = true;
          logger.info(
            `${L} task_complete deferred — ${runningSubagentCount(rt.chatId)} sub-agent(s) still running`,
          );
        } else {
          logger.info(`${L} Task completed at iteration ${agenticIteration + 1}`);
          // v12 0.2 (B2): the final round's native messages never hit the fold
          // site — capture them for the turn envelope.
          if (roundHadNativeToolMessages) {
            rt.nativeTurnMessages.push(...nativeIterMessages);
          }
          break;
        }
      }
      if ((tagComplete || ledgerComplete) && gateBlocksBreak) {
        gateBlockedBreaks++;
        logger.info(
          `${L} completion blocked by a stop hook (${gateBlockedBreaks}/${MAX_GATE_BLOCKED_BREAKS}) — continuing`,
        );
      }

      if (ledgerComplete && !gateBlocksBreak) {
        if (subagentsBlockingEnd()) {
          deferEndForSubagents = true;
        } else {
          logger.info(`${L} Ledger complete at iteration ${agenticIteration + 1}`);
          if (roundHadNativeToolMessages) {
            rt.nativeTurnMessages.push(...nativeIterMessages);
          }
          break;
        }
      }
    }

    // Prose-only round handling
    if (!hasTextToolCalls && !hadNativeToolExecution && !roundHadNativeToolMessages) {
      // Sub-agents still running: don't end on a prose-only round — wait for
      // them. Nothing to fold (no tools ran this round), so continue directly.
      if (subagentsBlockingEnd()) {
        deferEndForSubagents = true;
        agenticProseOnlyStreak = 0;
        agenticMessages.push({
          role: "assistant" as const,
          content: stripAssistantDisplayContent(stripXML(fullResponse)),
        });
        agenticMessages.push({
          role: "user" as const,
          content:
            "Your spawned background sub-agent(s) are still running. Their results are delivered to you automatically as each finishes. Wait, incorporate each result, and only emit <task_complete> once all sub-agents have reported and the task is truly complete.",
        });
        agenticIteration++;
        continue;
      }
      if (profile.proseOnlyStreakMax == null) {
        // Ask semantics: the model stopped producing tool work — turn over.
        break;
      }
      agenticProseOnlyStreak++;
      if (agenticProseOnlyStreak >= profile.proseOnlyStreakMax) {
        logger.warn(
          `${L} Prose-only cap (${profile.proseOnlyStreakMax}) reached; ending loop`,
        );
        break;
      }
      const ledgerAfterRound = getLedger(rt.streamTurnIdForLedger);
      const pendingSteps = ledgerAfterRound
        ? getRemainingSteps(ledgerAfterRound)
        : [];
      const ledgerSnap = getLedgerStateString(rt.streamTurnIdForLedger);
      // v12 2.2: a prose-only round whose completion was SUPPRESSED (stop hook
      // red) gets that failure as its nudge — not the generic "continue" line.
      // One streak away from the cap: give an explicit final warning so the
      // model self-completes (or acts) instead of silently dying at the cap.
      const isLastChance =
        profile.proseOnlyStreakMax != null &&
        agenticProseOnlyStreak === profile.proseOnlyStreakMax - 1;
      const nudge =
        stopGateFeedback ??
        (pendingSteps.length > 0
          ? buildPendingStepsContinuationPrompt(pendingSteps) +
            (ledgerSnap ? `\n\nCurrent task state:\n${ledgerSnap}` : "")
          : isLastChance
            ? "You have replied several times without using tools. This is your last turn before the loop ends: if the task is COMPLETE, emit <task_complete> NOW; otherwise call the required tools immediately."
            : "You replied without using tools or finishing. Continue the task: call tools as needed, then emit <task_complete> when fully done.");
      agenticMessages.push({
        role: "assistant" as const,
        content: stripAssistantDisplayContent(stripXML(fullResponse)),
      });
      agenticMessages.push({
        role: "user" as const,
        content: nudge,
      });
      agenticIteration++;
      logger.log(
        `${L} Prose-only streak ${agenticProseOnlyStreak}/${profile.proseOnlyStreakMax}; continuing`,
      );
      continue;
    }

    agenticProseOnlyStreak = 0;

    if (hasTextToolCalls && (textToolCalls?.length ?? 0) === 0) {
      logger.log(`${L} No parseable tool calls found, ending loop`);
      break;
    }

    // Execute text-based tools via the profile (build only).
    let iterationResults: Array<{ tool: string; result: string }> = [];
    let hasPermissionRequest = hadNativeToolExecution;
    if (hasTextToolCalls && textToolCalls && profile.executeTextToolCalls) {
      const outcome = await profile.executeTextToolCalls(textToolCalls);
      iterationResults = outcome.iterationResults;
      hasPermissionRequest = hasPermissionRequest || outcome.hasPermissionRequest;
    }

    // Store all tool results
    allToolResults.push(...iterationResults);
    totalToolExecutions += iterationResults.length;

    // Format tool results to feed back to AI
    const toolResultsMessage = iterationResults
      .map((r) => `<tool_result tool="${r.tool}">\n${r.result}\n</tool_result>`)
      .join("\n\n");

    if (roundHadNativeToolMessages && !hasTextToolCalls) {
      // v12 0.2 (B1): native tools ran inside the SDK loop — fold the round's
      // NATIVE messages into the next iteration's history instead of
      // re-flattening to prose. History stays byte-stable (prompt cache
      // holds) and weak models see real tool blocks.
      agenticMessages.push(...nativeIterMessages);
      const nativeContinueMsg = {
        role: "user" as const,
        content: "Continue with the task. Emit <task_complete> when fully done.",
      };
      agenticMessages.push(nativeContinueMsg);
      // B2: mirror into the turn envelope (exactly what the model saw).
      rt.nativeTurnMessages.push(...nativeIterMessages, nativeContinueMsg);
      logger.log(
        `${L} Folded ${nativeIterMessages.length} native message(s) into history (no synthetic reflatten)`,
      );
    } else {
      // Text-tool fallback / legacy path — UNCHANGED.
      agenticMessages.push({
        role: "assistant" as const,
        content: stripAssistantDisplayContent(stripXML(fullResponse)),
      });

      if (iterationResults.length > 0) {
        agenticMessages.push({
          role: "user" as const,
          content: `Here are the results of the tools you called:\n\n${toolResultsMessage}\n\nPlease continue with your task based on these results.`,
        });
      } else if (hadNativeToolExecution) {
        logger.log(
          `${L} Skipping empty tool-results user message (native tools executed in-stream)`,
        );
      }
    }

    // v12 0.3 / 2.2: push the round's diagnostics feedback and/or stop-hook
    // feedback (both computed before the task-complete gate above) so the
    // next round's model input contains them. Transient round input — NOT
    // mirrored into the B2 native envelope. (The prose-only path above
    // consumed these as its nudge and `continue`d, so this only fires on
    // tool rounds whose completion was suppressed.)
    if (stopGateFeedback) {
      agenticMessages.push({ role: "user" as const, content: stopGateFeedback });
      logger.log(`${L} stop-hook gate: failure fed back`);
    }

    const loopCorrection = profile.repetition.takePendingCorrection();
    if (loopCorrection) {
      agenticMessages.push({
        role: "user" as const,
        content: loopCorrection,
      });
    }

    // Mid-turn auto-compaction (tool results land in agenticMessages FIRST).
    {
      // v12 0.2: the string-based compaction pipeline can't count or
      // summarize native-part messages — degrade them to prose for ITS input
      // only; when compaction fires, the compacted view wins (lossy by
      // design). Revisit in 0.4.
      const compaction = await runMidLoopCompaction({
        messages: flattenNativeForCompaction(agenticMessages),
        systemPromptEstimate: estimateTokens(roundSystemPromptEstimateText),
        tierLimit: rt.tierLimit,
        contextWindowTokens: rt.contextWindowTokens,
        enabled: rt.settings.enableContextAutoSummarize !== false,
        chatId: rt.chatId,
        loopLabel: profile.compactionLabel,
        emitActivity: rt.emitCompactionActivity,
        onInfo: (msg) => logger.log(msg),
        onWarn: (msg, err) => logger.warn(msg, err),
      });
      if (compaction.compacted) {
        agenticMessages = compaction.messages;
      }
    }

    agenticIteration++;

    // Mid-stream tier escalation (Auto mode only).
    try {
      const runningTokens =
        estimateTokens(roundSystemPromptEstimateText) +
        estimateModelMessagesTokens(agenticMessages);
      await rt.applyTierEscalation({
        agenticIteration,
        iterationInterval: 4,
        runningTokens,
        mode: profile.escalationMode,
      });
    } catch (escalationErr) {
      logger.warn(`${L} tier escalation guard failed: ${String(escalationErr)}`);
    }

    if (hasPermissionRequest) {
      logger.log(`${L} Had permission requests, continuing loop...`);
    }

    if (loopCorrection) {
      continue;
    }

    if (profile.repetition.consumeLoopBreak()) {
      logger.warn(`${L} Stopping after repeated write/command (repetition guard)`);
      fullResponse =
        stripXML(fullResponse) +
        "\n\n[Repeated action — task stopped. Review the activity log and send a message to continue.]";
      break;
    }

  }

  return {
    fullResponse,
    iterations: agenticIteration,
    totalToolExecutions,
  };
}
