/**
 * How a turn ended and, when it failed, why, as a short fixed word for
 * `turn_completed`. Never the error's text: provider messages can quote the
 * prompt back, and paths and emails ride along in them.
 *
 * Classification reads the error's shape (status, class, the proxy's machine
 * codes in the body). The body is matched for codes only and never leaves the
 * process.
 */
import {
  ASK_USER_STREAM_STOP,
  FORCE_TEXT_FINISH_STREAM_STOP,
  LOOP_REPETITION_STREAM_STOP,
  USER_CANCEL_STREAM_STOP,
  abortReasonSentinel,
} from "@/lib/stream/stream-stop-sentinels";
import {
  NetworkStreamDisconnectedError,
  isNetworkStreamError,
} from "@/ipc/handlers/chat_stream/network-retry";
import {
  EmptyModelOutputAfterRetryError,
  ProviderRefusedRequestError,
  isNoUsableModelOutputError,
} from "@/ipc/utils/no_usable_model_output";
import { isContextOverflowError } from "@/lib/context/compaction";
import { ATLARIX_AUTH_REQUIRED_PREFIX } from "@/shared/auth_ipc";

export type TurnOutcome = "ok" | "ask_user" | "stopped" | "aborted" | "error" | "gate";

/**
 * A turn the service refused ON PURPOSE, as policy, not a failure of anything:
 * the free share is used up, every free source is busy, consent has not been
 * given, or the account has no credit for the model it picked. Counted as a
 * `gate` outcome, so the error-rate alert and the crash reports ignore them
 * (2026-10-26/27: two such days paged the owner at 33–38% "errors").
 */
export type GateKind = "free_usage_limit" | "free_busy" | "consent_required" | "insufficient_credit";

export type TurnErrorKind =
  | "auth"
  | "quota"
  | "consent_required"
  | "rate_limit"
  | "context_overflow"
  | "provider_refused"
  | "bad_request"
  | "timeout"
  | "provider_5xx"
  | "network"
  | "no_output"
  | "content_rejected"
  | "tool_loop"
  | "no_workspace"
  | "other";

export interface TurnErrorClass {
  kind: TurnErrorKind;
  httpStatus?: number;
}

export interface TurnEnd {
  outcome: TurnOutcome;
  errorKind?: TurnErrorKind;
  httpStatus?: number;
  /** Set when `outcome` is "gate". */
  gateKind?: GateKind;
}

/** The gate a classified failure is, if it is one. Shared with the stream-error swap in analytics.ts. */
export function gateOf(kind: TurnErrorKind | string | undefined, httpStatus?: number, body = ""): GateKind | undefined {
  if (kind === "consent_required") return "consent_required";
  if (/free_usage_limit/.test(body) || (kind === "quota" && httpStatus === 429)) return "free_usage_limit";
  if (/free_busy/.test(body) || (kind === "rate_limit" && httpStatus === 503)) return "free_busy";
  if (/insufficient_credit/.test(body) || (kind === "quota" && httpStatus === 402)) return "insufficient_credit";
  return undefined;
}

/** The error, then what the AI SDK wraps inside it. */
function layers(err: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur && typeof cur === "object"; i++) {
    const o = cur as Record<string, unknown>;
    out.push(o);
    if (o.error && typeof o.error === "object") out.push(o.error as Record<string, unknown>);
    // ProviderRefusedRequestError keeps the provider's own error as `refusal`.
    cur = o.cause ?? o.lastError ?? o.refusal;
  }
  return out;
}

function statusOf(err: unknown): number | undefined {
  for (const l of layers(err)) {
    if (typeof l.statusCode === "number") return l.statusCode;
    if (typeof l.status === "number") return l.status;
    // The proxy's late in-stream error carries the original status as `code`.
    if (l.type === "atlarix_late_error" && typeof l.code === "number") return l.code;
  }
  return undefined;
}

function bodyOf(err: unknown): string {
  return layers(err)
    .map((l) => (typeof l.responseBody === "string" ? l.responseBody : l.type === "atlarix_late_error" ? String(l.message ?? "") : ""))
    .join("\n");
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "";
}

function nameOf(err: unknown): string {
  return String((err as { name?: unknown } | null)?.name ?? "");
}

/** Why a request or turn failed, as one word. */
export function classifyTurnError(err: unknown): TurnErrorClass {
  const httpStatus = statusOf(err);
  const at = (kind: TurnErrorKind): TurnErrorClass => (httpStatus ? { kind, httpStatus } : { kind });
  const body = bodyOf(err);
  const name = nameOf(err);
  if (messageOf(err).includes(ATLARIX_AUTH_REQUIRED_PREFIX) || /account_banned/.test(body)) return at("auth");
  // The proxy's codes first: its free limit is a 429 and "busy" a 503.
  if (/"consent_required"\s*:\s*true/.test(body)) return at("consent_required");
  if (/free_usage_limit|insufficient_credit/.test(body) || httpStatus === 402) return at("quota");
  if (/free_busy/.test(body)) return at("rate_limit");
  if (isContextOverflowError(err)) return at("context_overflow");
  // Before "refused": a provider refusing a rejected key is an auth failure.
  if (httpStatus === 401 || httpStatus === 403) return at("auth");
  if (err instanceof ProviderRefusedRequestError || name === "ProviderRefusedRequestError") return at("provider_refused");
  if (name === "ChatPromptSafetyError") return at("content_rejected");
  if (httpStatus === 429) return at("rate_limit");
  if (httpStatus === 408 || httpStatus === 504 || name === "TimeoutError") return at("timeout");
  if (httpStatus !== undefined && httpStatus >= 500) return at("provider_5xx");
  if (httpStatus !== undefined && httpStatus >= 400) return at("bad_request");
  if (err instanceof NetworkStreamDisconnectedError || isNetworkStreamError(err)) return at("network");
  if (err instanceof EmptyModelOutputAfterRetryError || isNoUsableModelOutputError(err)) return at("no_output");
  return at("other");
}

/**
 * How the turn ended. `error` is what the turn threw, or undefined when it
 * returned. The abort reason wins: an aborted stream rejects with whatever the
 * SDK had in flight, which says nothing about why it stopped.
 */
export function classifyTurnEnd(error: unknown, signal: AbortSignal): TurnEnd {
  if (signal.aborted) {
    const sentinel = abortReasonSentinel(signal.reason);
    if (sentinel === ASK_USER_STREAM_STOP) return { outcome: "ask_user" };
    if (sentinel === USER_CANCEL_STREAM_STOP) return { outcome: "stopped" };
    if (sentinel === LOOP_REPETITION_STREAM_STOP) return { outcome: "aborted", errorKind: "tool_loop" };
    // "Wrap up now" ends with a final answer: a finished turn, not a stop.
    if (sentinel !== FORCE_TEXT_FINISH_STREAM_STOP || error !== undefined) return { outcome: "aborted" };
  }
  if (error === undefined) return { outcome: "ok" };
  const c = classifyTurnError(error);
  const status = c.httpStatus ? { httpStatus: c.httpStatus } : {};
  const gate = gateOf(c.kind, c.httpStatus, bodyOf(error));
  if (gate) return { outcome: "gate", gateKind: gate, errorKind: c.kind, ...status };
  return { outcome: "error", errorKind: c.kind, ...status };
}
