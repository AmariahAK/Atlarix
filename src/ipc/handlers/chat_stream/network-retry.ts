/**
 * Mid-stream error classification + silent-retry primitives extracted from
 * chat_stream_handlers.ts. Pure leaves, no module state. (Satellite: never
 * imports the parent handler.)
 */

import { ProviderFinishReasonError } from "@/ipc/utils/provider_finish_error";

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
export function isNetworkStreamError(err: unknown, depth = 0): boolean {
  if (!err) return false;
  if ((err as { name?: string })?.name === "AbortError") return false;
  // Atlarix Auto's daily limit is a 429 with a Retry-After of HOURS. Retrying it
  // (capped at 60s) would spin, then surface as a disconnect instead of the
  // "resets in Xh" message the classifier gives it. A decision, not a fault.
  if (/free_usage_limit/.test(String((err as { responseBody?: unknown })?.responseBody ?? ""))) {
    return false;
  }
  // A provider error delivered as a successful finish reason (HTTP 200, clean
  // stream, `finish_reason: "network_error"`). Recognized by CLASS rather than
  // left to the message regex below: that regex happens to match "network_error"
  // today, which would make this work by coincidence and break the moment a
  // provider spells it "upstream_failure".
  if (
    err instanceof ProviderFinishReasonError ||
    (err as { name?: string })?.name === "ProviderFinishReasonError"
  )
    return true;
  // The SDK names it "AI_APICallError"; checking only "APICallError" missed
  // every one, so an unreachable provider under Bun (whose fetch says "Unable
  // to connect…", which the message regex below doesn't know) became an empty
  // reply: "Something went wrong" (QA).
  const errName = (err as { name?: string })?.name;
  if (errName === "APICallError" || errName === "AI_APICallError") {
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
  // undici reports transport faults by CODE, and the wrapper it throws can carry
  // a message the regex below knows nothing about. Only genuinely transport-level
  // codes are listed: UND_ERR_ABORTED is deliberately absent, since an abort is a
  // decision rather than a fault and retrying it would fight the caller.
  const code = (err as { code?: unknown })?.code;
  if (
    typeof code === "string" &&
    [
      "UND_ERR_SOCKET",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "UND_ERR_RESPONSE_STATUS_CODE",
      "ECONNRESET",
      "ETIMEDOUT",
      "EPIPE",
    ].includes(code)
  )
    return true;

  const msg = String((err as { message?: unknown })?.message ?? err);
  if (
    /terminated|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|premature close|other side closed|connection (?:reset|refused|closed)|network/i.test(
      msg,
    )
  )
    return true;

  /**
   * Follow `cause` AND `error`.
   *
   * `cause`: undici wraps a socket fault in an outer error whose own message can be
   * uninformative while the cause names it exactly; checking only the top level
   * classified a real disconnect as a programming bug.
   *
   * `error`: the AI SDK's `onError` hands its callback an ENVELOPE — `{ error }`,
   * not the error — so this returned false for every request-phase transport
   * failure. `String(envelope)` is `"[object Object]"`, which the message regex
   * above knows nothing about, so `onError`'s network branch never fired and the
   * failure fell through to "This model failed". Its sibling
   * `isNoUsableModelOutputError` DOES unwrap `.error`, which is precisely how a
   * dead socket came to be classified as a model that produced no output. The two
   * must agree on the shape they are handed.
   *
   * Depth-capped rather than iterative: both chains can be cyclic, and the cap is
   * what makes the recursion safe.
   */
  if (depth < 4) {
    for (const key of ["cause", "error"] as const) {
      // Annotated: without it TS7022 — `nested` would be inferred from an
      // expression that recurses into this same function.
      const nested: unknown = (err as Record<string, unknown> | null)?.[key];
      if (nested && nested !== err && isNetworkStreamError(nested, depth + 1)) {
        return true;
      }
    }
  }
  return false;
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
    (err as { error?: { message?: unknown; responseBody?: unknown } })?.error
      ?.message,
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
  /** The last transport error's own words ("Cannot connect to API: …"). */
  detail?: string;
  constructor(partialResponse: string, cause?: unknown) {
    // The cause is kept, not just its words: a provider that kept answering 5xx
    // or 429 is that failure (turn-end reads its status), not "network".
    super("Network stream disconnected after retries");
    this.name = "NetworkStreamDisconnectedError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
    this.partialResponse = partialResponse;
    const m = cause instanceof Error ? cause.message : (cause as { error?: Error } | undefined)?.error?.message;
    if (m) this.detail = m;
  }
}
