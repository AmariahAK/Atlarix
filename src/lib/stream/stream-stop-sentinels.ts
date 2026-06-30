import { COMPASS_LIMIT_STREAM_STOP } from "@/lib/auth/compass_enforcement";

/**
 * v13.3: intentional stream-stop abort reasons.
 *
 * The agent harness ends turns by aborting the in-flight stream with a
 * sentinel reason (ask_user end-turn, loop guard, Compass token limit). Under
 * ai@6 the SDK/undici reject in-flight work with
 * the abort reason VERBATIM, and some of those rejections surface in
 * detached promises after the turn has already finalized — benign by
 * construction, but they land in the process-level safety nets. This module
 * is the single source of truth for the sentinels plus the helpers the
 * abort sites, comparison sites, and safety nets share.
 */

/**
 * v11.1: abort reason when the model asked the user question(s) — the turn
 * ENDS cleanly (persist + chat:response:end), the user answers asynchronously,
 * and a new stream continues. Not a user cancel; no blocking wait anymore.
 */
export const ASK_USER_STREAM_STOP = "ask_user_pending";

/**
 * Abort reason when the agentic repetition guard escalates to loop_abort.
 * Must abort the IN-FLIGHT stream: the AI SDK multi-step loop (stopWhen never
 * true) only returns to the outer round when the model stops calling tools,
 * so `consumeLoopBreak()` at the round boundary is unreachable for a model
 * stuck repeating tool calls — without this abort the turn runs unbounded
 * (verified by tests/agent-evals/loop-detection.eval.test.ts).
 */
export const LOOP_REPETITION_STREAM_STOP = "loop_repetition";

/**
 * Abort reason when a NEW stream supersedes an in-flight one for the same chat
 * (single-flight guard). The superseded leg unwinds cleanly — its late
 * `chat:response:end` is dropped by the renderer's dispatch-id gate — so this
 * must read as an intentional stop, not a user cancel or an error.
 */
export const SUPERSEDED_STREAM_STOP = "superseded_stream";

/**
 * Abort reason when the repetition guard (or the round-count backstop) decides
 * to WRAP UP instead of hard-stopping. Unlike LOOP_REPETITION_STREAM_STOP this
 * does NOT end the turn: the engine (run-agent-turn) catches it and runs ONE
 * final round with tools disabled + a summarize-and-stop prompt, so the model
 * gets to explain what it did and what remains (mirrors opencode's MAX_STEPS
 * force-finish). It is still an intentional stop for the process-level nets.
 */
export const FORCE_TEXT_FINISH_STREAM_STOP = "force_text_finish";

const STREAM_STOP_SENTINELS: ReadonlySet<string> = new Set([
  ASK_USER_STREAM_STOP,
  LOOP_REPETITION_STREAM_STOP,
  COMPASS_LIMIT_STREAM_STOP,
  SUPERSEDED_STREAM_STOP,
  FORCE_TEXT_FINISH_STREAM_STOP,
]);

/**
 * Wrap a sentinel for `AbortController.abort()`. A bare-string reason is not
 * an Error — it fails the SDK's isAbortError check (teardown escalates
 * instead of swallowing) and surfaces as an uncaught non-Error. A real
 * AbortError DOMException keeps every consumer on the graceful path.
 */
export function streamStopAbortReason(sentinel: string): DOMException {
  return new DOMException(sentinel, "AbortError");
}

/** Recover the sentinel string from an abort reason (string or wrapped). */
export function abortReasonSentinel(reason: unknown): string | undefined {
  return typeof reason === "string"
    ? reason
    : reason instanceof Error
      ? reason.message
      : undefined;
}

/**
 * Is this error/rejection one of our intentional stream-stop aborts?
 * Used by the process-level safety nets (main.ts, tests/infra) to swallow
 * the post-finalization rejections as benign instead of reporting them.
 */
export function isStreamStopAbort(reason: unknown): boolean {
  const sentinel = abortReasonSentinel(reason);
  return sentinel != null && STREAM_STOP_SENTINELS.has(sentinel);
}

/** Is this abort the graceful "wrap up with a final tools-off round" signal? */
export function isForceTextFinishAbort(reason: unknown): boolean {
  return abortReasonSentinel(reason) === FORCE_TEXT_FINISH_STREAM_STOP;
}
