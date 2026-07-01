import { describe, it, expect } from "vitest";
import {
  getReasoningEffort,
  getExtraProviderOptions,
} from "@/ipc/utils/thinking_utils";
import { buildReasoningProviderOptions } from "@/lib/routing/reasoning-detector";
import type { UserSettings } from "@/lib/schemas";

const settings = (deepThinking?: boolean): UserSettings =>
  ({ deepThinking }) as unknown as UserSettings;

describe("getReasoningEffort — flat medium base + one deep-think toggle", () => {
  it("defaults to medium (toggle off / unset)", () => {
    expect(getReasoningEffort(undefined)).toBe("medium");
    expect(getReasoningEffort(settings(false))).toBe("medium");
  });
  it("rises to high when deepThinking is on", () => {
    expect(getReasoningEffort(settings(true))).toBe("high");
  });
  it("has no low/mode/model branching — only the two states", () => {
    // Same input, same output regardless of anything else.
    expect(new Set(["medium", "high"])).toContain(getReasoningEffort(settings(true)));
    expect(new Set(["medium", "high"])).toContain(getReasoningEffort(settings(false)));
  });
});

describe("provider param wiring receives the resolved effort (not hardcoded medium)", () => {
  const cap = {
    useOpenRouterReasoning: true,
    useGoogleThoughts: false,
    useOpenAiReasoningSummary: false,
  };

  it("OpenRouter effort follows the toggle", () => {
    expect((buildReasoningProviderOptions(cap, true, "medium").openrouter as any).reasoning.effort).toBe("medium");
    expect((buildReasoningProviderOptions(cap, true, "high").openrouter as any).reasoning.effort).toBe("high");
  });

  it("OpenAI reasoning_effort follows the toggle", () => {
    expect(
      (getExtraProviderOptions("openai", settings(false), true) as any).reasoning_effort,
    ).toBe("medium");
    expect(
      (getExtraProviderOptions("openai", settings(true), true) as any).reasoning_effort,
    ).toBe("high");
  });

  it("gateway thinking budget: high → -1 dynamic, medium → 4000", () => {
    // deepseek is in PROVIDERS_THAT_SUPPORT_THINKING
    const off = getExtraProviderOptions("deepseek", settings(false), true) as any;
    const on = getExtraProviderOptions("deepseek", settings(true), true) as any;
    expect(off.thinking.budget_tokens).toBe(4_000);
    expect(on.thinking.budget_tokens).toBe(-1);
  });
});
