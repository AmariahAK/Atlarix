/**
 * runStreamRoundWithEmptyOutputRetry — runs one agent round (runSimpleStream +
 * processStreamChunks) inside a bounded retry loop: empty-output retry with a
 * take-once nudge, silent network-error backoff, and stall-with-resume
 * (continue-from-partial). Extracted verbatim from runStream; already
 * params-threaded, so its only enclosing captures are `event` (via deps) and
 * the per-turn `ctx` (the take-once empty-output nudge).
 *
 * (Satellite: never imports the parent handler.)
 */

import log from "electron-log";
import type { IpcMainInvokeEvent } from "electron";
import type { ModelMessage } from "ai";
import { processStreamChunks } from "@/ipc/utils/stream_chunk_tags";
import { safeSend } from "@/ipc/utils/safe_sender";
import {
  EmptyModelOutputAfterRetryError,
  isNoUsableModelOutputError,
} from "@/ipc/utils/no_usable_model_output";
import {
  RECONNECT_DELAYS_MS,
  isNetworkStreamError,
  isForcedToolChoiceRejection,
  retryAfterMs,
  NetworkStreamDisconnectedError,
} from "@/ipc/handlers/chat_stream/network-retry";
import { sentryAddBreadcrumbSafe } from "@/ipc/handlers/chat_stream/sentry-safe";
import { partialResponses } from "@/ipc/handlers/chat_stream/stream-state";
import type { SimpleStreamTextBundle } from "@/ipc/handlers/chat_stream/turn-runner/simple-stream-text";
import type { StreamTurnContext } from "@/ipc/handlers/chat_stream/turn-context";

const logger = log.scope("chat_stream_handlers");

/** One retry after 1s when the model returns no usable output (cold start / provider flake). */
const MAX_STREAM_EMPTY_OUTPUT_ATTEMPTS = 2;
const STREAM_EMPTY_OUTPUT_RETRY_DELAY_MS = 1000;

const isEmptyOutputStreamError = isNoUsableModelOutputError;

export interface RoundRetryDeps {
  event: IpcMainInvokeEvent;
}

export async function runStreamRoundWithEmptyOutputRetry(
  ctx: StreamTurnContext,
  deps: RoundRetryDeps,
  params: {
            runSimpleStream: (opts?: {
              abortSignal?: AbortSignal;
            }) => Promise<SimpleStreamTextBundle>;
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
            onToolInputDelta?: (info: {
              toolCallId: string;
              toolName: string;
              argsTextSoFar: string;
            }) => void;
            onStreamActivityPulse?: () => void;
          }): Promise<{
            bundle: SimpleStreamTextBundle;
            fullResponse: string;
            finishReason: Awaited<SimpleStreamTextBundle["finishReason"]>;
            /** Set when the round stalled AFTER completing ≥1 step: the captured
             * completed-step messages to RESUME from (continue-from-partial)
             * instead of restarting the round. The caller (run-agent-turn) folds
             * these into the next round's history + a continuation nudge. */
            resumeFromStall?: ModelMessage[];
          }> {
    const { event } = deps;
            const initialFullResponse = params.fullResponse;
            let fullResponse = params.fullResponse;
            let emptyOutputAttempt = 0;
            let networkAttempt = 0;
            // Bound the loop generously; both retry counters can fire in the
            // same round but each is independently capped.
            const TOTAL_ATTEMPT_CAP =
              MAX_STREAM_EMPTY_OUTPUT_ATTEMPTS + RECONNECT_DELAYS_MS.length + 1;
            for (let loop = 0; loop < TOTAL_ATTEMPT_CAP; loop++) {
              // Per-round abort controller: the stall watchdog aborts THIS, not
              // the shared turn controller — so a transient stall (common on
              // OpenRouter between steps) doesn't look like a user cancel and the
              // next attempt gets a fresh, un-aborted signal. A real user cancel
              // (shared controller) is linked in, so the in-flight request still
              // stops immediately.
              const roundAbort = new AbortController();
              const linkUserAbort = () =>
                roundAbort.abort(params.abortController.signal.reason);
              if (params.abortController.signal.aborted) {
                roundAbort.abort(params.abortController.signal.reason);
              } else {
                params.abortController.signal.addEventListener(
                  "abort",
                  linkUserAbort,
                  { once: true },
                );
              }
              try {
                const bundle = await params.runSimpleStream({
                  abortSignal: roundAbort.signal,
                });
                const chunkResult = await processStreamChunks({
                  fullStream: bundle.fullStream,
                  fullResponse,
                  abortController: roundAbort,
                  chatId: params.chatId,
                  // Test-only: shrink the idle-stall watchdog so the stall-resume
                  // path is exercisable in-harness (prod uses the default 600s).
                  ...(process.env.ATLARIX_TEST_STALL_MS
                    ? { stallTimeoutMs: Number(process.env.ATLARIX_TEST_STALL_MS) }
                    : {}),
                  processResponseChunkUpdate: params.processResponseChunkUpdate,
                  onFirstModelActivity: params.onFirstModelActivity,
                  onFirstTextDelta: params.onFirstTextDelta,
                  onFirstReasoningDelta: params.onFirstReasoningDelta,
                  onFirstTextAfterReasoning: params.onFirstTextAfterReasoning,
                  onStreamStall: params.onStreamStall,
                  sanitizeTextDelta: params.sanitizeTextDelta,
                  onToolInputProgress: params.onToolInputProgress,
                  onToolInputDelta: params.onToolInputDelta,
                  onStreamActivityPulse: params.onStreamActivityPulse,
                });
                fullResponse = chunkResult.fullResponse;
                if (chunkResult.stalled) {
                  // A stall (no chunks for the watchdog window) — NOT a user
                  // cancel (that path returns stalled=false).
                  if (params.abortController.signal.aborted) {
                    throw new Error("aborted");
                  }
                  // CONTINUE-FROM-PARTIAL: if the round completed ≥1 step before
                  // stalling, resume from that work instead of restarting the
                  // round and re-running every tool call. Return the captured
                  // completed-step messages; run-agent-turn folds them into the
                  // next round's history + a "continue" nudge (same path as the
                  // truncation continuation). Keep `fullResponse`/partials intact
                  // (no reset) so the rendered turn isn't wiped.
                  const resumeMessages = bundle.getResumeMessages?.() ?? [];
                  if (resumeMessages.length > 0) {
                    logger.warn(
                      `[stream] Stalled after ${resumeMessages.length} completed step-message(s) — resuming from partial instead of restarting`,
                    );
                    sentryAddBreadcrumbSafe({
                      category: "stream_retry",
                      message: `stall_resume_from_partial steps=${resumeMessages.length}`,
                      level: "warning",
                    });
                    return {
                      bundle,
                      fullResponse,
                      finishReason:
                        "unknown" as Awaited<
                          SimpleStreamTextBundle["finishReason"]
                        >,
                      resumeFromStall: resumeMessages,
                    };
                  }
                  // No progress captured (stalled before any step finished) —
                  // fall back to the original reset + backoff retry; on
                  // exhaustion surface a recoverable disconnect ([Reconnect])
                  // instead of a fatal turn end.
                  if (networkAttempt < RECONNECT_DELAYS_MS.length) {
                    const delay = RECONNECT_DELAYS_MS[networkAttempt];
                    networkAttempt++;
                    logger.warn(
                      `[stream] Stalled (no chunks), retrying after ${delay}ms (attempt ${networkAttempt}/${RECONNECT_DELAYS_MS.length})`,
                    );
                    sentryAddBreadcrumbSafe({
                      category: "stream_retry",
                      message: `stall_retry attempt ${networkAttempt}/${RECONNECT_DELAYS_MS.length}`,
                      level: "warning",
                    });
                    safeSend(event.sender, "chat:stream:reset-partial", {
                      chatId: params.chatId,
                    });
                    fullResponse = initialFullResponse;
                    partialResponses.delete(params.chatId);
                    await new Promise((r) => setTimeout(r, delay));
                    if (params.abortController.signal.aborted) {
                      throw new Error("aborted");
                    }
                    continue;
                  }
                  throw new NetworkStreamDisconnectedError(fullResponse);
                }
                // Only await finishReason on a non-stalled (non-aborted) bundle.
                const finishReason = await bundle.finishReason;
                return { bundle, fullResponse, finishReason };
              } catch (err) {
                // User abort always wins over any retry path.
                if (params.abortController.signal.aborted) {
                  throw err;
                }

                // The provider refused the forced tool_choice (the wake turn's
                // `collect_results`). Deterministic — retrying the same request
                // fails identically — so change the request instead: clear the
                // forced choice and let the prepareStep injection deliver the same
                // results. Costs no backoff and no attempt budget, and the flag is
                // sticky so a later round in this turn never re-forces it.
                if (
                  isForcedToolChoiceRejection(err) &&
                  !ctx.forcedToolChoiceRejected
                ) {
                  ctx.forcedToolChoiceRejected = true;
                  logger.warn(
                    `[stream] Provider rejected the forced tool_choice — retrying with injected delivery: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                  );
                  sentryAddBreadcrumbSafe({
                    category: "stream_retry",
                    message: "forced_tool_choice_rejected → injection fallback",
                    level: "warning",
                  });
                  fullResponse = initialFullResponse;
                  continue;
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
                  // #12: don't just re-run the identical round — tell the model to
                  // ACT. Reasoning models sometimes emit only reasoning; a targeted
                  // nudge (injected into the retry's step 0 via prepareStep) turns a
                  // wasted re-run into a corrected one.
                  ctx.pendingEmptyOutputNudge =
                    "Your previous attempt produced only internal reasoning — no visible message and no tool call. Do not just think again: either call a tool to make progress, or write your final message to the user now.";
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
                  // Honor a provider `Retry-After` (429/503) over the fixed
                  // backoff — but cap it at 60s so a hostile/misconfigured header
                  // can't hang the turn.
                  const retryAfter = retryAfterMs(err);
                  const delay =
                    retryAfter != null
                      ? Math.min(retryAfter, 60_000)
                      : RECONNECT_DELAYS_MS[networkAttempt];
                  networkAttempt++;
                  logger.warn(
                    `[stream] Network error on attempt ${networkAttempt}/${RECONNECT_DELAYS_MS.length}, retrying after ${delay}ms${
                      retryAfter != null ? " (Retry-After)" : ""
                    }: ${err instanceof Error ? err.message : String(err)}`,
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
              } finally {
                params.abortController.signal.removeEventListener(
                  "abort",
                  linkUserAbort,
                );
              }
            }
            throw new Error("runStreamRoundWithEmptyOutputRetry: unreachable");
          }
