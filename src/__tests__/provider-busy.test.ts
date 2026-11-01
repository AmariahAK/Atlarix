/**
 * A provider that is rate-limited or overloaded says so INSIDE the stream (no HTTP
 * status): the proxy passes OpenAI's response.failed through as { error: { code,
 * message } }. That must be waited out and retried, not ended as "Something went
 * wrong" after one second (2026-10-31, six sessions on one OpenAI account).
 */
import { describe, expect, it } from "vitest";
import { isProviderBusyError, PROVIDER_BUSY_DELAYS_MS } from "@/ipc/handlers/chat_stream/network-retry";

describe("isProviderBusyError", () => {
  it("is busy for an in-stream rate limit or overload, as the SDK hands it to onError", () => {
    expect(isProviderBusyError({ error: { code: "rate_limit_exceeded", message: "Rate limit reached for tokens per min" } })).toBe(true);
    expect(isProviderBusyError({ error: { message: "The server is overloaded" } })).toBe(true);
    expect(isProviderBusyError({ error: { code: "server_error", message: "x" } })).toBe(true);
  });
  it("is not busy for a real refusal, an HTTP error (they keep their own paths) or nothing", () => {
    expect(isProviderBusyError({ error: { code: "invalid_api_key", message: "Incorrect API key" } })).toBe(false);
    expect(isProviderBusyError({ statusCode: 429, error: { message: "rate limit" } })).toBe(false);
    expect(isProviderBusyError({ error: { statusCode: 429, message: "rate limit" } })).toBe(false);
    expect(isProviderBusyError(null)).toBe(false);
  });
  it("waits long enough for a per-minute limit to pass", () => {
    expect(PROVIDER_BUSY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60_000);
  });
});
