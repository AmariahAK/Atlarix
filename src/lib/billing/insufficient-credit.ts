/**
 * One answer to "did this failure mean the wallet is empty?"
 *
 * WHY THIS EXISTS. Two completely separate call stacks need that verdict and, until
 * now, only one of them could form it. The main turn's failure reaches
 * `classifyCompassFailure`, which turns a status + body into renderer copy; a
 * sub-agent's failure never reaches it at all (`runSubagent` calls `streamText`
 * directly, so the classifier's single call site in `simple-stream-text` is never
 * on the child's path). The classifier is also the wrong thing to reuse: it returns
 * a SENTENCE FOR A HUMAN, and deciding control flow by substring-matching
 * user-facing prose is the trap `workspace-caps.ts` exists to prevent — the copy
 * gets reworded and the control flow silently stops firing.
 *
 * So the verdict lives here, as a predicate over the raw error, and the classifier
 * borrows this module's parser rather than keeping a second copy of it.
 *
 * TOLERANT BY DESIGN, in both directions. Everything here runs INSIDE an error
 * handler, so it must never throw: an unrecognised shape degrades to "not a credit
 * failure" and the caller falls through to its generic path. And it deliberately
 * accepts either signal — the 402 status or the `insufficient_credit` body — because
 * the two travel differently. The AI SDK wraps a provider error, so the status
 * arrives on the wrapper in some paths and on `.error` in others, while a stream's
 * `error` part carries the original `APICallError` with both.
 */

import { parseCreditRefusal } from "@/shared/billing_copy";

/** The status code and response body of a Core failure, however it was wrapped. */
export type CoreErrorParts = {
  statusCode: number | undefined;
  bodyStr: string;
};

/**
 * Dig the status and body out of an error, one wrapper deep.
 *
 * The two-level lookup is not defensive padding: the AI SDK surfaces a provider
 * failure both as the thrown value itself and as `{ error }` on a stream error part,
 * and the main turn already had to read both spellings inline. Extracted so the
 * child path reads it the same way rather than growing a third variant.
 */
export function extractCoreErrorParts(error: unknown): CoreErrorParts {
  const e = error as
    | {
        statusCode?: unknown;
        responseBody?: unknown;
        error?: { statusCode?: unknown; responseBody?: unknown };
      }
    | null
    | undefined;

  const rawStatus = e?.statusCode ?? e?.error?.statusCode;
  const statusCode =
    typeof rawStatus === "number" && Number.isFinite(rawStatus)
      ? rawStatus
      : undefined;

  const rawBody = e?.responseBody ?? e?.error?.responseBody ?? "";
  let bodyStr: string;
  if (typeof rawBody === "string") {
    bodyStr = rawBody;
  } else {
    try {
      bodyStr = JSON.stringify(rawBody ?? "");
    } catch {
      // A body with a circular reference is not worth a thrown error here.
      bodyStr = "";
    }
  }
  return { statusCode, bodyStr };
}

/**
 * True when this failure is "the wallet cannot cover the call".
 *
 * Accepts the status OR the body marker; see the module note on why both. The
 * message is never consulted — that is the fragile half we are replacing.
 */
export function isInsufficientCreditError(error: unknown): boolean {
  const { statusCode, bodyStr } = extractCoreErrorParts(error);
  return statusCode === 402 || /insufficient_credit/.test(bodyStr);
}

/**
 * The `required_cents` the proxy sends with a 402, or null.
 *
 * TOLERANT BY DESIGN. A body that is not JSON, or is JSON without the field, or
 * carries it as a string, must degrade to "no figure" rather than throwing inside an
 * error handler. The regex fallback exists because the body may arrive already
 * embedded in a wrapper message rather than as a bare JSON document.
 *
 * Note this is a WORST-CASE RESERVE with markup applied and a floor, not the turn's
 * price — so copy built from it must say "needs at least", never "costs".
 */
export function requiredCentsFromBody(bodyStr: string): number | null {
  // One parser for the 402's fields (billing_copy), so the figure and the
  // account state it is shown with can never be read two ways.
  return parseCreditRefusal(bodyStr).requiredCents;
}

/** The required amount carried by an error, for callers holding the error itself. */
export function requiredCentsFromError(error: unknown): number | null {
  return requiredCentsFromBody(extractCoreErrorParts(error).bodyStr);
}
