/**
 * v12 7D — BYOK per-turn cost estimation.
 */

import { describe, expect, it } from "vitest";
import {
  estimateTurnCostUsd,
  inputOutputTokensFromUsage,
} from "@/lib/routing/byok-pricing";

describe("inputOutputTokensFromUsage", () => {
  it("reads the AI-SDK v5 shape", () => {
    expect(
      inputOutputTokensFromUsage({ inputTokens: 100, outputTokens: 50 }),
    ).toEqual({ inputTokens: 100, outputTokens: 50 });
  });
  it("reads the legacy prompt/completion shape", () => {
    expect(
      inputOutputTokensFromUsage({ promptTokens: 100, completionTokens: 50 }),
    ).toEqual({ inputTokens: 100, outputTokens: 50 });
  });
  it("null on incomplete/absent usage", () => {
    expect(inputOutputTokensFromUsage({ inputTokens: 100 })).toBeNull();
    expect(inputOutputTokensFromUsage(null)).toBeNull();
  });
});

describe("estimateTurnCostUsd", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };

  it("prices a known Claude model from the static table", () => {
    // Opus: $5 in + $25 out per 1M → $30 for 1M+1M.
    expect(estimateTurnCostUsd({ name: "claude-opus-4-8" }, usage)).toBeCloseTo(
      30,
      5,
    );
    // Sonnet: $3 + $15 = $18.
    expect(
      estimateTurnCostUsd({ name: "claude-sonnet-4-6" }, usage),
    ).toBeCloseTo(18, 5);
    // Haiku: $1 + $5 = $6.
    expect(
      estimateTurnCostUsd({ name: "claude-haiku-4-5" }, usage),
    ).toBeCloseTo(6, 5);
  });

  it("scales sub-million usage correctly", () => {
    // 10k in + 2k out on Opus → 10k*5/1M + 2k*25/1M = 0.05 + 0.05 = 0.10.
    expect(
      estimateTurnCostUsd(
        { name: "claude-opus-4-8" },
        { inputTokens: 10_000, outputTokens: 2_000 },
      ),
    ).toBeCloseTo(0.1, 6);
  });

  it("returns null for Compass/Core (metered separately)", () => {
    expect(
      estimateTurnCostUsd(
        { name: "claude-opus-4-8", builtinProviderId: "compass" },
        usage,
      ),
    ).toBeNull();
  });

  it("returns null for an unknown model — never guesses", () => {
    expect(
      estimateTurnCostUsd({ name: "totally-unknown-local-model" }, usage),
    ).toBeNull();
  });

  it("returns null without usage", () => {
    expect(estimateTurnCostUsd({ name: "claude-opus-4-8" }, null)).toBeNull();
  });
});

describe("estimateTurnCostUsd — cache-aware (v13.2, ai@6 semantics)", () => {
  // ai@6: flat inputTokens is the cache-INCLUSIVE total for EVERY provider
  // (Anthropic's total = input + cacheCreation + cacheRead). One formula:
  // fullRate = input − cacheRead − cacheWrite.
  it("anthropic: reads 0.1x, writes 1.25x, remainder at full rate", () => {
    // Sonnet: total 1.3M = 100k uncached + 1M cached read + 200k write; 10k out
    // = 100k*3/1M + 1M*0.3/1M + 200k*3.75/1M + 10k*15/1M
    // = 0.3 + 0.3 + 0.75 + 0.15 = 1.5
    expect(
      estimateTurnCostUsd(
        { name: "claude-sonnet-4-6", builtinProviderId: "anthropic" },
        {
          inputTokens: 1_300_000,
          outputTokens: 10_000,
          cachedInputTokens: 1_000_000,
          cacheCreationInputTokens: 200_000,
        },
      ),
    ).toBeCloseTo(1.5, 5);
  });

  it("openai: cached reads re-billed at the cached rate, no write surcharge", () => {
    // gpt-5: 1M input of which 800k cached, 10k out
    // = 200k*1.25/1M + 800k*0.125/1M + 10k*10/1M = 0.25 + 0.1 + 0.1 = 0.45
    expect(
      estimateTurnCostUsd(
        { name: "gpt-5", builtinProviderId: "openai" },
        {
          inputTokens: 1_000_000,
          outputTokens: 10_000,
          cachedInputTokens: 800_000,
        },
      ),
    ).toBeCloseTo(0.45, 5);
  });

  it("claude via a custom proxy prices identically (uniform semantics)", () => {
    // Sonnet: (1M-500k)*3/1M + 500k*0.3/1M + 0 out = 1.5 + 0.15 = 1.65
    expect(
      estimateTurnCostUsd(
        { name: "claude-sonnet-4-6", builtinProviderId: "my-proxy" },
        {
          inputTokens: 1_000_000,
          outputTokens: 0,
          cachedInputTokens: 500_000,
        },
      ),
    ).toBeCloseTo(1.65, 5);
  });

  it("no cache-write rate known → write tokens fall back to the full input rate", () => {
    // gpt-4.1 has no cacheWritePerMtok: 1M total, all of it cache-write →
    // billed at the $2/M input rate.
    expect(
      estimateTurnCostUsd(
        { name: "gpt-4.1", builtinProviderId: "anthropic" },
        {
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheCreationInputTokens: 1_000_000,
        },
      ),
    ).toBeCloseTo(2, 5);
  });

  it("actual provider-reported cost wins over the estimate", () => {
    expect(
      estimateTurnCostUsd(
        { name: "claude-opus-4-8", builtinProviderId: "openrouter" },
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        0.123456,
      ),
    ).toBeCloseTo(0.123456, 6);
  });

  it("actual cost works even when the model has no known rate", () => {
    expect(
      estimateTurnCostUsd(
        { name: "unknown/model", builtinProviderId: "openrouter" },
        null,
        0.05,
      ),
    ).toBeCloseTo(0.05, 6);
  });

  it("inputOutputTokensFromUsage carries cachedInputTokens through (deprecated v5 field)", () => {
    expect(
      inputOutputTokensFromUsage({
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 40,
      }),
    ).toEqual({ inputTokens: 100, outputTokens: 50, cachedInputTokens: 40 });
  });

  it("inputOutputTokensFromUsage prefers ai@6 inputTokenDetails (read + write)", () => {
    expect(
      inputOutputTokensFromUsage({
        inputTokens: 1_000,
        outputTokens: 50,
        cachedInputTokens: 1, // stale deprecated field — details win
        inputTokenDetails: { cacheReadTokens: 400, cacheWriteTokens: 100 },
      }),
    ).toEqual({
      inputTokens: 1_000,
      outputTokens: 50,
      cachedInputTokens: 400,
      cacheCreationInputTokens: 100,
    });
  });
});
