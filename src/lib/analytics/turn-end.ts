/**
 * How a turn ended and, when it failed, why, as a short fixed word for
 * `turn_completed`. Never the error's text: provider messages can quote the
 * prompt back, and paths and emails ride along in them.
 *
 * Classification reads the error's shape (status, class, the proxy's machine
 * codes in the body). The body is matched for codes only and never leaves the
 * process.
 */
import { UserFacingRefusal, byokLimitKind, type RefusalRule } from "@/shared/texts";
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
 * the free share is used up, every free source is busy, or the account has no
 * credit for the model it picked. Counted as a
 * `gate` outcome, so the error-rate alert and the crash reports ignore them
 * (2026-10-26/27: two such days paged the owner at 33–38% "errors").
 */
export type GateKind =
  | "free_usage_limit"
  | "free_busy"
  | "insufficient_credit"
  /** The person's own rule stopped the turn: a silk off/scoped away/broken, or an edict. */
  | "rule";

export type TurnErrorKind =
  | "auth"
  | "quota"
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
  | RefusalRule
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
  /** The provider's machine code for a failure (providerCodeOf). */
  providerCode?: string;
}

/**
 * The gate a classified failure is, if it is one. Shared with the stream-error swap in analytics.ts.
 * Gates are Atlarix's own policy: `byok` (the turn ran on the user's own
 * provider) has none, so its 402 is a failure, not Atlarix's wallet.
 */
export function gateOf(
  kind: TurnErrorKind | string | undefined,
  httpStatus?: number,
  body = "",
  opts?: { byok?: boolean },
): GateKind | undefined {
  if (opts?.byok) return undefined;
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

/** The provider's words in every layer: messages, bodies, codes. Matched here, never sent. */
function wordsOf(err: unknown): string {
  return layers(err)
    .flatMap((l) => [l.message, l.responseBody, l.code, l.type])
    .filter((v): v is string => typeof v === "string")
    .join("\n");
}

const PROVIDER_CODE_MAX = 40;

/** A code as a provider spells it ("insufficient_quota", "RESOURCE_EXHAUSTED"), or null for anything else. */
function asProviderCode(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > PROVIDER_CODE_MAX) return null;
  // All lower case, or an all-capitals enum. Mixed case is not a code (a key is).
  const code = /^[A-Z][A-Z0-9_.-]*$/.test(v) ? v.toLowerCase() : v;
  if (!/^[a-z][a-z0-9_.-]*$/.test(code)) return null;
  // A code is words: a run of digits that long is an id or a key.
  if ((code.match(/[0-9]/g)?.length ?? 0) > 4) return null;
  if (/^(sk|pk|rk)[-_]/.test(code)) return null;
  return code;
}

/**
 * The provider's MACHINE code for a failure (OpenAI's `error.code`, Anthropic's
 * `error.type`, Google's `error.status`), so a refusal says why without its
 * text: provider messages quote the prompt back. Allowlisted ([a-z0-9_.-],
 * capped, at most four digits), and dropped, never trimmed, when anything else.
 * Atlarix's own codes (`{"error":"free_usage_limit"}`) are the gate's, not this.
 */
export function providerCodeOf(err: unknown): string | undefined {
  const fromObject = (e: unknown): string | null => {
    if (!e || typeof e !== "object") return null;
    const o = e as Record<string, unknown>;
    if (o.type === "atlarix_late_error") return null;
    return asProviderCode(o.code) ?? asProviderCode(o.type) ?? asProviderCode(o.status);
  };
  for (const l of layers(err)) {
    if (typeof l.responseBody === "string" && l.responseBody.trimStart().startsWith("{")) {
      try {
        const parsed = JSON.parse(l.responseBody) as { error?: unknown };
        const code = fromObject(parsed?.error);
        if (code) return code;
      } catch {
        /* not JSON: no code */
      }
    }
  }
  // An error sent inside the stream: the SDK hands over `{ error: { code, type, message } }`.
  for (const l of layers(err)) {
    if (l instanceof Error || "statusCode" in l || "responseBody" in l) continue;
    if (typeof l.message !== "string" && l.code === undefined && l.type === undefined) continue;
    const code = fromObject(l);
    if (code) return code;
  }
  return undefined;
}

/** `{ providerCode }` when the failure carries one, else nothing. */
export function providerCodeField(err: unknown): { providerCode?: string } {
  const providerCode = providerCodeOf(err);
  return providerCode ? { providerCode } : {};
}

/**
 * Why a request or turn failed, as one word. `byok`: the turn ran on the user's
 * own provider, whose credit, key and rate failures are told apart by the same
 * words the message uses (texts.ts byokLimitKind), whatever their status.
 */
export function classifyTurnError(err: unknown, opts?: { byok?: boolean }): TurnErrorClass {
  const httpStatus = statusOf(err);
  const at = (kind: TurnErrorKind): TurnErrorClass => (httpStatus ? { kind, httpStatus } : { kind });
  const body = bodyOf(err);
  const name = nameOf(err);
  if (messageOf(err).includes(ATLARIX_AUTH_REQUIRED_PREFIX) || /account_banned/.test(body)) return at("auth");
  // The proxy's codes first: its free limit is a 429 and "busy" a 503.
  if (/free_usage_limit|insufficient_credit/.test(body) || httpStatus === 402) return at("quota");
  if (/free_busy/.test(body)) return at("rate_limit");
  if (isContextOverflowError(err)) return at("context_overflow");
  if (opts?.byok) {
    // Anthropic's "credit balance is too low" is a 400, OpenAI's insufficient_quota a 429.
    const limit = byokLimitKind(wordsOf(err));
    if (limit === "credit") return at("quota");
    if (limit === "key") return at("auth");
    // An overloaded 5xx stays the provider's fault.
    if (limit === "rate" && (httpStatus === undefined || httpStatus < 500)) return at("rate_limit");
  }
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
export function classifyTurnEnd(
  error: unknown,
  signal: AbortSignal,
  /** The provider the turn ran on: Atlarix ("compass") has gates, your own has none. */
  opts?: { provider?: string },
): TurnEnd {
  if (signal.aborted) {
    const sentinel = abortReasonSentinel(signal.reason);
    if (sentinel === ASK_USER_STREAM_STOP) return { outcome: "ask_user" };
    if (sentinel === USER_CANCEL_STREAM_STOP) return { outcome: "stopped" };
    if (sentinel === LOOP_REPETITION_STREAM_STOP) return { outcome: "aborted", errorKind: "tool_loop" };
    // "Wrap up now" ends with a final answer: a finished turn, not a stop.
    if (sentinel !== FORCE_TEXT_FINISH_STREAM_STOP || error !== undefined) return { outcome: "aborted" };
  }
  if (error === undefined) return { outcome: "ok" };
  // Not the service's policy and not a failure: the person's own silks or
  // edicts said no. One gate kind; the rule says which (2026-10-30, ai-dd).
  if (error instanceof UserFacingRefusal) return { outcome: "gate", gateKind: "rule", errorKind: error.rule };
  const byok = opts?.provider != null && opts.provider !== "compass";
  const c = classifyTurnError(error, { byok });
  const status = c.httpStatus ? { httpStatus: c.httpStatus } : {};
  const code = providerCodeField(error);
  const gate = gateOf(c.kind, c.httpStatus, bodyOf(error), { byok });
  if (gate) return { outcome: "gate", gateKind: gate, errorKind: c.kind, ...status, ...code };
  return { outcome: "error", errorKind: c.kind, ...status, ...code };
}
