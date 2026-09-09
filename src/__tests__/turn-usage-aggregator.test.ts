/**
 * Auxiliary usage attribution.
 *
 * Sub-agent spend was already BILLED correctly — on Core each sub-agent call is its
 * own proxy request with its own generation id and debit. What was missing was
 * visibility: the meter showed one lumped figure labelled "Sub-agents" that also
 * counted compaction, so app-initiated spend looked like work the user had asked for.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  recordAuxUsage,
  resetAuxUsage,
  summarizeAuxBySource,
  takeAuxUsage,
} from "@/lib/usage/turn-usage-aggregator";

const CHAT = 42;

beforeEach(() => resetAuxUsage(CHAT));

describe("recordAuxUsage", () => {
  it("accumulates totals and per-label calls", () => {
    recordAuxUsage(
      CHAT,
      { inputTokens: 100, outputTokens: 20 },
      "subagent:task",
    );
    recordAuxUsage(
      CHAT,
      { inputTokens: 50, outputTokens: 10 },
      "subagent:task",
    );
    const totals = takeAuxUsage(CHAT)!;
    expect(totals.totalTokens).toBe(180);
    expect(totals.calls).toBe(2);
    expect(totals.byLabel["subagent:task"]).toEqual({
      tokens: 180,
      calls: 2,
      inputTokens: 150,
      outputTokens: 30,
      // Zero, not absent: nothing here was estimated, and a consumer must be able
      // to tell "measured" from "inferred" without checking for undefined.
      estimatedTokens: 0,
    });
  });

  it("keeps the input/output split, which cost attribution needs", () => {
    // Input and output rates differ by 2-5x, so a total alone can't be priced.
    recordAuxUsage(CHAT, { inputTokens: 1000, outputTokens: 10 }, "compaction");
    const entry = takeAuxUsage(CHAT)!.byLabel["compaction"]!;
    expect(entry.inputTokens).toBe(1000);
    expect(entry.outputTokens).toBe(10);
  });

  it("records a split of 0 when the provider reported only a total", () => {
    // 0 is distinguishable from a real zero-output call by `tokens` being non-zero.
    recordAuxUsage(CHAT, { totalTokens: 500 }, "subagent:task");
    const entry = takeAuxUsage(CHAT)!.byLabel["subagent:task"]!;
    expect(entry.tokens).toBe(500);
    expect(entry.inputTokens).toBe(0);
    expect(entry.outputTokens).toBe(0);
  });

  it("keeps labels separate", () => {
    recordAuxUsage(
      CHAT,
      { inputTokens: 100, outputTokens: 0 },
      "subagent:task",
    );
    recordAuxUsage(CHAT, { inputTokens: 900, outputTokens: 0 }, "compaction");
    const totals = takeAuxUsage(CHAT)!;
    expect(totals.byLabel["subagent:task"]!.tokens).toBe(100);
    expect(totals.byLabel["compaction"]!.tokens).toBe(900);
  });

  it("ignores unusable input without throwing", () => {
    expect(
      recordAuxUsage(null, { inputTokens: 1, outputTokens: 1 }, "x"),
    ).toBeNull();
    expect(recordAuxUsage(CHAT, undefined, "x")).toBeNull();
    expect(recordAuxUsage(CHAT, {}, "x")).toBeNull();
    expect(takeAuxUsage(CHAT)).toBeNull();
  });

  it("drains the bucket so a second take is empty", () => {
    recordAuxUsage(CHAT, { inputTokens: 10, outputTokens: 5 }, "subagent:task");
    expect(takeAuxUsage(CHAT)).not.toBeNull();
    expect(takeAuxUsage(CHAT)).toBeNull();
  });
});

describe("summarizeAuxBySource", () => {
  it("separates sub-agents from compaction — the mislabel this fixes", () => {
    recordAuxUsage(
      CHAT,
      { inputTokens: 100, outputTokens: 0 },
      "subagent:task",
    );
    recordAuxUsage(CHAT, { inputTokens: 900, outputTokens: 0 }, "compaction");
    const summary = summarizeAuxBySource(takeAuxUsage(CHAT));
    expect(summary).toEqual([
      { source: "compaction", tokens: 900, calls: 1, estimatedTokens: 0 },
      { source: "subagents", tokens: 100, calls: 1, estimatedTokens: 0 },
    ]);
  });

  it("groups every subagent label into one bucket, preserving the call count", () => {
    recordAuxUsage(CHAT, { inputTokens: 10, outputTokens: 0 }, "subagent:task");
    recordAuxUsage(
      CHAT,
      { inputTokens: 20, outputTokens: 0 },
      "subagent:reviewer",
    );
    const summary = summarizeAuxBySource(takeAuxUsage(CHAT));
    expect(summary).toEqual([
      { source: "subagents", tokens: 30, calls: 2, estimatedTokens: 0 },
    ]);
  });

  it("orders largest first, so the dominant spender reads first", () => {
    recordAuxUsage(CHAT, { inputTokens: 5, outputTokens: 0 }, "compaction");
    recordAuxUsage(
      CHAT,
      { inputTokens: 500, outputTokens: 0 },
      "subagent:task",
    );
    expect(summarizeAuxBySource(takeAuxUsage(CHAT))[0]!.source).toBe(
      "subagents",
    );
  });

  it("buckets an unrecognized label as 'other' rather than dropping it", () => {
    recordAuxUsage(
      CHAT,
      { inputTokens: 7, outputTokens: 0 },
      "title-generation",
    );
    expect(summarizeAuxBySource(takeAuxUsage(CHAT))).toEqual([
      { source: "other", tokens: 7, calls: 1, estimatedTokens: 0 },
    ]);
  });

  it("is empty for no usage", () => {
    expect(summarizeAuxBySource(null)).toEqual([]);
  });

  it("sums to the reported total, so the breakdown can't disagree with the headline", () => {
    recordAuxUsage(
      CHAT,
      { inputTokens: 100, outputTokens: 20 },
      "subagent:task",
    );
    recordAuxUsage(CHAT, { inputTokens: 300, outputTokens: 5 }, "compaction");
    recordAuxUsage(CHAT, { inputTokens: 7, outputTokens: 0 }, "something-else");
    const totals = takeAuxUsage(CHAT)!;
    const summed = summarizeAuxBySource(totals).reduce(
      (a, s) => a + s.tokens,
      0,
    );
    expect(summed).toBe(totals.totalTokens);
  });
});

describe("a call the provider reports nothing for", () => {
  /**
   * OBSERVED 2026-08-31, packaged app. A turn ran four sub-agents — one of them
   * eight steps deep — and logged `across 1 call(s)`. `recordAuxUsage` bailed on
   * `tokens == null || tokens <= 0`, which dropped not just the size but the FACT
   * of the call, so the total the user sees understated what they spent. Free
   * OpenRouter routes commonly omit usage, and those are exactly the routes someone
   * watching their spend is on.
   */
  it("is COUNTED, with its size estimated", () => {
    recordAuxUsage(CHAT, undefined, "subagent:task", {
      estimateTokens: () => 5_000,
    });
    const totals = takeAuxUsage(CHAT)!;

    expect(totals).toBeTruthy();
    expect(totals.calls).toBe(1); // the call existed — that is the point
    expect(totals.totalEstimatedTokens).toBe(5_000);
    // And it is NOT laundered into the measured figure.
    expect(totals.totalTokens).toBe(0);
    expect(totals.byLabel["subagent:task"]!.tokens).toBe(0);
    expect(totals.byLabel["subagent:task"]!.estimatedTokens).toBe(5_000);
  });

  it("still records nothing when there is no fallback either", () => {
    // Unchanged from before: never invent a zero-token entry that reads as real.
    expect(recordAuxUsage(CHAT, undefined, "subagent:task")).toBeNull();
    expect(takeAuxUsage(CHAT)).toBeNull();
  });

  it("does not ESTIMATE when the provider already answered", () => {
    // Estimating runs an exact tokenizer over the whole request. On a sub-agent's
    // tool-heavy history that is real work, and it is pure waste on the common path
    // where usage came back. The thunk must not be called at all.
    let called = 0;
    recordAuxUsage(CHAT, { totalTokens: 500 }, "subagent:task", {
      estimateTokens: () => {
        called += 1;
        return 9_999;
      },
    });
    expect(called).toBe(0);
    expect(takeAuxUsage(CHAT)!.totalTokens).toBe(500);
  });

  it("never lets an estimate override a provider figure", () => {
    // A measured number always wins, however large the guess beside it.
    recordAuxUsage(CHAT, { totalTokens: 100 }, "subagent:task", {
      estimateTokens: () => 999_999,
    });
    const totals = takeAuxUsage(CHAT)!;
    expect(totals.totalTokens).toBe(100);
    expect(totals.totalEstimatedTokens).toBe(0);
    expect(totals.byLabel["subagent:task"]!.estimatedTokens).toBe(0);
  });

  it("surfaces a turn whose auxiliary spend was ONLY estimated", () => {
    // `takeAuxUsage` used to gate on `totalTokens > 0`, so a turn whose every
    // auxiliary call came from a silent provider drained as null and vanished.
    recordAuxUsage(CHAT, null, "subagent:task", {
      estimateTokens: () => 2_500,
    });
    const totals = takeAuxUsage(CHAT);
    expect(totals).not.toBeNull();
    expect(totals!.calls).toBe(1);
  });

  it("reports the real call count and a distinguishable estimate", () => {
    // The exact shape from the observed turn: four runs, one silent.
    recordAuxUsage(CHAT, { totalTokens: 78_640 }, "subagent:task");
    recordAuxUsage(CHAT, { totalTokens: 25_600 }, "subagent:task");
    recordAuxUsage(CHAT, { totalTokens: 27_049 }, "subagent:task");
    recordAuxUsage(CHAT, undefined, "subagent:task", {
      estimateTokens: () => 30_000,
    });

    const totals = takeAuxUsage(CHAT)!;
    expect(totals.calls).toBe(4); // was 3
    expect(totals.totalTokens).toBe(131_289);
    expect(totals.totalEstimatedTokens).toBe(30_000);

    const [subagents] = summarizeAuxBySource(totals);
    expect(subagents!.calls).toBe(4);
    // The best available total, with the untrustworthy share named.
    expect(subagents!.tokens).toBe(161_289);
    expect(subagents!.estimatedTokens).toBe(30_000);
  });
});
