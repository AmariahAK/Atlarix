/**
 * Mid-stream network-error classification + silent-retry primitives extracted
 * from chat_stream_handlers.ts. Pure leaves, no module state. (Satellite: never
 * imports the parent handler.)
 */

export const RECONNECT_DELAYS_MS = [2000, 5000, 10000];

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
