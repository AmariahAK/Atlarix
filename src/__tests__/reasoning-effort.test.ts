import { describe, it, expect } from "vitest";
import {
  getReasoningEffort,
  getExtraProviderOptions,
  reasoningBudgetTokens,
} from "@/ipc/utils/thinking_utils";
import {
  buildReasoningProviderOptions,
  deriveReasoningCeiling,
} from "@/lib/routing/reasoning-detector";
import type { LargeLanguageModel, UserSettings } from "@/lib/schemas";

const settings = (deepThinking?: boolean): UserSettings =>
  ({ deepThinking }) as unknown as UserSettings;

describe("getReasoningEffort — capability-derived base/deep pair", () => {
  it("effort-ceiling models (e.g. OpenAI): base=medium, deep=high", () => {
    expect(getReasoningEffort(undefined, "high")).toBe("medium");
    expect(getReasoningEffort(settings(false), "high")).toBe("medium");
    expect(getReasoningEffort(settings(true), "high")).toBe("high");
  });
  it("budget-ceiling models (e.g. DeepSeek/Anthropic): base=high, deep=max", () => {
    expect(getReasoningEffort(settings(false), "max")).toBe("high");
    expect(getReasoningEffort(settings(true), "max")).toBe("max");
  });
});

describe("deriveReasoningCeiling — catalog/channel-derived, not per-model hardcode", () => {
  const model = (name: string, provider: string): LargeLanguageModel =>
    ({ name, provider }) as unknown as LargeLanguageModel;

  it("effort-only channel (OpenAI) → high", () => {
    expect(deriveReasoningCeiling(model("gpt-5", "openai"), "openai")).toBe("high");
  });
  it("budget-token native providers (deepseek/qwen/minimax) → max", () => {
    expect(deriveReasoningCeiling(model("deepseek-reasoner", "deepseek"), "deepseek")).toBe("max");
    expect(deriveReasoningCeiling(model("qwen3", "qwen"), "qwen")).toBe("max");
  });
  it("OpenRouter reasoning models (budget channel) → max", () => {
    expect(
      deriveReasoningCeiling(model("deepseek/deepseek-r1", "openrouter"), "openrouter"),
    ).toBe("max");
  });
});

describe("reasoningBudgetTokens — scaled to the model's max, reserving output", () => {
  it("scales high < max and both leave an output reserve", () => {
    const max = 64_000;
    const high = reasoningBudgetTokens("high", max);
    const mx = reasoningBudgetTokens("max", max);
    expect(high).toBeLessThan(mx);
    // reserve = max(15% , 2048) → both must leave headroom under `max`.
    expect(mx).toBeLessThanOrEqual(max - Math.round(max * 0.15));
    expect(high).toBeGreaterThanOrEqual(1024);
  });
  it("never truncates on a tiny max (clamped, still leaves the reserve)", () => {
    const max = 8_192;
    const mx = reasoningBudgetTokens("max", max);
    expect(mx).toBeGreaterThanOrEqual(1024);
    expect(mx).toBeLessThan(max); // output room preserved
  });
});

describe("provider param wiring receives the resolved effort + scaled budget", () => {
  const orCap = {
    useOpenRouterReasoning: true,
    useGoogleThoughts: false,
    useOpenAiReasoningSummary: false,
    useAnthropicThinking: false,
  };

  it("OpenRouter emits a scaled reasoning.max_tokens (base < deep)", () => {
    const base = (
      buildReasoningProviderOptions(orCap, true, "high", 64_000).openrouter as any
    ).reasoning.max_tokens;
    const deep = (
      buildReasoningProviderOptions(orCap, true, "max", 64_000).openrouter as any
    ).reasoning.max_tokens;
    expect(base).toBeLessThan(deep);
    expect(deep).toBeLessThan(64_000); // output reserve preserved
  });

  // camelCase `reasoningEffort` is the PROVIDER OPTION, which the SDK maps to the
  // body's `reasoning_effort`. Asserting the snake_case spelling here passed while the
  // value never reached a request: @ai-sdk/openai-compatible spreads the provider
  // bucket into the body and then writes `reasoning_effort:
  // compatibleOptions.reasoningEffort ?? undefined` over the top, so a snake_case key
  // is overwritten with undefined and dropped by JSON.stringify.
  it("effort follows the toggle, never exceeds 'high', and uses the SDK's key", () => {
    expect(
      (getExtraProviderOptions("openai", settings(false), true) as any).reasoningEffort,
    ).toBe("medium");
    expect(
      (getExtraProviderOptions("openai", settings(true), true) as any).reasoningEffort,
    ).toBe("high");
    expect(
      (getExtraProviderOptions("openai", settings(true), true) as any).reasoning_effort,
    ).toBeUndefined();
  });

  it("budget provider (deepseek): scaled thinking budget, deep > base", () => {
    const off = getExtraProviderOptions("deepseek", settings(false), true, 64_000) as any;
    const on = getExtraProviderOptions("deepseek", settings(true), true, 64_000) as any;
    expect(on.thinking.budget_tokens).toBeGreaterThan(off.thinking.budget_tokens);
    expect(on.thinking.budget_tokens).toBeLessThan(64_000);
  });
});
