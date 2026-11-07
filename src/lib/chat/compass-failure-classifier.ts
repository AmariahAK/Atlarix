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
 *    "top up" rather than "we can't reach Core" — in the account's own state
 *    (never funded / spent / Pro allowance), read from the 402's optional fields.
 *  - everything unrecognised falls through to reachability and is flagged as OUR
 *    infrastructure problem, not the user's.
 */
import {
  COMPASS_REACHABILITY_ERROR,
  accountBannedUserMessage,
  compassAuthExpiredUserMessage,
  compassBadRequestUserMessage,
  coreRateLimitedMessage,
  coreRefusalMessage,
  coreUnavailableUserMessage,
  freeAutoBusyMessage,
  freeAutoLimitMessage,
  parseCreditRefusal,
} from "@/shared/billing_copy";
import { freeAutoResetsAtFromBody } from "@/lib/billing/free-auto-gate";

export interface CompassFailureClassification {
  message: string;
  /** True when the cause is ours (Core/infra), not the user's account or request. */
  isCompassInfraError: boolean;
  /**
   * Free Auto's daily limit only: when it lifts (epoch ms), so the surface can
   * tick the countdown and send nothing until then.
   */
  freeAutoResetsAt?: number;
}

export function classifyCompassFailure(
  statusCode: number | undefined,
  bodyStr: string,
): CompassFailureClassification {
  // FIRST, and by body not status — see the note above.
  if (/account_banned/.test(bodyStr)) {
    return { message: accountBannedUserMessage(), isCompassInfraError: false };
  }
  // Atlarix Auto. Before 402/503: the limit is a 429 and "busy" a 503, and the
  // generic 503 branch would call a full free share "Core is unavailable".
  if (/free_usage_limit/.test(bodyStr)) {
    const at = freeAutoResetsAtFromBody(bodyStr);
    return {
      message: freeAutoLimitMessage(at),
      isCompassInfraError: false,
      ...(at != null ? { freeAutoResetsAt: at } : {}),
    };
  }
  if (/free_busy/.test(bodyStr)) {
    return { message: freeAutoBusyMessage(), isCompassInfraError: false };
  }
  // A paid request the provider made wait too long. Before the generic 429/503
  // handling: it is neither the user's balance nor our outage.
  if (/core_rate_limited/.test(bodyStr)) {
    const secs = /"retry_after_seconds"\s*:\s*(\d+)/.exec(bodyStr)?.[1];
    return { message: coreRateLimitedMessage(secs ? Number(secs) : null), isCompassInfraError: false };
  }
  if (statusCode === 402 || /insufficient_credit/.test(bodyStr)) {
    return {
      message: coreRefusalMessage(parseCreditRefusal(bodyStr)),
      isCompassInfraError: false,
    };
  }
  if (statusCode === 503 || /core_unavailable/.test(bodyStr)) {
    return { message: coreUnavailableUserMessage(), isCompassInfraError: true };
  }
  if (statusCode === 401 || statusCode === 403) {
    return {
      message: compassAuthExpiredUserMessage(),
      isCompassInfraError: false,
    };
  }
  if (statusCode === 400 || statusCode === 422) {
    return {
      message: compassBadRequestUserMessage(bodyStr),
      isCompassInfraError: true,
    };
  }
  return { message: COMPASS_REACHABILITY_ERROR, isCompassInfraError: true };
}
