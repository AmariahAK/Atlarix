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
// The 402 parser lives in `lib/billing/insufficient-credit` because the sub-agent
// path needs the same figure and never reaches this classifier. Imported rather
// than duplicated: two parsers for one wire field is how they drift.
import { requiredCentsFromBody } from "@/lib/billing/insufficient-credit";

export interface CompassFailureClassification {
  message: string;
  /** True when the cause is ours (Core/infra), not the user's account or request. */
  isCompassInfraError: boolean;
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
