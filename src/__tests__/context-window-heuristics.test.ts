import { afterEach, describe, expect, it, vi } from "vitest";
import type { LargeLanguageModel } from "@/lib/schemas";
import { heuristicRawContextLength } from "@/lib/context/resolve-model-context-limit";
import { getTierContextLimits } from "@/lib/routing/tier-context-limits";

const model = (provider: string, name: string): LargeLanguageModel =>
  ({ provider, name }) as LargeLanguageModel;

describe("heuristicRawContextLength — modern windows", () => {
  it("uses modern windows for the OpenRouter models we run", () => {
    expect(heuristicRawContextLength(model("openrouter", "deepseek/deepseek-chat"))).toBe(
      128000,
    );
    expect(heuristicRawContextLength(model("openrouter", "minimax/minimax-01"))).toBe(
      1000000,
    );
    expect(heuristicRawContextLength(model("openrouter", "qwen/qwen-2.5-72b"))).toBe(
      131072,
    );
    expect(heuristicRawContextLength(model("openrouter", "meta-llama/llama-3.1-70b"))).toBe(
      131072,
    );
  });

  it("falls back to a modern 128K floor for unlisted models", () => {
    expect(heuristicRawContextLength(model("openrouter", "some/brand-new-model"))).toBe(
      128000,
    );
  });

  it("keeps genuinely small/legacy windows truthful", () => {
    expect(heuristicRawContextLength(model("ollama", "llama3"))).toBe(8192);
    expect(heuristicRawContextLength(model("openrouter", "openai/gpt-3.5-turbo"))).toBe(
      16384,
    );
  });
});

describe("getTierContextLimits — fetch-failure fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the unified 200K fallback for all tiers when the fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );
    // Unique ids avoid the module-level 24h cache from a prior test/run.
    const limits = await getTierContextLimits(
      "fail/fast-x",
      "fail/balanced-x",
      "fail/thinking-x",
    );
    expect(limits).toEqual({
      fast: 200_000,
      balanced: 200_000,
      thinking: 200_000,
    });
  });
});
