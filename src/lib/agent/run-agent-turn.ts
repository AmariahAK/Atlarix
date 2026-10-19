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
import { systemReminder } from "@/lib/streaming/system-reminder";
import { currentPlanLedger } from "@/lib/tasks/plan-ledger-refresh";
import {
  getMutationFailureFeedback,
  getUnverifiedEditFeedback,
} from "@/lib/agent/mutation-verify";
import { trackTaskStarted, trackTaskCompleted, trackTurnCompleted } from "@/main/lib/analytics";
import {
  ASK_USER_STREAM_STOP,
  USER_CANCEL_STREAM_STOP,
  abortReasonSentinel,
} from "@/lib/stream/stream-stop-sentinels";
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
import { isForceTextFinishAbort } from "@/lib/stream/stream-stop-sentinels";
import {
  hasRunningSubagents,
  hasPendingSubagentResults,
  runningSubagentCount,
} from "@/lib/agents/subagent-results";
import {
  hasRunningBackgroundCommands,
  hasPendingBackgroundCommandResults,
} from "@/lib/agent/background-commands";
import type { AgentProfile } from "./agent-profile";

const logger = log.scope("run-agent-turn");

/**
 * Default instruction for the forced tools-off finish round (repetition
 * escalation or round-cap backstop). Provider-agnostic plain text; a profile
 * may override via `buildForceFinishPrompt`. Mirrors opencode's MAX_STEPS_PROMPT.
 */
const DEFAULT_FORCE_FINISH_PROMPT =
  "You have been repeating actions without converging, so tools are now disabled for this turn. " +
  "Do NOT attempt any further tool calls. In plain prose, briefly summarize what you accomplished, " +
  "what is still incomplete, and the concrete next step — then stop.";

/**
 * The handler-scope closures + live state the engine drives. 0.1 extracts
 * control flow, not state — these stay owned by `runStream` in the handler.
 */
export interface TurnRuntime {
  readonly chatId: number;
  // `settings` REMOVED (v14.18.0): its only reader was the compaction opt-out,
  // and compaction is now unconditional.
  readonly abortController: AbortController;
  /** placeholderAssistantMessage.id — continuation prompt turn id. */
  readonly continuationTurnId: string;
  readonly streamTurnId: string;
  readonly tierLimit: number;
  readonly usableTokens: number;
  readonly maxContinuationAttempts: number;
  /**
   * v14.8.7 §A2: compact task ledger for this session (or null). Threaded into
   * the continuation prompt so a stall/truncation resume re-asserts the SAME
   * task instead of re-reading the prior user message as a new request.
   */
  readonly taskLedger?: string | null;
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
    /** Per-round abort signal (stall watchdog aborts THIS, not the turn). */
    abortSignal?: AbortSignal;
    /** Backstop in-round step cap forwarded to streamText's stopWhen. */
    maxStepsPerRound?: number;
  }): Promise<unknown>;
  runStreamRound(params: {
    runSimpleStream: (opts?: { abortSignal?: AbortSignal }) => Promise<unknown>;
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
    onToolInputProgress?: (info: {
      toolName: string;
      deltaCount: number;
    }) => void;
    onToolInputDelta?: (info: {
      toolCallId: string;
      toolName: string;
      argsTextSoFar: string;
    }) => void;
    onStreamActivityPulse?: () => void;
    sanitizeTextDelta?: (text: string) => string;
  }): Promise<{
    // ai@6+: streamText getters are PromiseLike, not Promise.
    //
    // `responseMessages` is the ACCUMULATED assistant/tool messages for the whole
    // call. ai@7 deprecated top-level `response` to mean `finalStep.response`, so
    // reading `response.messages` here silently yielded only the last step —
    // dropping the native tool exchange whenever the final step was plain text.
    bundle: {
      response: PromiseLike<{ messages: ModelMessage[] }>;
      responseMessages: PromiseLike<ModelMessage[]>;
    };
    fullResponse: string;
    finishReason: unknown;
    /** Set when the round stalled after completing ≥1 step: resume from these
     * captured completed-step messages instead of restarting (continue-from-
     * partial). `bundle.response` is unreliable mid-abort, so use THESE. */
    resumeFromStall?: ModelMessage[];
  }>;
  processResponseChunkUpdate(args: { fullResponse: string }): Promise<string>;
  onFirstTextDelta(): void;
  onStreamStall(): void;
  onToolInputProgress(info: { toolName: string; deltaCount: number }): void;
  onToolInputDelta?(info: {
    toolCallId: string;
    toolName: string;
    argsTextSoFar: string;
  }): void;
  onStreamActivityPulse(): void;
  sanitizeTextDelta(text: string): string;
  applyTierEscalation(args: {
    agenticIteration: number;
    iterationInterval: number;
    runningTokens: number;
    mode: string;
  }): Promise<unknown>;
}

export interface AgentTurnResult {
  fullResponse: string;
  iterations: number;
  totalToolExecutions: number;
  /**
   * True when the turn ended cleanly with background work still outstanding
   * (running/pending background commands or sub-agents). The turn is genuinely
   * OVER (not held open) — the renderer shows a "waiting … will resume
   * automatically" chip and a fresh turn auto-resumes when an item reports.
   */
  parked: boolean;
  /**
   * True when the turn ended via the forced tools-off finish round (repetition
   * escalation or round-cap). The turn controller is left ABORTED in this case
   * (that's how the in-flight stream was interrupted), so the caller must treat
   * `aborted && forcedTextFinish` as a clean completion and persist the result —
   * NOT as a user cancel.
   */
  forcedTextFinish: boolean;
}

/** Coarse duration buckets for the turn-completed analytics event. */
function durationBucket(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return "<10s";
  if (s < 30) return "10-30s";
  if (s < 120) return "30s-2m";
  if (s < 600) return "2-10m";
  return ">10m";
}

/** Normalize an AbortController reason into an Error for throw/propagation. */
function abortReasonError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(String(reason ?? "aborted"));
}

/**
 * One `turn_completed` per turn, however it ends: `ok`, `ask_user` (it ended on
 * a question for the user), `stopped` (the user stopped it), `aborted` or
 * `error`. The old funnel counted successes only, so a failing turn was
 * invisible. An error carries its status or class, never its message.
 */
export async function runAgentTurn(
  profile: AgentProfile,
  rt: TurnRuntime,
): Promise<AgentTurnResult> {
  const started = Date.now();
  const report = (outcome: string, extra: Record<string, unknown> = {}) =>
    trackTurnCompleted({
      outcome,
      mode: profile.mode,
      duration_bucket: durationBucket(Date.now() - started),
      ...extra,
    });
  try {
    const result = await runAgentTurnInner(profile, rt);
    report("ok", { iterations: result.iterations, tool_count: result.totalToolExecutions });
    return result;
  } catch (e) {
    const { outcome, errorKind } = turnOutcome(e, rt.abortController.signal);
    report(outcome, errorKind ? { error_kind: errorKind } : {});
    throw e;
  }
}

/** How a thrown turn ended, for `turn_completed`. No message text, ever. */
export function turnOutcome(
  error: unknown,
  signal: AbortSignal,
): { outcome: "ask_user" | "stopped" | "aborted" | "error"; errorKind?: string } {
  if (signal.aborted) {
    const sentinel = abortReasonSentinel(signal.reason);
    if (sentinel === ASK_USER_STREAM_STOP) return { outcome: "ask_user" };
    if (sentinel === USER_CANCEL_STREAM_STOP) return { outcome: "stopped" };
    return { outcome: "aborted" };
  }
  const err = error as { statusCode?: unknown; name?: unknown } | null;
  return {
    outcome: "error",
    errorKind: typeof err?.statusCode === "number" ? `http_${err.statusCode}` : String(err?.name ?? "Error"),
  };
}

async function runAgentTurnInner(
  profile: AgentProfile,
  rt: TurnRuntime,
): Promise<AgentTurnResult> {
  const L = profile.loopLogLabel;
  const streamDebugLogging = isStreamDebugLoggingEnabled();
  const stripXML = profile.stripTextToolXML ?? ((t: string) => t);

  // Funnel: a real agent turn is starting (fires first_task_started once).
  trackTaskStarted({ mode: profile.mode });

  const loopStartTime = Date.now();
  let agenticIteration = 0;
  let agenticProseOnlyStreak = 0;
  // v14.8.9 continue-until-done: the plan-completeness gate has its OWN, higher
  // consecutive cap than the red-verification gates — a legit multi-phase task
  // that briefly yields at several phase boundaries shouldn't be cut at 3. Both
  // reset on any productive round.
  let planNudgeStreak = 0;
  // v14.8.10: absolute per-turn total that NEVER resets — the consecutive streak
  // resets on any productive round, so a model alternating one trivial tool call
  // with a yield re-arms the 6-cap indefinitely (observed: 3+ full nudge cycles
  // in a single turn). This bounds the whole turn, not just the streak.
  let planNudgeTotal = 0;
  let agenticMessages: ModelMessage[] = [...rt.seedMessages];
  const allToolResults: Array<{ tool: string; result: string }> = [];
  let totalToolExecutions = 0;
  let fullResponse = rt.initialFullResponse;
  let streamContinuationAttempts = 0;
  // Stall-resume (continue-from-partial) attempts this turn, bounded so a model
  // that stalls every round can't loop forever resuming itself.
  let stallResumeAttempts = 0;
  const MAX_STALL_RESUME_ATTEMPTS = 3;
  // Natural-termination safety-net: a build/debug turn ends when the model
  // yields a prose-only round (no tool calls). If a verification gate is red
  // (stop hook / failed command / unverified edit) we nudge it on at most this
  // many times before ending anyway, so a persistent failure can never loop.
  const PROSE_YIELD_MAX_NUDGES = 3;
  // Plan-completeness nudges get more headroom (see planNudgeStreak above).
  const PLAN_YIELD_MAX_NUDGES = 6;
  // Hard per-turn ceiling on plan nudges regardless of streak resets.
  const PLAN_YIELD_TOTAL_MAX = 12;

  // Park-on-wait: when the model would END the turn but background work is still
  // outstanding (running/pending background commands OR sub-agents), we DON'T
  // hold the stream open — we end the turn cleanly and mark it `parked`. A fresh
  // turn auto-resumes (renderer auto-wake) when an item reports; the result then
  // folds in via the prepareStep injection. The model was already told (by the
  // task/run_command tool result) that results arrive automatically — no poll.
  let parked = false;
  // Set when the loop decides to WRAP UP with one tools-off finish round
  // (repetition escalation aborted the in-flight stream, or the round cap fired).
  // The finish round runs with an isolated controller so the (now-aborted) turn
  // controller doesn't kill it.
  let forceTextFinish = false;
  const forceFinishPrompt =
    profile.buildForceFinishPrompt?.() ?? DEFAULT_FORCE_FINISH_PROMPT;

  // Stage 2 (opencode-alignment / single source of truth for NATIVE history):
  // every CONTINUATION fold of a round's native messages must land in BOTH the
  // live request (`agenticMessages`) and the persisted turn envelope
  // (`rt.nativeTurnMessages`) — atomically — so the two can never carry
  // different native content. (The gate-nudge path previously folded into the
  // request only, silently dropping that round's tool results from the
  // persisted history → the next turn re-derived them = re-read. End/park paths
  // push the envelope only, by design, since no further round consumes them.)
  // Captures `agenticMessages` by binding, so it always targets the current
  // array even after a compaction reassigns it.
  const foldNativeIntoTurn = (msgs: ModelMessage[]) => {
    agenticMessages.push(...msgs);
    rt.nativeTurnMessages.push(...msgs);
  };

  const pendingWorkBlocksEnd = (): boolean =>
    // v14.7: approvals no longer park (they block mid-loop), so only DETACHED
    // work (sub-agents, background commands) keeps the turn parked-for-auto-wake.
    hasRunningSubagents(rt.chatId) ||
    hasPendingSubagentResults(rt.chatId) ||
    hasRunningBackgroundCommands(rt.chatId) ||
    hasPendingBackgroundCommandResults(rt.chatId);

  for (;;) {
    // `fullResponse` ACCUMULATES across agentic iterations (each round's
    // processStreamChunks starts from it and appends), so text-tool detection
    // below must look at only THIS iteration's NEW output — otherwise an
    // already-executed `<tool_call>` from an earlier iteration is re-detected and
    // re-executed every round (the weak/local-model fallback never settles and
    // the turn loops until it exhausts). Captured at the top of each iteration.
    const iterationStartFullResponse = fullResponse;
    // Stream was aborted (compass token-pool stop, user stop, task-complete
    // stop). Do NOT start another round — issuing a request on an aborted
    // controller yields empty output and an AI_NoOutputGeneratedError that
    // would escape as an unhandled rejection. Throw so the handler's catch
    // takes its existing abort path (persist partial / honor ledger-complete).
    if (rt.abortController.signal.aborted) {
      // A FORCE_TEXT_FINISH abort means the repetition guard interrupted the
      // stream to WRAP UP — don't throw; fall through and run one tools-off
      // finish round (with an isolated controller) so the model summarizes.
      if (isForceTextFinishAbort(rt.abortController.signal.reason)) {
        forceTextFinish = true;
      } else {
        logger.log(
          `${L} Stream aborted (${String(rt.abortController.signal.reason ?? "unknown")}) — stopping turn loop`,
        );
        throw abortReasonError(rt.abortController.signal.reason);
      }
    }
    if (
      !forceTextFinish &&
      Date.now() - loopStartTime > STREAM_TOOL_LOOP_DURATION_CAP_MS
    ) {
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
    // NOTE: deliberately NO round-count or step-count length cap. opencode
    // (`agent.steps` defaults to Infinity) and Claude Code run unbounded and
    // terminate on STUCK-NESS, not duration — a legit long prod/CI task makes
    // progress across many rounds and must not be guillotined. Runaways are
    // caught by the repetition guard → graceful force-finish (which fires
    // in-round via the stream abort), not by a length ceiling.

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

    // For the forced finish round, inject the summarize-and-stop instruction as
    // a user turn and run with an ISOLATED controller (the turn controller is
    // aborted when force-finish was triggered mid-round) + NO tools, so the
    // model can only produce prose and finishes cleanly.
    let buildIterMessages: ModelMessage[] = forceTextFinish
      ? [
          ...agenticMessages,
          { role: "user" as const, content: systemReminder(forceFinishPrompt) },
        ]
      : agenticMessages;
    const roundAbortController = forceTextFinish
      ? new AbortController()
      : rt.abortController;
    let streamRoundDone = false;
    // Finish reason of the round that actually completed (last continuation),
    // hoisted so the post-round termination check can read it.
    let finalFinishReason: unknown;
    // The final round's native response messages — continuation rounds
    // already append theirs to buildIterMessages.
    let finalRoundRespMsgs: ModelMessage[] = [];
    try {
      while (!streamRoundDone) {
        // Same guard inside the continuation loop: a mid-round abort must not
        // trigger another runStreamRound via the continuation `continue` below.
        // During the forced finish round the turn controller stays aborted, so
        // skip the guard then (the finish round uses its own controller).
        if (rt.abortController.signal.aborted && !forceTextFinish) {
          throw abortReasonError(rt.abortController.signal.reason);
        }
        const {
          bundle,
          fullResponse: roundFull,
          finishReason: fr,
          resumeFromStall,
        } = await rt.runStreamRound({
          runSimpleStream: async (o) =>
            rt.simpleStreamText({
              chatMessages: buildIterMessages,
              // Tools OFF for the finish round so the model can't keep looping.
              tools: forceTextFinish ? {} : profile.tools,
              systemPromptOverride: roundPrompt.systemPromptOverride,
              dynamicSystemTail: roundPrompt.dynamicSystemTail,
              abortSignal: o?.abortSignal,
              // Normal rounds are UNBOUNDED (parity with opencode/Claude Code) —
              // the repetition guard, not a step cap, ends a stuck round. The
              // finish round is the lone exception: exactly ONE step (prose),
              // bounding the degenerate case where a model still emits a tool call
              // despite tools being off (text-tool models / scripted evals).
              maxStepsPerRound: forceTextFinish ? 1 : undefined,
            }),
          fullResponse,
          abortController: roundAbortController,
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
          onToolInputDelta: rt.onToolInputDelta,
          onStreamActivityPulse: rt.onStreamActivityPulse,
          sanitizeTextDelta: rt.sanitizeTextDelta,
        });
        fullResponse = roundFull;
        finalFinishReason = fr;

        // CONTINUE-FROM-PARTIAL (stall recovery): the round stalled after
        // completing ≥1 step. Resume from the captured completed-step messages
        // instead of restarting (which re-ran every tool call — the "redoing the
        // whole task" bug). Unified with the truncation-continuation path below:
        // append the completed work + a "continue" nudge and loop. Do NOT await
        // `bundle.response` — it's unreliable on a mid-abort bundle.
        if (resumeFromStall && resumeFromStall.length > 0) {
          if (stallResumeAttempts >= MAX_STALL_RESUME_ATTEMPTS) {
            // Repeated stalls even after resuming — surface a recoverable
            // disconnect rather than spinning. (NetworkStreamDisconnectedError is
            // thrown by the round wrapper on the no-progress path; here we stop
            // resuming and let the round end so the [Reconnect] affordance shows.)
            logger.warn(
              `${L} Stall-resume cap (${MAX_STALL_RESUME_ATTEMPTS}) reached — ending round`,
            );
            finalRoundRespMsgs = resumeFromStall;
            streamRoundDone = true;
            break;
          }
          stallResumeAttempts++;
          logger.info(
            `${L} Stall-resume ${stallResumeAttempts}/${MAX_STALL_RESUME_ATTEMPTS}: continuing from ${resumeFromStall.length} completed step-message(s)`,
          );
          buildIterMessages = [
            ...buildIterMessages,
            ...resumeFromStall,
            {
              role: "user",
              content: buildContinuationPrompt({
                chatId: rt.chatId,
                turnId: rt.continuationTurnId,
                attemptCount: stallResumeAttempts,
                maxAttempts: MAX_STALL_RESUME_ATTEMPTS,
                lastContent: stripThinkBlocks(fullResponse),
                taskLedger: currentPlanLedger(rt.chatId) ?? rt.taskLedger,
              }),
            },
          ];
          finalRoundRespMsgs = resumeFromStall;
          continue;
        }

        // ai@7: take the ACCUMULATED response messages, not `response.messages`.
        // The latter now resolves to the FINAL STEP only, so a turn whose tool call
        // ran in an earlier step lost its native tool exchange entirely — turn 2
        // then carried no `role:"tool"` history (caught by native-history B2).
        const respMsgs = (await bundle.responseMessages) as ModelMessage[];
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
                taskLedger: currentPlanLedger(rt.chatId) ?? rt.taskLedger,
              }),
            },
          ];
          continue;
        }

        streamRoundDone = true;
      }
    } catch (err) {
      // A mid-round FORCE_TEXT_FINISH abort surfaces here (runStreamRound
      // rejects with the abort reason). Don't propagate — flip into finish mode
      // and loop back so the next pass runs the tools-off summarize round.
      if (
        !forceTextFinish &&
        isForceTextFinishAbort(rt.abortController.signal.reason)
      ) {
        forceTextFinish = true;
        continue;
      }
      throw err;
    }

    // The forced finish round just completed (prose-only). End the turn now,
    // skipping the normal termination/continuation logic. The turn controller is
    // left aborted; the caller treats `forcedTextFinish` as a clean completion.
    if (forceTextFinish) {
      logger.info(`${L} Force-finish round complete — ending turn`);
      break;
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
      break;
    }

    // Text-based tool calls (MiniMax, Claude XML, etc.) — profile-gated.
    // null = none detected; [] = detected but unparseable (break below).
    // Detect on THIS iteration's delta only (see iterationStartFullResponse) so
    // an already-executed call from an earlier iteration isn't re-run every round.
    const iterationDeltaResponse = fullResponse.startsWith(
      iterationStartFullResponse,
    )
      ? fullResponse.slice(iterationStartFullResponse.length)
      : fullResponse;

    // §A5: semantic loop-guard on repeated status re-statements. If the model
    // keeps re-emitting the same status text round after round (tool args
    // varying so the byte-identical tool guard misses it), first CORRECT it
    // (round-boundary feedback, same transient mechanism as gate nudges —
    // v14.8.10 Fix R); only a second full run of repeats forces the finish.
    if (!forceTextFinish && profile.repetition?.isEnabled()) {
      const textRep = profile.repetition.recordText(
        stripThinkBlocks(iterationDeltaResponse),
      );
      if (textRep.kind === "loop_correct") {
        logger.info(
          `${L} Repeated status restatement detected — injecting correction (attempt ${textRep.attempt})`,
        );
        // Fold the round's prose first (same shape as the gate-nudge path) so
        // the correction lands on coherent alternating history.
        agenticMessages.push({
          role: "assistant" as const,
          content: stripAssistantDisplayContent(stripXML(fullResponse)),
        });
        agenticMessages.push({
          role: "user" as const,
          content: systemReminder(
            "You have repeated essentially the same status message for several rounds without new work. " +
              "Do not restate progress again — take the next concrete action now, or if the task is complete " +
              "(or you are blocked), end your turn with a final summary.",
          ),
        });
        agenticIteration++;
        continue;
      }
      if (textRep.kind === "loop_abort") {
        logger.info(
          `${L} Repeated status restatement persisted — forcing finish round`,
        );
        forceTextFinish = true;
        continue;
      }
    }

    const textToolCalls =
      profile.detectTextToolCalls?.(iterationDeltaResponse) ?? null;
    const hasTextToolCalls = textToolCalls !== null;

    const currentOpCount = rt.permissionInterceptor.getAllOperationsCount();
    const executedOpCount =
      rt.permissionInterceptor.getExecutedOperationsCount();
    logger.log(
      `${L} Operation counts: total=${currentOpCount}, executed=${executedOpCount}, tracked=${totalToolExecutions}`,
    );

    const hadNativeToolExecution = currentOpCount > totalToolExecutions;

    if (hasTextToolCalls) {
      logger.log(
        `${L} Detected text-based tool calls, parsing and executing...`,
      );
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

    // Natural termination: a build/debug turn ENDS when the model yields a
    // prose-only round (no tool calls) — there is no `task_complete` tool/tag
    // anymore. Before ending we run the verification gates (workspace stop-hook
    // + mutation-verify); a red gate nudges the model to fix it (bounded), so it
    // can't "go quiet" right after a broken edit/command. Ask mode ends on the
    // first prose-only round; background work parks instead of ending.
    // Did the model YIELD (done) or does it want more tool work? finishReason is
    // authoritative: with execute-based tools the SDK runs the whole multi-step
    // inside ONE round and finishes "stop" when the model is done — even if that
    // round used tools. The old structural proxy (`!roundHadNativeToolMessages`)
    // mis-fired: a round that used a tool THEN gave closing prose still "had
    // native messages", so the loop ran a needless extra round (the ~30s lag the
    // user saw) — and a turn with only DETACHED background work looped for the
    // whole job instead of parking. Text-tool models (MiniMax) finish "stop" with
    // calls embedded in prose, so `hasTextToolCalls` gates them out. Unknown
    // finishReason → fall back to the structural proxy so no provider regresses.
    const modelYielded = hasTextToolCalls
      ? false
      : finalFinishReason === "stop"
        ? true
        : finalFinishReason === "tool-calls"
          ? false
          : !hadNativeToolExecution && !roundHadNativeToolMessages;

    if (modelYielded) {
      // Persist this round's native tool messages (they ran inside the SDK loop)
      // into the turn envelope before we end/park.
      if (roundHadNativeToolMessages) {
        rt.nativeTurnMessages.push(...nativeIterMessages);
      }
      // Background work still outstanding — PARK: end the turn cleanly now and
      // auto-resume when an item reports. Matches Claude Code — detached work
      // never holds the turn open; it ends, the composer returns to Send, and the
      // background auto-wake (job / sub-agent / scheduled) resumes on completion.
      if (pendingWorkBlocksEnd()) {
        parked = true;
        logger.info(
          `${L} Model yielded (fr=${String(finalFinishReason)}) → PARKED — ${runningSubagentCount(rt.chatId)} sub-agent(s) / background work outstanding`,
        );
        break;
      }
      if (profile.proseOnlyStreakMax == null) {
        // Ask semantics: the model stopped producing tool work — turn over.
        break;
      }
      // Build/debug: run the completion gates before ending. A red gate (a
      // failed command or an unverified edit) nudges the model on — bounded, so
      // a persistent failure can never loop forever.
      // A `profile.taskCompleteGate` seam ran first here, supplied only by
      // `.atlarix/hooks/` stop hooks. Hooks were removed in v14.26.0 and nothing
      // else ever produced one, so the seam went with them rather than staying
      // as an extension point with no extensions.
      let gateFeedback: string | null = getMutationFailureFeedback(
        rt.streamTurnId,
      );
      if (gateFeedback == null) {
        gateFeedback = getUnverifiedEditFeedback(rt.streamTurnId);
      }
      // NOTE: the browser runtime and visual GATES used to sit here, and later a
      // once-per-turn runtime notice. All removed — the harness cannot tell
      // whether an error belongs to the app being built or to a page the agent
      // merely opened. Since v14.52.0 the agent's browser is the user's Chrome;
      // it checks the console itself with browser_inspect (since its last
      // navigate), which is the one reading that knows which page it meant.
      // v14.8.9 continue-until-done: after the red-verification gates, the
      // plan-completeness gate keeps the turn going while the session plan has
      // steps left. It uses its OWN (higher) cap so it isn't the red gates' 3.
      let usePlanGate = false;
      if (gateFeedback == null && profile.planCompletionGate) {
        try {
          gateFeedback = await profile.planCompletionGate();
          usePlanGate = gateFeedback != null;
        } catch (planErr) {
          logger.warn(
            `${L} plan-completion gate failed to run: ${String(planErr)}`,
          );
        }
      }
      const gateStreak = usePlanGate ? planNudgeStreak : agenticProseOnlyStreak;
      const gateCap = usePlanGate
        ? PLAN_YIELD_MAX_NUDGES
        : PROSE_YIELD_MAX_NUDGES;
      if (
        gateFeedback == null ||
        gateStreak >= gateCap ||
        (usePlanGate && planNudgeTotal >= PLAN_YIELD_TOTAL_MAX)
      ) {
        logger.info(
          `${L} Model yielded (no tool calls) — ending turn at iteration ${agenticIteration + 1}`,
        );
        break;
      }
      if (usePlanGate) {
        planNudgeStreak++;
        planNudgeTotal++;
      } else agenticProseOnlyStreak++;
      // Fold this round's native tool messages for context on the gate-nudge
      // continuation (a tool-using round can now reach this path); fall back to
      // prose for a pure-prose round. Stage 2: fold into BOTH request + envelope
      // (was request-only — the cross-turn re-read bug).
      if (roundHadNativeToolMessages) {
        foldNativeIntoTurn(nativeIterMessages);
      } else {
        agenticMessages.push({
          role: "assistant" as const,
          content: stripAssistantDisplayContent(stripXML(fullResponse)),
        });
      }
      // The gate feedback is TRANSIENT steering — request only, never persisted.
      agenticMessages.push({
        role: "user" as const,
        content: systemReminder(gateFeedback),
      });
      agenticIteration++;
      logger.log(
        `${L} ${usePlanGate ? "Plan not complete" : "Completion gate not satisfied"} — nudge ${gateStreak + 1} of ${gateCap} allowed; continuing`,
      );
      continue;
    }

    // Productive round — reset BOTH yield counters (§continue-until-done).
    agenticProseOnlyStreak = 0;
    planNudgeStreak = 0;

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
      hasPermissionRequest =
        hasPermissionRequest || outcome.hasPermissionRequest;
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
      //
      // Stage 1 (opencode-alignment): do NOT append a per-round "continue/verify"
      // nudge. opencode re-sends clean native history and obeys the finish
      // reason — this path is only reached on finish_reason:"tool-calls" (the
      // model itself signaled it wants more tool work), so it continues from the
      // clean tool-result tail without prodding. The repeated "…and verified…"
      // nudge was re-eliciting read_file on open-weight models (re-read loop).
      // Stage 2: single atomic fold into BOTH request + persisted envelope.
      foldNativeIntoTurn(nativeIterMessages);
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
          content: systemReminder(
            `Here are the results of the tools you called:\n\n${toolResultsMessage}\n\nPlease continue with your task based on these results.`,
          ),
        });
      } else if (hadNativeToolExecution) {
        logger.log(
          `${L} Skipping empty tool-results user message (native tools executed in-stream)`,
        );
      }
    }

    // Mid-turn auto-compaction (tool results land in agenticMessages FIRST).
    {
      // Stage 3 (opencode-alignment): the string-based summarizer still needs a
      // FLATTENED view to count/summarize the head, but we also pass the NATIVE
      // messages so the protected tail is rebuilt from real `tool` blocks — the
      // result is non-destructive of recent tool results (only the older head is
      // summarized). Compaction is also overflow-only now (0.9), so on a normal
      // turn it never fires.
      const compaction = await runMidLoopCompaction({
        messages: flattenNativeForCompaction(agenticMessages),
        nativeMessages: agenticMessages,
        systemPromptEstimate: estimateTokens(roundSystemPromptEstimateText),
        tierLimit: rt.tierLimit,
        usableTokens: rt.usableTokens,
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
      logger.warn(
        `${L} tier escalation guard failed: ${String(escalationErr)}`,
      );
    }

    if (hasPermissionRequest) {
      logger.log(`${L} Had permission requests, continuing loop...`);
    }
  }

  // Funnel: the turn ran to a natural end (fires first_task_completed once,
  // then task_completed on every subsequent success). A thrown turn never
  // reaches here, so failures/aborts are not counted as completed.
  trackTaskCompleted({
    mode: profile.mode,
    iterations: agenticIteration,
    toolExecutions: totalToolExecutions,
    // Bucketed, not raw: engagement is the question ("was this a quick edit or
    // a long build"), and a raw duration on a low-volume event is closer to a
    // fingerprint than a metric.
    duration_bucket: durationBucket(Date.now() - loopStartTime),
  });
  return {
    fullResponse,
    iterations: agenticIteration,
    totalToolExecutions,
    parked,
    forcedTextFinish: forceTextFinish,
  };
}
