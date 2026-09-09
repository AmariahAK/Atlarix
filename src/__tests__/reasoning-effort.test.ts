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
    expect(deriveReasoningCeiling(model("gpt-5", "openai"), "openai")).toBe(
      "high",
    );
  });
  it("budget-token native providers (deepseek/qwen/minimax) → max", () => {
    expect(
      deriveReasoningCeiling(
        model("deepseek-reasoner", "deepseek"),
        "deepseek",
      ),
    ).toBe("max");
    expect(deriveReasoningCeiling(model("qwen3", "qwen"), "qwen")).toBe("max");
  });
  it("OpenRouter reasoning models (budget channel) → max", () => {
    expect(
      deriveReasoningCeiling(
        model("deepseek/deepseek-r1", "openrouter"),
        "openrouter",
      ),
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
      buildReasoningProviderOptions(orCap, true, "high", 64_000)
        .openrouter as any
    ).reasoning.max_tokens;
    const deep = (
      buildReasoningProviderOptions(orCap, true, "max", 64_000)
        .openrouter as any
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
  /**
   * Renamed rather than re-pointed. The old name was "never exceeds 'high'", which
   * recorded a decision that is no longer current: the route asked for "high" at most
   * AND additionally mapped "max" -> "high", so the top two levels of an API that
   * accepts `none/low/medium/high/xhigh/max` were unreachable on models we already pay
   * for. The name is the record of which decision is live, so flipping only the
   * expectation would have left the file lying about it.
   */
  it("effort follows the toggle, reaches the API ceiling, and uses the SDK's key", () => {
    // Deep OFF is deliberately UNCHANGED at medium. Raising the base would raise the
    // bill for every user who never touched the toggle.
    expect(
      (getExtraProviderOptions("openai", settings(false), true) as any)
        .reasoningEffort,
    ).toBe("medium");
    // Deep ON now reaches the ceiling, which is what "Deep" means on every other route.
    expect(
      (getExtraProviderOptions("openai", settings(true), true) as any)
        .reasoningEffort,
    ).toBe("max");
    // Still the camelCase PROVIDER OPTION, never the snake_case body field — see the
    // note above; the snake_case spelling passed a test once while sending nothing.
    expect(
      (getExtraProviderOptions("openai", settings(true), true) as any)
        .reasoning_effort,
    ).toBeUndefined();
  });

  it("gives xhigh its own reasoning budget instead of silently treating it as medium", () => {
    // `xhigh` joined ReasoningEffort for OpenAI, which does not use budget tokens at
    // all — but `reasoningBudgetTokens`' ladder ended in a bare `: 0.33`, so the first
    // budget-channel model handed "xhigh" would have quietly received the MEDIUM
    // budget. Ordering is the assertion, not the fractions.
    const medium = reasoningBudgetTokens("medium", 64_000);
    const high = reasoningBudgetTokens("high", 64_000);
    const xhigh = reasoningBudgetTokens("xhigh", 64_000);
    const max = reasoningBudgetTokens("max", 64_000);
    expect(medium).toBeLessThan(high);
    expect(high).toBeLessThan(xhigh);
    expect(xhigh).toBeLessThan(max);
  });

  it("budget provider (deepseek): scaled thinking budget, deep > base", () => {
    const off = getExtraProviderOptions(
      "deepseek",
      settings(false),
      true,
      64_000,
    ) as any;
    const on = getExtraProviderOptions(
      "deepseek",
      settings(true),
      true,
      64_000,
    ) as any;
    expect(on.thinking.budget_tokens).toBeGreaterThan(
      off.thinking.budget_tokens,
    );
    expect(on.thinking.budget_tokens).toBeLessThan(64_000);
  });
});
