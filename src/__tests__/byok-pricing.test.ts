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
