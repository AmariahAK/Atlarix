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

  it("Atlarix Core's gates are refusals whatever their status, so the empty-output retry never repeats them (live QA 2026-10-30)", () => {
    for (const [statusCode, code] of [[429, "free_usage_limit"], [503, "free_busy"], [429, "core_rate_limited"]] as const) {
      const body = JSON.stringify({ error: code, retry_after_seconds: 40 });
      expect(isProviderRefusal({ statusCode, responseBody: body })).toBe(true);
      expect(isProviderRefusal({ error: { statusCode, responseBody: body } })).toBe(true);
    }
    // Any other 429/503 is still worth a retry.
    expect(isProviderRefusal({ statusCode: 429, responseBody: '{"error":"rate_limit_exceeded"}' })).toBe(false);
    expect(isProviderRefusal({ statusCode: 503, responseBody: '{"error":"core_unavailable"}' })).toBe(false);
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
