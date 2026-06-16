import { afterEach, describe, expect, it, vi } from "vitest";
import type { LargeLanguageModel } from "@/lib/schemas";

vi.mock("@/ipc/utils/findLanguageModel", () => ({
  findLanguageModel: vi.fn(),
}));

import {
  heuristicRawContextLength,
  resolveModelContextLimit,
} from "@/lib/context/resolve-model-context-limit";
import {
  warmOpenRouterModelCache,
  getCachedOpenRouterModelRow,
} from "@/lib/routing/tier-context-limits";
import { findLanguageModel } from "@/ipc/utils/findLanguageModel";

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

describe("resolveModelContextLimit — BYOK uses fetched API window", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(findLanguageModel).mockReset();
  });

  it("uses the provider-API context window (not the heuristic) when available", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    vi.mocked(findLanguageModel).mockResolvedValue({
      apiName: "claude-x",
      contextWindow: 268_000,
    } as never);
    const res = await resolveModelContextLimit(
      model("anthropic", "claude-x"),
      {} as never,
    );
    expect(res.rawContextLength).toBe(268_000);
    expect(res.tierLimit).toBe(Math.max(4096, Math.floor(268_000 * 0.8)));
  });

  it("falls back to the heuristic when the API has no window", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    vi.mocked(findLanguageModel).mockResolvedValue(undefined as never);
    const res = await resolveModelContextLimit(
      model("anthropic", "some-unlisted-model"),
      {} as never,
    );
    // heuristic floor for an unlisted frontier model
    expect(res.rawContextLength).toBe(128_000);
  });
});

describe("warmOpenRouterModelCache — fetch-failure tolerance", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never throws and caches no rows when the fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );
    await expect(warmOpenRouterModelCache()).resolves.toBeUndefined();
    // No catalog row → resolveModelContextLimit falls back to heuristics.
    expect(getCachedOpenRouterModelRow("anthropic/claude-3.5-sonnet")).toBeUndefined();
  });
});
