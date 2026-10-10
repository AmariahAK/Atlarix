import { NoContentGeneratedError, NoOutputGeneratedError } from "ai";

/** User-visible copy when the model returns nothing after one silent retry. */
export const MODEL_EMPTY_RESPONSE_USER_MESSAGE =
  "Something went wrong — please try again.";

/**
 * Thrown when the model returned no usable output after the silent retry path
 * exhausted. The IPC caller should send `chat:response:error` (e.g. with
 * `MODEL_EMPTY_RESPONSE_USER_MESSAGE`) and `chat:response:end` so the UI
 * leaves the loading state.
 */
export class EmptyModelOutputAfterRetryError extends Error {
  constructor() {
    super("EmptyModelOutputAfterRetry");
    this.name = "EmptyModelOutputAfterRetryError";
  }
}

/**
 * The provider refused the request (a revoked key, no access to the model) and
 * the user was already told why. The turn ends without a second, vaguer error.
 */
export class ProviderRefusedRequestError extends Error {
  constructor(readonly refusal: unknown) {
    super("ProviderRefusedRequest");
    this.name = "ProviderRefusedRequestError";
  }
}

function unwrapNestedError(err: unknown): unknown[] {
  if (err == null || typeof err !== "object") return [err];
  const o = err as Record<string, unknown>;
  const out: unknown[] = [err];
  if ("error" in o && o.error != null) out.push(o.error);
  if ("cause" in o && o.cause != null) out.push(o.cause);
  return out;
}

/** True for AI SDK empty / no-content stream outcomes, including name-only throws at flush. */
export function isNoUsableModelOutputError(err: unknown): boolean {
  for (const candidate of unwrapNestedError(err)) {
    if (
      NoOutputGeneratedError.isInstance(candidate) ||
      NoContentGeneratedError.isInstance(candidate)
    ) {
      return true;
    }
    if (candidate == null || typeof candidate !== "object") continue;
    const e = candidate as Error;
    const name = typeof e.name === "string" ? e.name : "";
    const ctor = (candidate as object).constructor?.name ?? "";
    if (
      name === "AI_NoOutputGeneratedError" ||
      name === "NoOutputGeneratedError" ||
      ctor === "NoOutputGeneratedError" ||
      name === "AI_NoContentGeneratedError" ||
      name === "NoContentGeneratedError" ||
      ctor === "NoContentGeneratedError"
    ) {
      return true;
    }
  }
  return false;
}

// ai@6: streamText getters are PromiseLike, not Promise.
type StreamTextAuxPromises = {
  usage: PromiseLike<unknown>;
  finishReason: PromiseLike<unknown>;
  response: PromiseLike<unknown>;
};

/**
 * Attach `.catch` only on promises that often reject at flush when the model
 * returns no tokens, without touching other getters on the stream result.
 */
export function attachEmptyOutputSafeRejectHandlers(
  streamResult: StreamTextAuxPromises,
  logWarn: (message: string, ...optionalParams: unknown[]) => void,
  scope: string,
): void {
  const attach = (prop: keyof StreamTextAuxPromises) => {
    void Promise.resolve(streamResult[prop]).catch((rej: unknown) => {
      if (isNoUsableModelOutputError(rej)) {
        logWarn(
          `[${scope}] streamText().${String(prop)} rejected (empty/no usable output)`,
        );
        return;
      }
      logWarn(`[${scope}] streamText().${String(prop)} rejected:`, rej);
    });
  };
  attach("usage");
  attach("finishReason");
  attach("response");
}
