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

import { noteTurn } from "@/lib/analytics/turn-stats";
import { computerLane, rememberNativeRejected } from "@/lib/computer/lane";
import log from "electron-log";
import type { IpcMainInvokeEvent } from "electron";
import type { ModelMessage } from "ai";
import { processStreamChunks } from "@/ipc/utils/stream_chunk_tags";
import { safeSend } from "@/ipc/utils/safe_sender";
import {
  EmptyModelOutputAfterRetryError,
  ProviderRefusedRequestError,
  isNoUsableModelOutputError,
} from "@/ipc/utils/no_usable_model_output";
import {
  RECONNECT_DELAYS_MS,
  isNetworkStreamError,
  isForcedToolChoiceRejection,
  isNativeComputerToolRejection,
  jitteredDelay,
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

/**
 * The provider's words. The refusal onError recorded is the SDK's `{ error }`
 * event, which logged as "[object Object]" (15.11.0, ai-c8's log).
 */
function refusalMessage(refusal: unknown): string {
  const e = (refusal as { error?: unknown } | null)?.error ?? refusal;
  return e instanceof Error ? e.message : String(e);
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
  },
): Promise<{
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
  // Retries that change the request (a refused forced tool_choice, a refused
  // computer tool version) are not attempts: each is bounded by its own
  // condition, and spending the cap on them let a network blip in the same
  // round fail the turn.
  let requestChanges = 0;
  for (let loop = 0; loop < TOTAL_ATTEMPT_CAP + requestChanges; loop++) {
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
      params.abortController.signal.addEventListener("abort", linkUserAbort, {
        once: true,
      });
    }
    // Hoisted out of the try ONLY so the catch can ask it what transport
    // failure it saw — the SDK throws a substitute error that no longer
    // carries that. Fresh per iteration, so a retry can't read a stale verdict.
    let bundle: SimpleStreamTextBundle | undefined;
    /**
     * A transport fault after the round had already completed steps: continue
     * from them (the stall path's continue-from-partial) instead of restarting,
     * which re-ran every tool call — the duplicated tool rows on Windows 14.52.2.
     * Spends the same network attempt budget and backoff as a restart. Null when
     * there is nothing to resume from or the budget is gone; the caller then
     * takes the ordinary restart / [Reconnect] path.
     */
    const resumeAfterNetworkFault = async (
      current: SimpleStreamTextBundle | undefined,
      fault: unknown,
    ): Promise<ModelMessage[] | null> => {
      const resumeMessages = current?.getResumeMessages?.() ?? [];
      if (resumeMessages.length === 0) return null;
      if (networkAttempt >= RECONNECT_DELAYS_MS.length) return null;
      const delay = jitteredDelay(networkAttempt, retryAfterMs(fault));
      networkAttempt++;
      noteTurn(params.chatId, "retries");
      logger.warn(
        `[stream] Network error after ${resumeMessages.length} completed step-message(s) — resuming from them after ${delay}ms (attempt ${networkAttempt}/${RECONNECT_DELAYS_MS.length}): ${
          fault instanceof Error ? fault.message : String(fault)
        }`,
      );
      sentryAddBreadcrumbSafe({
        category: "stream_retry",
        message: `network_resume_from_partial steps=${resumeMessages.length} attempt ${networkAttempt}/${RECONNECT_DELAYS_MS.length}`,
        level: "warning",
      });
      await new Promise((r) => setTimeout(r, delay));
      if (params.abortController.signal.aborted) throw new Error("aborted");
      return resumeMessages;
    };
    try {
      bundle = await params.runSimpleStream({
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
            finishReason: "unknown" as Awaited<
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
          const delay = jitteredDelay(networkAttempt);
          networkAttempt++;
          noteTurn(params.chatId, "retries");
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
      /**
       * A TRANSPORT FAULT THAT DID NOT THROW. Once a round has completed a step,
       * the SDK ends a stream whose NEXT request fails as if it had finished:
       * the error goes to `onError` (which records it and paints nothing) and
       * `finishReason` resolves. Only the catch below ever looked at the
       * recording, so the turn just stopped — no answer, no error, no retry
       * (Windows 14.52.2: two steps done, step 3 "Cannot connect to API").
       */
      const recordedFault = bundle.getRecordedNetworkError?.();
      if (recordedFault != null) {
        const resumeMessages = await resumeAfterNetworkFault(bundle, recordedFault);
        if (resumeMessages) {
          return {
            bundle,
            fullResponse,
            finishReason: "unknown" as Awaited<
              SimpleStreamTextBundle["finishReason"]
            >,
            resumeFromStall: resumeMessages,
          };
        }
        throw recordedFault;
      }
      return { bundle, fullResponse, finishReason };
    } catch (caught) {
      // User abort always wins over any retry path.
      if (params.abortController.signal.aborted) {
        throw caught;
      }

      /**
       * UNWRAP THE SDK'S SUBSTITUTE ERROR — this must happen BEFORE the
       * empty-output branch, or it changes nothing.
       *
       * A request-phase transport failure (the socket dies before any step
       * completes) never reaches this catch as itself. The SDK enqueues an `error`
       * part, then its flush sees zero completed steps and rejects the result
       * promises with a synthetic `NoOutputGeneratedError`, discarding the original
       * `APICallError` — not even as a `cause`. So `isEmptyOutputStreamError`
       * matched first, the round retried twice 1s apart while telling the model it
       * had "produced only internal reasoning", and then reported
       * `EmptyModelOutputAfterRetryError`: a dead socket surfaced to the user as a
       * model that would not answer. The 2s/5s/10s network retry below — which
       * exists for precisely this — was unreachable.
       *
       * `onError` classified it correctly at the time, so we ask the round what it
       * recorded and prefer that over the substitute. Only when the caught error IS
       * the substitute: a genuine empty output records nothing and is unaffected.
       */
      const recordedNetworkError = bundle?.getRecordedNetworkError?.();
      const err =
        recordedNetworkError != null && isEmptyOutputStreamError(caught)
          ? recordedNetworkError
          : caught;
      if (err !== caught) {
        logger.warn(
          "[stream] The SDK reported 'no output generated' for a transport failure — retrying as a network error instead",
        );
      }

      // Too long for the model: the original error, so handleTurnError's
      // overflow branch compacts and retries (not the SDK's "no output").
      const overflow = bundle?.getRecordedOverflow?.();
      if (overflow != null) throw overflow;

      // The provider refused the request itself (bad key, no access): the same
      // request is refused again, and onError already said why.
      const refusal = bundle?.getRecordedRefusal?.();
      if (refusal != null && isEmptyOutputStreamError(err)) {
        throw new ProviderRefusedRequestError(refusal);
      }

      // The provider refused the forced tool_choice (the wake turn's
      // `collect_results`). Deterministic — retrying the same request
      // fails identically — so change the request instead: clear the
      // forced choice and let the prepareStep injection deliver the same
      // results. Costs no backoff and no attempt budget, and the flag is
      // sticky so a later round in this turn never re-forces it.
      if (isForcedToolChoiceRejection(err) && !ctx.forcedToolChoiceRejected) {
        ctx.forcedToolChoiceRejected = true;
        requestChanges++;
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

      // The provider refused its own computer tool's version (Claude Haiku 4.5 on
      // Bedrock takes computer_20250124; Claude 5.5 on the Anthropic API only the
      // newer toolset). Same shape as above: change the request, not the timing.
      // The refusal is remembered for the model (lane.ts), so the retry, and every
      // request after it, sends the version it named, or our own `computer` tool
      // when none will do. The user loses nothing, and pays the refusal once.
      const computerRefusal =
        bundle?.getRecordedNativeComputerRejection?.() ??
        (isNativeComputerToolRejection(err) ? err : null);
      if (ctx.nativeComputerSent && !ctx.nativeComputerRejected && computerRefusal != null) {
        rememberNativeRejected(ctx.nativeComputerSent, computerRefusal);
        requestChanges++;
        // Each refusal rules a version out, so this ends: at worst on our own tool.
        ctx.nativeComputerRejected = computerLane(ctx.nativeComputerSent) !== "native-anthropic";
        logger.warn(
          `[stream] Provider refused its computer tool version — retrying with ${
            ctx.nativeComputerRejected ? "ours" : "the version it named"
          }: ${refusalMessage(computerRefusal)}`,
        );
        fullResponse = initialFullResponse;
        continue;
      }

      // Empty-output retry (pre-existing behavior).
      if (
        isEmptyOutputStreamError(err) &&
        emptyOutputAttempt < MAX_STREAM_EMPTY_OUTPUT_ATTEMPTS - 1
      ) {
        emptyOutputAttempt++;
        noteTurn(params.chatId, "retries");
        logger.warn(
          `[stream] Empty output on attempt ${emptyOutputAttempt}/${MAX_STREAM_EMPTY_OUTPUT_ATTEMPTS}, retrying after ${STREAM_EMPTY_OUTPUT_RETRY_DELAY_MS}ms...`,
        );
        sentryAddBreadcrumbSafe({
          category: "stream_retry",
          message: `empty_output_retry attempt ${emptyOutputAttempt}/${MAX_STREAM_EMPTY_OUTPUT_ATTEMPTS}`,
          level: "warning",
        });
        fullResponse = initialFullResponse;
        ctx.carriedInterjections = ctx.deliveredInterjections;
        ctx.deliveredInterjections = null;
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
      if (isNetworkStreamError(err)) {
        const resumeMessages = await resumeAfterNetworkFault(bundle, err);
        if (resumeMessages) {
          return {
            bundle: bundle!,
            fullResponse,
            finishReason: "unknown" as Awaited<
              SimpleStreamTextBundle["finishReason"]
            >,
            resumeFromStall: resumeMessages,
          };
        }
      }
      if (
        isNetworkStreamError(err) &&
        networkAttempt < RECONNECT_DELAYS_MS.length
      ) {
        // Honor a provider `Retry-After` (429/503) over the fixed
        // backoff; `jitteredDelay` caps it and only ever spreads
        // LATER, never earlier than the server asked.
        const retryAfter = retryAfterMs(err);
        const delay = jitteredDelay(networkAttempt, retryAfter);
        networkAttempt++;
        noteTurn(params.chatId, "retries");
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
        // Say why it's waiting: "Thinking… 9s" over a dead connection read as
        // the model being slow (QA, against Claude Code's "Retrying in Ns").
        safeSend(event.sender, "chat:stream:phase", {
          chatId: params.chatId,
          phase: "thinking",
          retry: true,
          label: `Couldn't connect, retrying in ${Math.max(1, Math.round(delay / 1000))}s (${networkAttempt}/${RECONNECT_DELAYS_MS.length})…`,
        });
        fullResponse = initialFullResponse;
        partialResponses.delete(params.chatId);
        // What you said mid-turn that this failed attempt took goes to the next.
        ctx.carriedInterjections = ctx.deliveredInterjections;
        ctx.deliveredInterjections = null;
        await new Promise((r) => setTimeout(r, delay));
        if (params.abortController.signal.aborted) throw err;
        continue;
      }
      if (isNetworkStreamError(err)) {
        throw new NetworkStreamDisconnectedError(fullResponse, err);
      }
      throw err;
    } finally {
      params.abortController.signal.removeEventListener("abort", linkUserAbort);
    }
  }
  throw new Error("runStreamRoundWithEmptyOutputRetry: unreachable");
}
