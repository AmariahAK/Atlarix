/**
 * v12 7D — BYOK per-turn cost estimation.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  estimateTurnCostUsd,
  inputOutputTokensFromUsage,
  registerModelsDevPrices,
} from "@/lib/routing/byok-pricing";
import {
  __resetCustomProviderFormatsForTests,
  rememberCustomProviderFormats,
} from "@/lib/routing/custom-provider-format";

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

  it("prices the DeepSeek V4 models rather than reporting no cost at all", () => {
    // Before these entries the table had no DeepSeek pattern, so a real V4 Flash
    // run reported `turnCostUsd` as absent — which on a benchmark leaderboard
    // reads as a blank cost column rather than as a missing rate.
    //
    // PEAK rates, deliberately: DeepSeek's off-peak tariff is half of peak and a
    // static table cannot know which window a turn fell in, so the estimate errs
    // high. Flash: $0.44 in + $1.32 out. Pro: $1.32 + $3.96.
    expect(
      estimateTurnCostUsd({ name: "deepseek-v4-flash" }, usage),
    ).toBeCloseTo(1.76, 5);
    expect(estimateTurnCostUsd({ name: "deepseek-v4-pro" }, usage)).toBeCloseTo(
      5.28,
      5,
    );
    // Flash must not be priced as Pro: the table is first-match, so a broader
    // DeepSeek pattern added above these would silently triple Flash's cost.
    expect(
      estimateTurnCostUsd({ name: "deepseek-v4-flash" }, usage),
    ).toBeLessThan(estimateTurnCostUsd({ name: "deepseek-v4-pro" }, usage)!);
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
  it("anthropic: reads 0.1x, writes 2x (the 1h header), remainder at full rate", () => {
    // Sonnet: total 1.3M = 100k uncached + 1M cached read + 200k write; 10k out
    // = 100k*3/1M + 1M*0.3/1M + 200k*6/1M + 10k*15/1M
    // = 0.3 + 0.3 + 1.2 + 0.15 = 1.95
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
    ).toBeCloseTo(1.95, 5);
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
        { name: "gpt-4.1", builtinProviderId: "my-proxy" },
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

describe("estimateTurnCostUsd — the models.dev catalog's prices", () => {
  // Rows as the bundled snapshot has them (2026-10-19). The static table had no
  // Fable at all (no cost shown) and priced Haiku 5.5 at Haiku 4.5's $1/$5.
  const ROWS = [
    { providerId: "anthropic", modelId: "claude-fable-5-1", cost: { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 } },
    { providerId: "anthropic", modelId: "claude-sonnet-5-5", cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 } },
    {
      providerId: "anthropic",
      modelId: "claude-haiku-5-5",
      cost: {
        input: 0.1,
        output: 0.5,
        cache_read: 0.01,
        cache_write: 0.125,
        tiers: [{ input: 0.5, output: 2.5, cache_read: 0.05, cache_write: 0.625, tier: { type: "context", size: 100_000 } }],
      },
    },
    { providerId: "bedrock", modelId: "anthropic.claude-sonnet-5-5-v1:0", cost: { input: 2.2, output: 11, cache_read: 0.22, cache_write: 2.75 } },
    { providerId: "ollama-cloud", modelId: "gpt-oss:20b", cost: { input: 0, output: 0 } },
  ];
  const mtok = { inputTokens: 1_000_000, outputTokens: 1_000_000 };

  afterEach(() => {
    registerModelsDevPrices([]);
    __resetCustomProviderFormatsForTests();
  });

  it("prices Fable, which the static table never had", () => {
    expect(estimateTurnCostUsd({ name: "claude-fable-5-1", builtinProviderId: "anthropic" }, mtok)).toBeNull();
    registerModelsDevPrices(ROWS);
    // $10 in + $50 out.
    expect(estimateTurnCostUsd({ name: "claude-fable-5-1", builtinProviderId: "anthropic" }, mtok)).toBeCloseTo(60, 5);
  });

  it("the catalog wins over the static table", () => {
    registerModelsDevPrices(ROWS);
    // Haiku 5.5: $0.10 + $0.50, not the table's Haiku $1 + $5.
    expect(estimateTurnCostUsd({ name: "claude-haiku-5-5", builtinProviderId: "anthropic" }, mtok)).toBeCloseTo(0.6, 5);
    // Sonnet 5.5: $2 + $10, not $3 + $15.
    expect(estimateTurnCostUsd({ name: "claude-sonnet-5-5", builtinProviderId: "anthropic" }, mtok)).toBeCloseTo(12, 5);
  });

  it("a request past a context tier's size is priced at that tier", () => {
    registerModelsDevPrices(ROWS);
    const at = (contextTokens: number) =>
      estimateTurnCostUsd({ name: "claude-haiku-5-5", builtinProviderId: "anthropic" }, { ...mtok, contextTokens });
    expect(at(100_000)).toBeCloseTo(0.6, 5);
    // Over 100k: $0.50 + $2.50.
    expect(at(150_000)).toBeCloseTo(3, 5);
  });

  it("Anthropic cache writes at the 1h rate (2x input), reads at the catalog's", () => {
    registerModelsDevPrices(ROWS);
    // Sonnet 5.5: 1M written ($4, not the catalog's 5-minute $2.50) + 1M read ($0.10).
    expect(
      estimateTurnCostUsd(
        { name: "claude-sonnet-5-5", builtinProviderId: "anthropic" },
        { inputTokens: 2_000_000, outputTokens: 0, cacheCreationInputTokens: 1_000_000, cachedInputTokens: 1_000_000 },
      ),
    ).toBeCloseTo(4.1, 5);
  });

  it("a provider added on the Anthropic format is priced as Claude, under Bedrock's longer id too", () => {
    registerModelsDevPrices(ROWS);
    rememberCustomProviderFormats([{ id: "custom::gateway", apiFormat: "anthropic" }]);
    expect(
      estimateTurnCostUsd({ name: "us.anthropic.claude-fable-5-1-v1:0", builtinProviderId: "custom::gateway" }, mtok),
    ).toBeCloseTo(60, 5);
    // It writes the 1h header too: 1M written on Fable = $20.
    expect(
      estimateTurnCostUsd(
        { name: "claude-fable-5-1", builtinProviderId: "custom::gateway" },
        { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 1_000_000 },
      ),
    ).toBeCloseTo(20, 5);
  });

  it("Bedrock's own row, with its 5-minute cache write", () => {
    registerModelsDevPrices(ROWS);
    expect(
      estimateTurnCostUsd(
        { name: "anthropic.claude-sonnet-5-5-v1:0", builtinProviderId: "bedrock" },
        { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 1_000_000 },
      ),
    ).toBeCloseTo(2.75, 5);
  });

  it("a row priced at zero is no price, not a free turn", () => {
    registerModelsDevPrices(ROWS);
    expect(estimateTurnCostUsd({ name: "gpt-oss:20b", builtinProviderId: "ollama-cloud" }, mtok)).toBeNull();
  });

  it("a refreshed catalog replaces the prices before it", () => {
    registerModelsDevPrices(ROWS);
    registerModelsDevPrices([{ providerId: "anthropic", modelId: "claude-fable-5-1", cost: { input: 5, output: 25 } }]);
    expect(estimateTurnCostUsd({ name: "claude-fable-5-1", builtinProviderId: "anthropic" }, mtok)).toBeCloseTo(30, 5);
    expect(estimateTurnCostUsd({ name: "claude-haiku-5-5", builtinProviderId: "anthropic" }, mtok)).toBeCloseTo(6, 5);
  });
});

describe("estimateTurnCostUsd, reliable prices only (the Usage page)", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  const reliable = { reliableOnly: true } as const;

  it("still prices a vendor's own model from the table copied from its price list", () => {
    expect(estimateTurnCostUsd({ name: "claude-opus-4-8", builtinProviderId: "anthropic" }, usage, null, reliable)).toBeCloseTo(30, 5);
  });

  it("never prices a custom proxy, a local server or an unknown gateway by its model's name", () => {
    for (const builtinProviderId of ["custom::my-proxy", "ollama", "lmstudio", undefined]) {
      expect(estimateTurnCostUsd({ name: "claude-opus-4-8", builtinProviderId }, usage, null, reliable)).toBeNull();
    }
    // A slash in the name is not OpenRouter unless the provider is.
    expect(estimateTurnCostUsd({ name: "anthropic/claude-opus-4-8", builtinProviderId: "custom::x" }, usage, null, reliable)).toBeNull();
    // Without the option, the old behaviour (the chat's live cost line) is unchanged.
    expect(estimateTurnCostUsd({ name: "claude-opus-4-8", builtinProviderId: "custom::my-proxy" }, usage)).toBeCloseTo(30, 5);
  });

  it("takes OpenRouter's own charge whatever the provider", () => {
    expect(estimateTurnCostUsd({ name: "x", builtinProviderId: "custom::x" }, usage, 0.42, reliable)).toBe(0.42);
  });
});
