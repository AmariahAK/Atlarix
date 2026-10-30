/**
 * /effort: each model's levels EXACTLY as its catalog row lists them (owner,
 * 2026-10-17: "we dont normalize, can we just show it as they come"), a chosen
 * level sent as listed, the default unchanged from before /effort, and paid
 * Auto's own three levels.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetReasoningRegistryForTests,
  AUTO_EFFORT_CHOICES,
  chosenLevel,
  effortAfterModelChange,
  effortChoicesFor,
  effortSettingsPatch,
  levelShare,
  registerEffortOverrides,
  registerModelsDevReasoning,
  resolveReasoningRequest,
} from "@/lib/routing/model-reasoning-profile";

const row = (providerId: string, modelId: string, options: Array<{ type: string; values?: string[] }>, reasoning = true) => ({
  providerId,
  modelId,
  profile: { reasoning, options },
  supportsTemperature: true,
});

beforeEach(() => {
  __resetReasoningRegistryForTests();
  registerModelsDevReasoning([
    row("openai", "gpt-5.4", [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }]),
    row("deepseek", "deepseek-v4-pro", [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }]),
    row("moonshotai", "kimi-k3", [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }]),
    row("zai", "glm-5.3", [{ type: "effort", values: ["low", "medium", "high", "max"] }]),
    row("anthropic", "claude-opus-4-5", [{ type: "budget_tokens" }]),
    row("minimax", "MiniMax-M3", [{ type: "toggle" }]),
    row("minimax", "MiniMax-M2.7", []),
  ]);
});

describe("the levels /effort offers", () => {
  it("lists a model's values exactly as the catalog has them, in its order", () => {
    expect(effortChoicesFor("openai", "gpt-5.4")).toEqual({
      kind: "effort",
      levels: ["none", "low", "medium", "high", "xhigh"],
      // OpenAI's routes have always run medium when nothing is chosen (QA R2).
      defaultLevel: "medium",
    });
    // The same model elsewhere (a custom OpenAI-compatible provider) runs one below the top.
    expect(effortChoicesFor("custom::x", "gpt-5.4")?.defaultLevel).toBe("high");
    expect(effortChoicesFor("moonshotai", "kimi-k3")?.levels).toEqual(["low", "high", "max"]);
  });

  it("defaults to one below the top, as before /effort, never to a level that turns reasoning off", () => {
    expect(effortChoicesFor("deepseek", "deepseek-v4-pro")?.defaultLevel).toBe("high");
    expect(effortChoicesFor("moonshotai", "kimi-k3")?.defaultLevel).toBe("high");
    registerModelsDevReasoning([row("x", "tiny", [{ type: "effort", values: ["none", "low"] }])]);
    expect(effortChoicesFor("x", "tiny")?.defaultLevel).toBe("low");
  });

  it("makes up names only for models that publish none", () => {
    expect(effortChoicesFor("anthropic", "claude-opus-4-5")).toEqual({ kind: "budget", levels: ["low", "medium", "high"], defaultLevel: "medium" });
    expect(effortChoicesFor("minimax", "MiniMax-M3")).toEqual({ kind: "toggle", levels: ["off", "on"], defaultLevel: "off" });
    expect(effortChoicesFor("minimax", "MiniMax-M2.7")).toBeNull();
    expect(effortChoicesFor("nobody", "unknown-model")).toBeNull();
  });

  it("takes core-models.json's proved list over the catalog (GLM-5.3 rejects medium)", () => {
    registerEffortOverrides({ "glm-5.3": ["low", "high", "max"] });
    expect(effortChoicesFor("zai", "glm-5.3")).toEqual({ kind: "effort", levels: ["low", "high", "max"], defaultLevel: "high" });
    expect(effortChoicesFor(undefined, "zai/glm-5.3")?.levels).toEqual(["low", "high", "max"]);
    // …and it reaches the request even with nothing chosen: no `medium` is ever sent.
    expect(resolveReasoningRequest({ providerId: "zai", modelId: "glm-5.3", deepThinking: false })).toEqual({ kind: "effort", effort: "high" });
  });
});

describe("the bare model id (a custom gateway serving a known model)", () => {
  it("takes what most catalog rows say, not an aggregator's row listed first (QA N1)", () => {
    __resetReasoningRegistryForTests();
    const gpt = [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }];
    registerModelsDevReasoning([row("abacus", "gpt-5.4", []), row("openai", "gpt-5.4", gpt), row("azure", "gpt-5.4", gpt)]);
    expect(effortChoicesFor("custom::gw", "gpt-5.4")?.levels).toEqual(["none", "low", "medium", "high", "xhigh"]);
    // A vendor-scoped row is its own answer either way.
    expect(effortChoicesFor("abacus", "gpt-5.4")).toBeNull();
  });

  it("never a gateway's padded list, and 'no control' counts as an answer (QA N6)", () => {
    __resetReasoningRegistryForTests();
    const padded = [{ type: "effort", values: ["none", "low", "medium", "high", "max"] }];
    registerModelsDevReasoning([
      row("minimax", "MiniMax-M3", [{ type: "toggle" }]),
      row("minimax-coding-plan", "MiniMax-M3", [{ type: "toggle" }]),
      row("requesty", "MiniMax-M3", padded),
      row("minimax", "MiniMax-M2.7", []),
      row("other", "MiniMax-M2.7", []),
      row("requesty", "MiniMax-M2.7", padded),
    ]);
    expect(effortChoicesFor("custom::gw", "MiniMax-M3")?.levels).toEqual(["off", "on"]);
    expect(effortChoicesFor("custom::gw", "MiniMax-M2.7")).toBeNull();
  });

  it("a tie goes to the shorter list", () => {
    __resetReasoningRegistryForTests();
    registerModelsDevReasoning([
      row("a", "kimi-k3", [{ type: "effort", values: ["none", "minimal", "low", "medium", "high", "max"] }]),
      row("b", "kimi-k3", [{ type: "effort", values: ["low", "high", "max"] }]),
    ]);
    expect(effortChoicesFor("custom::gw", "kimi-k3")?.levels).toEqual(["low", "high", "max"]);
  });
});

describe("what a chosen level sends", () => {
  it("sends the chosen value exactly as listed: xhigh stays xhigh", () => {
    expect(resolveReasoningRequest({ providerId: "openai", modelId: "gpt-5.4", deepThinking: false, effort: "xhigh" })).toEqual({ kind: "effort", effort: "xhigh" });
    expect(resolveReasoningRequest({ providerId: "openai", modelId: "gpt-5.4", deepThinking: false, effort: "none" })).toEqual({ kind: "effort", effort: "none" });
  });

  it("ignores a level this model doesn't list, never translating it", () => {
    // kimi has no medium: the request is what it was before /effort.
    expect(resolveReasoningRequest({ providerId: "moonshotai", modelId: "kimi-k3", deepThinking: false, effort: "medium" })).toEqual({ kind: "effort", effort: "high" });
  });

  it("maps off / on and budget sizes onto the model's own control", () => {
    expect(resolveReasoningRequest({ providerId: "minimax", modelId: "MiniMax-M3", deepThinking: false, effort: "on" })).toEqual({ kind: "toggle", enabled: true });
    expect(resolveReasoningRequest({ providerId: "anthropic", modelId: "claude-opus-4-5", deepThinking: false, effort: "low" })).toEqual({ kind: "budget", effortHint: "low" });
    expect(resolveReasoningRequest({ providerId: "anthropic", modelId: "claude-opus-4-5", deepThinking: false, effort: "high" })).toEqual({ kind: "budget", effortHint: "max" });
  });

  it("a budget model's medium asks for what an unset level does, and low for less (QA, 15.8.0)", async () => {
    // /effort low sent the default's budget, and medium sent more than the
    // default: low was mapped to medium and medium to high.
    const { reasoningBudgetTokens } = await import("@/ipc/utils/thinking_utils");
    const choices = effortChoicesFor("anthropic", "claude-opus-4-5")!;
    const share = (l: string) => reasoningBudgetTokens(levelShare(choices, l), 32_000);
    const unset = reasoningBudgetTokens("medium", 32_000);
    expect(share("medium")).toBe(unset);
    expect(share("low")).toBeLessThan(unset);
    expect(share("low")).toBeGreaterThanOrEqual(1024);
    expect(share("high")).toBeGreaterThan(unset);
  });

  it("gives budget routes a share by the level's place in the list, top asking for the most", () => {
    const gpt = effortChoicesFor("openai", "gpt-5.4")!;
    expect(levelShare(gpt, "xhigh")).toBe("max");
    expect(levelShare(gpt, "low")).toBe("medium");
    expect(levelShare(effortChoicesFor("deepseek", "deepseek-v4-pro")!, "max")).toBe("max");
  });

  it("the old deep-thinking switch sends the model's own top, as listed (QA R5)", () => {
    expect(resolveReasoningRequest({ providerId: "custom::x", modelId: "gpt-5.4", deepThinking: true })).toEqual({ kind: "effort", effort: "xhigh" });
  });

  it("runs the top for the old deep-thinking switch when nothing was chosen", () => {
    const kimi = effortChoicesFor("moonshotai", "kimi-k3")!;
    expect(chosenLevel(kimi, undefined, true)).toBe("max");
    expect(chosenLevel(kimi, undefined, false)).toBe("high");
    expect(chosenLevel(kimi, "LOW")).toBe("low");
  });
});

describe("levels that turn reasoning off", () => {
  it("none / minimal as listed, and off on an off / on model; nothing else", async () => {
    const { isReasoningOff } = await import("@/lib/routing/model-reasoning-profile");
    const gpt = effortChoicesFor("openai", "gpt-5.4")!;
    expect(isReasoningOff(gpt, "none")).toBe(true);
    expect(isReasoningOff(gpt, "low")).toBe(false);
    expect(isReasoningOff(effortChoicesFor("minimax", "MiniMax-M3")!, "off")).toBe(true);
    expect(isReasoningOff(effortChoicesFor("anthropic", "claude-opus-4-5")!, "low")).toBe(false);
  });
});

describe("paid Auto's three levels", () => {
  it("are low / medium / max, medium by default", () => {
    expect(AUTO_EFFORT_CHOICES.levels).toEqual(["low", "medium", "max"]);
    expect(AUTO_EFFORT_CHOICES.defaultLevel).toBe("medium");
  });
});

describe("what a choice writes, and a model change", () => {
  it("keeps the old switch in step with 'the top is chosen', and stores the default as unset", () => {
    const kimi = effortChoicesFor("moonshotai", "kimi-k3")!;
    expect(effortSettingsPatch(kimi, "max")).toEqual({ effort: "max", deepThinking: true });
    expect(effortSettingsPatch(kimi, "low")).toEqual({ effort: "low", deepThinking: false });
    expect(effortSettingsPatch(kimi, "high")).toEqual({ effort: "", deepThinking: false });
  });

  it("an unset level stays unset across model changes, never turning into an explicit one (QA R1)", () => {
    let st = { effort: "", deepThinking: false };
    for (const [p, m] of [["openai", "gpt-5.4"], ["moonshotai", "kimi-k3"], ["zai", "glm-5.3"], ["anthropic", "claude-opus-4-5"]] as const) {
      st = effortAfterModelChange(effortChoicesFor(p, m), st);
      expect(st).toEqual({ effort: "", deepThinking: false });
    }
  });

  it("the old deep-thinking switch carries over as the new model's top", () => {
    expect(effortAfterModelChange(effortChoicesFor("moonshotai", "kimi-k3"), { deepThinking: true })).toEqual({ effort: "max", deepThinking: true });
  });

  it("keeps a level the new model lists, and resets one it doesn't to that model's default", () => {
    const deepseek = effortChoicesFor("deepseek", "deepseek-v4-pro")!;
    expect(effortAfterModelChange(deepseek, { effort: "max", deepThinking: false })).toEqual({ effort: "max", deepThinking: true });
    expect(effortAfterModelChange(deepseek, { effort: "xhigh", deepThinking: false })).toEqual({ effort: "", deepThinking: false });
    expect(effortAfterModelChange(null, { effort: "low" })).toEqual({ effort: "", deepThinking: false });
  });
});

describe("the request body", () => {
  it("sends the chosen level as-is to OpenAI and to an OpenAI-compatible route, and the old value when nothing was chosen", async () => {
    const { getExtraProviderOptions } = await import("@/ipc/utils/thinking_utils");
    const s = (extra: object) => ({ ...extra }) as never;
    expect(getExtraProviderOptions("openai", s({ effort: "xhigh" }), true, 32000, "gpt-5.4")).toEqual({ reasoningEffort: "xhigh" });
    expect(getExtraProviderOptions("openai", s({}), true, 32000, "gpt-5.4")).toEqual({ reasoningEffort: "medium" });
    expect(getExtraProviderOptions("moonshotai", s({ effort: "low" }), true, 32000, "kimi-k3")).toEqual({ reasoningEffort: "low" });
    expect(getExtraProviderOptions("moonshotai", s({}), true, 32000, "kimi-k3")).toEqual({ reasoningEffort: "high" });
  });

  it("gives a budget-only model a bigger budget for a bigger size", async () => {
    const { getExtraProviderOptions } = await import("@/ipc/utils/thinking_utils");
    const budget = (effort: string) =>
      (getExtraProviderOptions("anthropic", { effort } as never, true, 32000, "claude-opus-4-5") as { thinking: { budget_tokens: number } }).thinking.budget_tokens;
    expect(budget("low")).toBeLessThan(budget("medium"));
    expect(budget("medium")).toBeLessThan(budget("high"));
  });

  it("tells Gemini the chosen level in its own terms (QA #7)", async () => {
    const { buildReasoningProviderOptions } = await import("@/lib/routing/reasoning-detector");
    const cap = { useGoogleThoughts: true } as never;
    const cfg = (p: ReturnType<typeof buildReasoningProviderOptions>) => (p.google as { thinkingConfig: Record<string, unknown> }).thinkingConfig;
    expect(cfg(buildReasoningProviderOptions(cap, true, "high", 32000, "low"))).toEqual({ includeThoughts: true, thinkingLevel: "low" });
    expect(cfg(buildReasoningProviderOptions(cap, true, "high", 32000, "minimal"))).toEqual({ includeThoughts: true, thinkingLevel: "minimal" });
    expect(cfg(buildReasoningProviderOptions(cap, true, "max", 32000, undefined, { budget: true })).thinkingBudget).toBeGreaterThan(
      cfg(buildReasoningProviderOptions(cap, true, "medium", 32000, undefined, { budget: true })).thinkingBudget as number,
    );
    expect(cfg(buildReasoningProviderOptions(cap, true, "medium", 32000, undefined, { off: true }))).toEqual({ includeThoughts: false, thinkingBudget: 0 });
    // Nothing chosen: unchanged.
    expect(cfg(buildReasoningProviderOptions(cap, true, "high", 32000))).toEqual({ includeThoughts: true });
  });

  it("names the chosen level on the native OpenAI route", async () => {
    const { buildReasoningProviderOptions } = await import("@/lib/routing/reasoning-detector");
    const cap = { useOpenAiReasoningSummary: true } as never;
    expect(buildReasoningProviderOptions(cap, true, "max", 32000, "xhigh").openai).toMatchObject({ reasoningEffort: "xhigh" });
    expect(buildReasoningProviderOptions(cap, true, "medium", 32000).openai).toMatchObject({ reasoningEffort: "medium" });
  });
});
