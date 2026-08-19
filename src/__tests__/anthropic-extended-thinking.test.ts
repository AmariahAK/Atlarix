/**
 * Direct (BYOK) Anthropic never actually requested extended thinking.
 *
 * `detectReasoningCapability` had branches for openrouter/compass, google/vertex
 * and openai — and none for anthropic. So `buildReasoningProviderOptions`
 * returned `{}` for a Claude model on a user's own key, and the only place a
 * `thinking` block was ever written was `providerOptions["dyad-gateway"]`: an
 * identifier no provider in this app declares, so it reached nothing. The shape
 * was the tell — that path emitted snake_case `budget_tokens` / `include_thoughts`
 * (a gateway wire format) where `@ai-sdk/anthropic` reads camelCase `budgetTokens`.
 *
 * Two things are asserted here because each fails in a different, quiet way:
 *   - the BUDGET must satisfy Anthropic's constraints (>= 1024, and strictly below
 *     max_tokens), or the request 400s
 *   - TEMPERATURE must be omitted whenever thinking is on, because
 *     `getTemperature` defaults to 0 and Anthropic only accepts 1 with thinking
 *     enabled. That coupling spans two unrelated call sites and would regress
 *     with nothing failing locally.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetReasoningRegistryForTests,
  registerModelsDevReasoning,
} from "@/lib/routing/model-reasoning-profile";
import {
  buildReasoningProviderOptions,
  detectReasoningCapability,
  shouldOmitTemperature,
} from "@/lib/routing/reasoning-detector";

/** Shaped like the real models.dev rows: Claude reasons via a token budget. */
const CATALOG = [
  {
    providerId: "anthropic",
    modelId: "claude-opus-4-5",
    profile: { reasoning: true, options: [{ type: "budget_tokens" }] },
    supportsTemperature: true,
  },
  {
    providerId: "anthropic",
    modelId: "claude-haiku-3-5",
    // Declares no reasoning at all.
    profile: { reasoning: false, options: [] },
    supportsTemperature: true,
  },
];

beforeEach(() => {
  __resetReasoningRegistryForTests();
  registerModelsDevReasoning(CATALOG as never);
});

const cap = (modelId: string) => detectReasoningCapability(modelId, "anthropic");

describe("detectReasoningCapability — anthropic", () => {
  it("enables thinking for a model the catalog says reasons", () => {
    expect(cap("claude-opus-4-5").useAnthropicThinking).toBe(true);
  });

  it("does NOT enable it for a model that declares no reasoning", () => {
    expect(cap("claude-haiku-3-5").useAnthropicThinking).toBe(false);
  });

  it("does NOT enable it on a catalog miss — a 400 is worse than no thinking", () => {
    // A model newer than the last models.dev refresh. `anthropic` is not in
    // PROVIDERS_THAT_SUPPORT_THINKING, so there is no legacy fallback to guess with.
    expect(cap("claude-something-unreleased").useAnthropicThinking).toBe(false);
  });

  it("does not fire for another provider's model", () => {
    expect(
      detectReasoningCapability("claude-opus-4-5", "openrouter").useAnthropicThinking,
    ).toBe(false);
  });
});

describe("buildReasoningProviderOptions — anthropic bucket", () => {
  it("emits the SDK shape: anthropic.thinking.budgetTokens (camelCase)", () => {
    const patch = buildReasoningProviderOptions(cap("claude-opus-4-5"), true, "high", 64_000);
    expect(patch.anthropic?.thinking).toMatchObject({ type: "enabled" });
    const thinking = patch.anthropic?.thinking as { budgetTokens?: number };
    expect(typeof thinking.budgetTokens).toBe("number");
    // The old gateway shape, which reached nothing, must not come back.
    expect(JSON.stringify(patch.anthropic)).not.toContain("budget_tokens");
    expect(JSON.stringify(patch.anthropic)).not.toContain("include_thoughts");
  });

  it("keeps the budget within Anthropic's limits: >= 1024 and below max_tokens", () => {
    for (const max of [8_000, 32_000, 64_000]) {
      const patch = buildReasoningProviderOptions(cap("claude-opus-4-5"), true, "max", max);
      const budget = (patch.anthropic?.thinking as { budgetTokens: number }).budgetTokens;
      expect(budget).toBeGreaterThanOrEqual(1024);
      expect(budget).toBeLessThan(max);
    }
  });

  it("scales with effort, so deep thinking is actually deeper", () => {
    const at = (effort: "high" | "max") =>
      (
        buildReasoningProviderOptions(cap("claude-opus-4-5"), true, effort, 64_000)
          .anthropic?.thinking as { budgetTokens: number }
      ).budgetTokens;
    expect(at("high")).toBeLessThan(at("max"));
  });

  it("emits nothing when the thinking tier is off", () => {
    const patch = buildReasoningProviderOptions(cap("claude-opus-4-5"), false, "high", 64_000);
    expect(patch.anthropic).toBeUndefined();
  });

  it("emits nothing for a non-reasoning model", () => {
    const patch = buildReasoningProviderOptions(cap("claude-haiku-3-5"), true, "high", 64_000);
    expect(patch.anthropic).toBeUndefined();
  });
});

describe("shouldOmitTemperature", () => {
  it("omits temperature when anthropic thinking is enabled", () => {
    const patch = buildReasoningProviderOptions(cap("claude-opus-4-5"), true, "high", 64_000);
    expect(shouldOmitTemperature({ anthropic: patch.anthropic })).toBe(true);
  });

  it("keeps temperature for anthropic WITHOUT thinking (e.g. cache markers only)", () => {
    expect(
      shouldOmitTemperature({ anthropic: { cacheControl: { type: "ephemeral" } } }),
    ).toBe(false);
  });

  it("keeps temperature for every other provider", () => {
    expect(shouldOmitTemperature({ openrouter: { reasoning: { enabled: true } } })).toBe(false);
    expect(shouldOmitTemperature({ google: { thinkingConfig: {} } })).toBe(false);
    expect(shouldOmitTemperature({})).toBe(false);
    expect(shouldOmitTemperature(undefined)).toBe(false);
  });
});
