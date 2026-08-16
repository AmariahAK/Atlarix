/**
 * Mid-stream error classification + silent-retry primitives extracted from
 * chat_stream_handlers.ts. Pure leaves, no module state. (Satellite: never
 * imports the parent handler.)
 */

/**
 * Base backoff schedule for the silent mid-stream retry. Always read through
 * `jitteredDelay()` — never awaited directly.
 *
 * This is the ONLY retry on the agent path: `simple-stream-text.ts` sets the AI
 * SDK's own `maxRetries: 0` whenever tools are present, so there is no second
 * backoff underneath this one. Don't re-add SDK retries without revisiting the
 * schedule — the two would multiply.
 */
export const RECONNECT_DELAYS_MS = [2000, 5000, 10000];

/** Ceiling on a provider-supplied `Retry-After`, so a hostile or misconfigured
 * header can't hang the turn. */
const RETRY_AFTER_CAP_MS = 60_000;

/** Positive-only spread added on top of a `Retry-After`. Small: the server named
 * a time, we only de-synchronize around it. */
const RETRY_AFTER_JITTER_MS = 1_000;

/**
 * The backoff for `attempt`, spread so simultaneous retries don't land together.
 *
 * Without this, every client and every one of the (up to 5) concurrent
 * sub-agents in a turn retries on the identical 2s/5s/10s schedule: one provider
 * blip becomes a synchronized stampede. For Atlarix Core that stampede lands on
 * our own proxy, so the unjittered schedule was a self-inflicted load spike.
 *
 * Equal jitter (`base/2 + rand(0, base/2)`) rather than full jitter: with only
 * three attempts, full jitter's near-zero draws would retry almost immediately
 * and defeat the backoff for the client that drew them. Equal jitter keeps a
 * `base/2` floor while still spreading arrivals across the window.
 *
 * `retryAfter` (429/503) is authoritative — the result is never EARLIER than the
 * server asked for. Jitter there is additive only.
 */
export function jitteredDelay(
  attempt: number,
  retryAfter?: number | null,
): number {
  if (retryAfter != null && Number.isFinite(retryAfter) && retryAfter >= 0) {
    const capped = Math.min(retryAfter, RETRY_AFTER_CAP_MS);
    return Math.round(capped + Math.random() * RETRY_AFTER_JITTER_MS);
  }
  const idx = Math.min(
    Math.max(0, Math.floor(attempt) || 0),
    RECONNECT_DELAYS_MS.length - 1,
  );
  const base = RECONNECT_DELAYS_MS[idx];
  const half = base / 2;
  return Math.round(half + Math.random() * half);
}

/**
 * Distinguish a network/provider mid-stream failure (worth silently retrying)
 * from a user abort or a malformed-request error (must not be retried).
 *
 * AbortError-class exceptions and `abortController.signal.aborted` already
 * short-circuit elsewhere; this helper is defensive about the message-only
 * cases the AI SDK surfaces when fetch socket dies.
 */
export function isNetworkStreamError(err: unknown): boolean {
  if (!err) return false;
  if ((err as { name?: string })?.name === "AbortError") return false;
  if ((err as { name?: string })?.name === "APICallError") {
    // Don't blindly retry EVERY APICallError — a deterministic 4xx (400 bad
    // request, 401/403 auth, 404, 422) fails identically on retry and just
    // wastes the backoff. Honor the SDK's own `isRetryable` verdict when present
    // (it flags 408/409/429/5xx), else fall back to the status code: retry only
    // 429 (rate limit) and 5xx (server/transient).
    const retryable = (err as { isRetryable?: unknown }).isRetryable;
    if (typeof retryable === "boolean") return retryable;
    const code = errorStatusCode(err);
    if (code == null) return true; // transport-level APICallError (no HTTP status)
    return code === 429 || code >= 500;
  }
  const msg = String((err as { message?: unknown })?.message ?? err);
  return /terminated|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|premature close|connection (?:reset|refused|closed)|network/i.test(
    msg,
  );
}

/**
 * A provider refusing the forced `tool_choice` we sent — recoverable by dropping
 * the forced choice and retrying, NOT by backing off.
 *
 * Deliberately provider-agnostic: the wording differs per vendor (Z.ai/DeepSeek
 * "Thinking mode does not support this tool_choice"; Alibaba "tool_choice ... not
 * supported ... in thinking mode"; Anthropic "tool_choice ... not supported when
 * thinking is enabled"), so we key on the parameter name appearing in a
 * deterministic 4xx rather than on any one vendor's phrasing. Retrying the same
 * request would fail identically — the caller must change the request.
 */
export function isForcedToolChoiceRejection(err: unknown): boolean {
  if (!err) return false;
  const code = errorStatusCode(err);
  // A 5xx mentioning tool_choice is an upstream fault, not a request we can fix.
  if (code != null && (code < 400 || code >= 500)) return false;
  const parts = [
    (err as { message?: unknown })?.message,
    (err as { responseBody?: unknown })?.responseBody,
    (err as { error?: { message?: unknown; responseBody?: unknown } })?.error?.message,
    (err as { error?: { message?: unknown; responseBody?: unknown } })?.error
      ?.responseBody,
  ];
  return parts.some(
    (p) => typeof p === "string" && /tool[_\s-]?choice/i.test(p),
  );
}

/** HTTP status code from an APICallError-shaped error, if present. */
export function errorStatusCode(err: unknown): number | undefined {
  const s = (err as { statusCode?: unknown })?.statusCode;
  return typeof s === "number" ? s : undefined;
}

/**
 * Parse a `Retry-After` response header (delta-seconds or an HTTP-date) into a
 * millisecond delay, or null when absent/unparseable. Provider-neutral — keys
 * off the HTTP surface, not any specific gateway. Capped by the caller.
 */
export function retryAfterMs(err: unknown): number | null {
  const headers = (err as { responseHeaders?: Record<string, string> })
    ?.responseHeaders;
  if (!headers) return null;
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

/**
 * Thrown after the silent retry sequence exhausts itself. Carries the
 * accumulated partial response so the outer catch can include it in the
 * `chat:stream:disconnected` IPC payload — the renderer keeps it visible
 * while the user decides whether to `[Reconnect]` or `[Continue]`.
 */
export class NetworkStreamDisconnectedError extends Error {
  partialResponse: string;
  constructor(partialResponse: string) {
    super("Network stream disconnected after retries");
    this.name = "NetworkStreamDisconnectedError";
    this.partialResponse = partialResponse;
  }
}
