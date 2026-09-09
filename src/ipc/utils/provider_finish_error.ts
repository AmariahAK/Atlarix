/**
 * An error the provider delivered as a SUCCESSFUL finish.
 *
 * An OpenAI-compatible gateway can answer with HTTP 200, a well-formed SSE
 * stream, and `finish_reason: "network_error"` — the failure is in the body, not
 * the transport. Nothing throws, so the mid-stream retry never arms; the AI SDK
 * maps the unrecognized value to `finishReason: "unknown"`, `run-agent-turn`
 * falls back to its structural yield proxy, and a truncated answer is
 * indistinguishable from the model deciding it was done. The user sees a reply
 * that stops mid-thought and no error at all.
 *
 * `ai` exposes the provider's own string as `rawFinishReason` on the finish
 * parts; the mapped `finishReason` has already thrown the evidence away. So the
 * raw value is the only place this is visible, and reading it turns a silent
 * truncation into the transient it always was — retryable by the backoff that
 * already exists.
 *
 * Observed in the wild by opencode, twice in one day (`e0b9e68a`, `40282c1d`),
 * which is why this is treated as real provider behaviour rather than a
 * hypothetical.
 *
 * (Leaf: no module state, imported by both the stream reader and the retry
 * classifier so neither has to depend on the other.)
 */

/** Thrown when a finish part carries a provider error in place of a reason. */
export class ProviderFinishReasonError extends Error {
  /** The provider's own string, kept for the log line and Sentry breadcrumb. */
  rawFinishReason: string;
  constructor(rawFinishReason: string) {
    super(`Provider finish_reason: ${rawFinishReason}`);
    this.name = "ProviderFinishReasonError";
    this.rawFinishReason = rawFinishReason;
  }
}

/**
 * Finish reasons that are really errors.
 *
 * Deliberately a DENY list keyed on error vocabulary, not an allow list of good
 * values. An allow list would have to enumerate every vendor's spelling of
 * "stop" — and getting that wrong fails closed in the worst way: a legitimate
 * completion would be retried as an error, doubling cost and re-running tools.
 * An unknown-but-benign reason keeps its existing path (mapped to "unknown",
 * handled by the structural proxy), which is already correct.
 *
 * `content_filter` and `length` are NOT here. Both are real, deterministic
 * outcomes with their own handling — a retry would hit the identical wall.
 */
const ERROR_FINISH_REASON =
  /^(?:.*[_\-\s])?(?:error|failure|failed|timeout|timedout|unavailable|overloaded|exhausted|aborted|interrupted|cancelled|canceled|disconnect(?:ed)?|reset)(?:[_\-\s].*)?$/i;

/**
 * The provider's raw finish reason, if it names a failure.
 *
 * Returns the offending string so the caller can put it in the error and the
 * log; `null` means "nothing to see", which is the overwhelmingly common case.
 */
export function errorShapedFinishReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  return ERROR_FINISH_REASON.test(s) ? s : null;
}
