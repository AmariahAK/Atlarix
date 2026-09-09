/**
 * Classify an Atlarix Core (proxy) failure into the message the user sees.
 *
 * Extracted from `simple-stream-text`'s error handler so the ORDER is testable.
 * The order is the whole substance of this function:
 *
 *  - `account_banned` is matched on the BODY and matched FIRST, because a ban
 *    arrives as 403 and the 401/403 branch below maps that to "your session
 *    expired, sign in again" — the wrong instruction for a ban, since signing in
 *    again changes nothing.
 *  - `insufficient_credit` before the generic branches, so an empty wallet says
 *    "top up" rather than "we can't reach Core".
 *  - everything unrecognised falls through to reachability and is flagged as OUR
 *    infrastructure problem, not the user's.
 */
import {
  COMPASS_REACHABILITY_ERROR,
  accountBannedUserMessage,
  compassAuthExpiredUserMessage,
  compassBadRequestUserMessage,
  coreExhaustedUserMessage,
  coreUnavailableUserMessage,
} from "@/shared/billing_copy";

export interface CompassFailureClassification {
  message: string;
  /** True when the cause is ours (Core/infra), not the user's account or request. */
  isCompassInfraError: boolean;
}

/**
 * The `required_cents` the proxy sends with a 402, or null.
 *
 * Parsed HERE rather than threaded through the IPC payload, because this is the last
 * place the raw response body exists — one line later it has been flattened to a
 * message string, and every consumer downstream (`chat:response:error`, the error atom,
 * `ChatErrorBox`) is string-typed. Widening all of that to carry one integer would touch
 * a dozen call sites and twelve other senders that have no number to send.
 *
 * TOLERANT BY DESIGN. A body that is not JSON, or is JSON without the field, or has it
 * as a string, must degrade to the refusal without the figure — never to a thrown error
 * inside an error handler. The regex fallback exists because the body may arrive already
 * embedded in a wrapper message rather than as a bare JSON document.
 */
function requiredCentsFromBody(bodyStr: string): number | null {
  const finite = (v: unknown): number | null => {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
  };
  try {
    const parsed = JSON.parse(bodyStr) as { required_cents?: unknown };
    const direct = finite(parsed?.required_cents);
    if (direct !== null) return direct;
  } catch {
    // Not a bare JSON body — fall through to the substring form.
  }
  const m = /"required_cents"\s*:\s*"?(\d+(?:\.\d+)?)"?/.exec(bodyStr);
  return m ? finite(m[1]) : null;
}

export function classifyCompassFailure(
  statusCode: number | undefined,
  bodyStr: string,
): CompassFailureClassification {
  // FIRST, and by body not status — see the note above.
  if (/account_banned/.test(bodyStr)) {
    return { message: accountBannedUserMessage(), isCompassInfraError: false };
  }
  if (statusCode === 402 || /insufficient_credit/.test(bodyStr)) {
    return {
      message: coreExhaustedUserMessage(requiredCentsFromBody(bodyStr)),
      isCompassInfraError: false,
    };
  }
  if (statusCode === 503 || /core_unavailable/.test(bodyStr)) {
    return { message: coreUnavailableUserMessage(), isCompassInfraError: true };
  }
  if (statusCode === 401 || statusCode === 403) {
    return { message: compassAuthExpiredUserMessage(), isCompassInfraError: false };
  }
  if (statusCode === 400 || statusCode === 422) {
    return {
      message: compassBadRequestUserMessage(bodyStr),
      isCompassInfraError: true,
    };
  }
  return { message: COMPASS_REACHABILITY_ERROR, isCompassInfraError: true };
}
