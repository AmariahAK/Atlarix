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
import { consumeDelegationAbort } from "@/lib/agents/agent-bus-monitor";
import { STREAM_TOOL_LOOP_DURATION_CAP_MS } from "@/constants/settings_constants";
import type { AgentProfile } from "./agent-profile";

const logger = log.scope("run-agent-turn");

/** Mirrors the handler's module-level twin; deduped when the legacy loop dies. */
function isTaskComplete(response: string): boolean {
  return response.includes("<task_complete>");
}

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

  for (;;) {
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

    // Emit progress to frontend (maxIterations 0 = unbounded in UI)
    rt.safeSend("chat:iteration:progress", {
      chatId: rt.chatId,
      iteration: agenticIteration + 1,
      maxIterations: 0,
      totalToolsExecuted: totalToolExecutions,
    });

    logger.log(`${L} Iteration ${agenticIteration + 1} (unbounded)`);

    const roundSystemPrompt = profile.buildRoundSystemPrompt();

    let buildIterMessages: ModelMessage[] = agenticMessages;
    let streamRoundDone = false;
    // The final round's native response messages — continuation rounds
    // already append theirs to buildIterMessages.
    let finalRoundRespMsgs: ModelMessage[] = [];
    while (!streamRoundDone) {
      const {
        bundle,
        fullResponse: roundFull,
        finishReason: fr,
      } = await rt.runStreamRound({
        runSimpleStream: async () =>
          rt.simpleStreamText({
            chatMessages: buildIterMessages,
            tools: profile.tools,
            systemPromptOverride: roundSystemPrompt,
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

    if (profile.honorTaskCompleteBreak) {
      // End only on explicit <task_complete> or a completed task ledger
      if (isTaskComplete(fullResponse)) {
        logger.info(`${L} Task completed at iteration ${agenticIteration + 1}`);
        // v12 0.2 (B2): the final round's native messages never hit the fold
        // site — capture them for the turn envelope.
        if (roundHadNativeToolMessages) {
          rt.nativeTurnMessages.push(...nativeIterMessages);
        }
        break;
      }

      const ledgerAfterRound = getLedger(rt.streamTurnIdForLedger);
      if (ledgerAfterRound && isLedgerTaskComplete(ledgerAfterRound)) {
        logger.info(`${L} Ledger complete at iteration ${agenticIteration + 1}`);
        if (roundHadNativeToolMessages) {
          rt.nativeTurnMessages.push(...nativeIterMessages);
        }
        break;
      }
    }

    // Prose-only round handling
    if (!hasTextToolCalls && !hadNativeToolExecution && !roundHadNativeToolMessages) {
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
      const nudge =
        pendingSteps.length > 0
          ? buildPendingStepsContinuationPrompt(pendingSteps) +
            (ledgerSnap ? `\n\nCurrent task state:\n${ledgerSnap}` : "")
          : "You replied without using tools or finishing. Continue the task: call tools as needed, then emit <task_complete> when fully done.";
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
        systemPromptEstimate: estimateTokens(roundSystemPrompt),
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
        estimateTokens(roundSystemPrompt) +
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

    if (consumeDelegationAbort(rt.chatId)) {
      logger.warn(`${L} Stopping after delegation repetition guard`);
      fullResponse =
        stripXML(fullResponse) +
        "\n\n[Delegation loop guard — task stopped. Review the activity log and send a message to continue.]";
      break;
    }
  }

  return {
    fullResponse,
    iterations: agenticIteration,
    totalToolExecutions,
  };
}
