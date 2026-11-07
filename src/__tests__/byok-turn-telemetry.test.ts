/**
 * Turn telemetry for your own provider (HANDOFF 2026-10-31 item 1e):
 * - a gate is Atlarix's policy, so a BYOK 402 is a failure, never the
 *   `insufficient_credit` gate (which means Atlarix's wallet);
 * - BYOK failures are classed by the same credit / key / rate words the
 *   message uses (texts.ts), so Anthropic's 400 "credit balance is too low" is
 *   `quota`, not `provider_refused`, and OpenAI's 429 insufficient_quota is
 *   `quota`, not `rate_limit`;
 * - `provider_code` says why a refusal happened: the provider's machine code
 *   only, allowlisted and capped, never its message, the prompt or a key.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp", isPackaged: false } }));

const { classifyTurnError, classifyTurnEnd, gateOf, providerCodeOf } = await import("@/lib/analytics/turn-end");
const { ProviderRefusedRequestError } = await import("@/ipc/utils/no_usable_model_output");

const api = (statusCode: number, responseBody = "", message = "provider said something") =>
  Object.assign(new Error(message), { name: "AI_APICallError", statusCode, responseBody });
const live = () => new AbortController().signal;

const ANTHROPIC_CREDIT = JSON.stringify({
  type: "error",
  error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." },
});
const ANTHROPIC_ORPHAN = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "messages.4.content.0: unexpected `tool_use_id` found in `tool_result` blocks: toolu_01. Each `tool_result` block must have a corresponding `tool_use` block in the previous message.",
  },
});
const OPENAI_QUOTA = JSON.stringify({
  error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" },
});

describe("gates are Atlarix's alone", () => {
  it("a 402 from your own provider is a failure, not the insufficient-credit gate", () => {
    const end = classifyTurnEnd(api(402, '{"error":{"message":"Insufficient credits"}}'), live(), { provider: "openrouter" });
    expect(end.outcome).toBe("error");
    expect(end.errorKind).toBe("quota");
    expect(end.gateKind).toBeUndefined();
    expect(gateOf("quota", 402, "", { byok: true })).toBeUndefined();
  });

  it("Atlarix's own 402 stays the gate", () => {
    const err = api(402, '{"error":"insufficient_credit","required_cents":10}');
    expect(classifyTurnEnd(err, live(), { provider: "compass" })).toMatchObject({ outcome: "gate", gateKind: "insufficient_credit" });
    expect(gateOf("quota", 402)).toBe("insufficient_credit");
  });

  it("Atlarix's free-Auto 429 stays the free_usage_limit gate", () => {
    const err = api(429, '{"error":"free_usage_limit","retry_after_seconds":3600}');
    expect(classifyTurnEnd(err, live(), { provider: "compass" })).toMatchObject({ outcome: "gate", gateKind: "free_usage_limit" });
  });
});

describe("your own provider's failures, by the message's words", () => {
  it("Anthropic's 400 'credit balance is too low' is quota, not provider_refused, and no gate", () => {
    const refused = new ProviderRefusedRequestError({ error: api(400, ANTHROPIC_CREDIT, "Your credit balance is too low to access the Anthropic API.") });
    expect(classifyTurnError(refused, { byok: true })).toMatchObject({ kind: "quota", httpStatus: 400 });
    const end = classifyTurnEnd(refused, live(), { provider: "anthropic" });
    expect(end).toMatchObject({ outcome: "error", errorKind: "quota" });
    expect(end.gateKind).toBeUndefined();
  });

  it("OpenAI's 429 insufficient_quota is quota, not rate_limit", () => {
    expect(classifyTurnError(api(429, OPENAI_QUOTA), { byok: true }).kind).toBe("quota");
  });

  it("a rate limit and a rejected key keep their words", () => {
    expect(classifyTurnError(api(429, '{"error":{"message":"Rate limit reached"}}'), { byok: true }).kind).toBe("rate_limit");
    expect(classifyTurnError({ error: { message: "Incorrect API key provided" } }, { byok: true }).kind).toBe("auth");
  });

  it("anything else keeps its class: Anthropic's orphan-tool 400 is provider_refused, with its code", () => {
    const refused = new ProviderRefusedRequestError({ error: api(400, ANTHROPIC_ORPHAN, "messages.4.content.0: unexpected `tool_use_id`") });
    expect(classifyTurnError(refused, { byok: true })).toMatchObject({ kind: "provider_refused", httpStatus: 400 });
    expect(classifyTurnEnd(refused, live(), { provider: "anthropic" })).toMatchObject({
      outcome: "error",
      errorKind: "provider_refused",
      providerCode: "invalid_request_error",
    });
  });

  it("Atlarix's own errors are not read for those words", () => {
    // A Core 400 that happens to say "rate limit" is still a bad request.
    expect(classifyTurnError(api(400, '{"error":"rate limit config"}')).kind).toBe("bad_request");
  });
});

describe("provider_code", () => {
  it("is the provider's machine code or type", () => {
    expect(providerCodeOf(api(429, OPENAI_QUOTA))).toBe("insufficient_quota");
    expect(providerCodeOf(api(400, ANTHROPIC_CREDIT))).toBe("invalid_request_error");
    expect(providerCodeOf({ error: { code: "rate_limit_exceeded", message: "Rate limit reached" } })).toBe("rate_limit_exceeded");
    // Google's enum, as a code.
    expect(providerCodeOf(api(429, '{"error":{"code":429,"message":"quota","status":"RESOURCE_EXHAUSTED"}}'))).toBe("resource_exhausted");
    expect(providerCodeOf(api(400, '{"error":{"code":"model_not_found","message":"x"}}'))).toBe("model_not_found");
  });

  it("is never the message, the prompt or a key", () => {
    // Only the message: no code at all.
    expect(providerCodeOf(api(400, '{"error":{"message":"rate_limit"}}'))).toBeUndefined();
    expect(providerCodeOf(api(400, "SECRET-PROMPT /Users/someone a@example.com"))).toBeUndefined();
    // A code field carrying anything but a code is dropped, not trimmed.
    for (const bad of [
      "Rate limit reached for gpt-4o",
      "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      "AbCdEf123XyZ",
      "3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c",
      "x".repeat(41),
      "a@example.com",
      "../../etc",
    ]) {
      expect(providerCodeOf({ error: { code: bad, message: "m" } })).toBeUndefined();
    }
  });

  it("is capped and allowlisted", () => {
    expect(providerCodeOf({ error: { code: "a".repeat(40) } })).toBe("a".repeat(40));
    expect(providerCodeOf({ error: { type: "upstream.timeout-error_2" } })).toBe("upstream.timeout-error_2");
    const c = providerCodeOf(api(400, OPENAI_QUOTA))!;
    expect(c).toMatch(/^[a-z0-9_.-]{1,40}$/);
  });

  it("Atlarix's own string codes are the gate's business, not a provider code", () => {
    expect(providerCodeOf(api(429, '{"error":"free_usage_limit"}'))).toBeUndefined();
  });
});
