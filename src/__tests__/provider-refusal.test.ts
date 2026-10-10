/**
 * A request the provider refuses outright (a revoked key, no access to the
 * model) is not retried: the user is told why once, by onError. Retrying it ran
 * the same refused request twice more and then replaced the reason with
 * "Something went wrong" (seen live: a revoked OpenAI key).
 */
import { describe, expect, it } from "vitest";
import { isProviderRefusal } from "@/ipc/handlers/chat_stream/turn-runner/simple-stream-text";
import { ProviderRefusedRequestError } from "@/ipc/utils/no_usable_model_output";

describe("isProviderRefusal", () => {
  it("is a refusal for a 4xx the same request gets again", () => {
    for (const statusCode of [400, 401, 403, 404, 422]) expect(isProviderRefusal({ statusCode })).toBe(true);
    // The SDK's stream error part wraps the APICallError.
    expect(isProviderRefusal({ error: { statusCode: 401 } })).toBe(true);
  });

  it("is not a refusal when a retry can pass, or when there is no status", () => {
    for (const statusCode of [408, 409, 429, 500, 503]) expect(isProviderRefusal({ statusCode })).toBe(false);
    expect(isProviderRefusal(new TypeError("fetch failed"))).toBe(false);
    expect(isProviderRefusal(null)).toBe(false);
  });

  it("the turn ends with its own error, carrying the refusal", () => {
    const refusal = { statusCode: 401 };
    const e = new ProviderRefusedRequestError(refusal);
    expect(e.name).toBe("ProviderRefusedRequestError");
    expect(e.refusal).toBe(refusal);
  });
});
