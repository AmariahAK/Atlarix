import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  ABSOLUTE_COMPACTION_CEILING,
  MAX_RESERVE_FRACTION,
  assertBudgetsFitWithin,
  compactionBudgets,
  compactionCeiling,
  compactionShouldTrigger,
  compactionWouldTrigger,
  usableContextBudget,
} from "@/lib/context/mid-loop-threshold";

/**
 * WHEN compaction fires, and HOW MUCH each of its steps may protect.
 *
 * This replaces a flat `COMPACTION_THRESHOLD = 0.9`. A fixed percentage of the
 * window has no relationship to how long a reply can be, so it was wrong in both
 * directions: on a 1,000,000-token window it reserved 100,000 for output when
 * ~32,000 is needed (compacting ~68,000 tokens earlier than necessary, every
 * turn), and on a 16,000-token budget it reserved 1,600 when a reasoning model
 * wants 32,000 (so the reply could not fit at all).
 */

// Small on purpose: `estimateTokens` runs an EXACT tokenizer, so fixtures sized
// like a real window take minutes to score. The predicate is pure arithmetic.
const WINDOW = 1_000;

function msgsOfRoughly(tokens: number): ModelMessage[] {
  return [{ role: "user", content: "word ".repeat(tokens) } as ModelMessage];
}

const trigger = (tokens: number, usableTokens = 900) =>
  compactionWouldTrigger({
    messages: msgsOfRoughly(tokens),
    systemPromptEstimate: 0,
    tierLimit: WINDOW,
    usableTokens,
  });

describe("usableContextBudget — window minus the room the reply needs", () => {
  it("lets the model's real output limit govern on a large window", () => {
    // 1M window, 32,000 reasoning reserve: the real limit is far under the 40%
    // clamp, so it is what applies.
    expect(
      usableContextBudget({
        contextWindow: 1_048_576,
        maxOutputTokens: 32_000,
      }),
    ).toBe(1_016_576);
  });

  it("lets the SHARE govern on a small window, instead of going negative", () => {
    // The reasoning floor (32,000) exceeds a 16,000 budget outright. Unclamped
    // this is -16,000 and every fraction derived from it is nonsense.
    const usable = usableContextBudget({
      contextWindow: 16_000,
      maxOutputTokens: 32_000,
    });
    expect(usable).toBe(16_000 - Math.floor(16_000 * MAX_RESERVE_FRACTION));
    expect(usable).toBe(9_600);
  });

  it("never returns zero or negative for any window", () => {
    for (const w of [1, 100, 8_000, 16_000, 200_000, 1_048_576]) {
      const usable = usableContextBudget({
        contextWindow: w,
        maxOutputTokens: 1_000_000,
      });
      expect(usable).toBeGreaterThan(0);
      expect(usable).toBeLessThanOrEqual(w);
    }
  });

  it("is at least 60% of the window however greedy the reserve", () => {
    for (const w of [8_000, 16_000, 200_000]) {
      const usable = usableContextBudget({
        contextWindow: w,
        maxOutputTokens: Number.MAX_SAFE_INTEGER,
      });
      expect(usable).toBeGreaterThanOrEqual(Math.floor(w * 0.6));
    }
  });
});

describe("compactionBudgets — no floor may exceed the budget it protects within", () => {
  /**
   * THE invariant, and the one every step used to violate. Measured 2026-08-31 on
   * a real session: a 16,000-token cap with `PRUNE_MINIMUM_TOKENS = 20_000` meant
   * the pruner protected more tool output than the entire budget contained, so a
   * 19,000-token message was kept whole and nothing downstream had anything left
   * to reclaim.
   */
  it("holds across every window size", () => {
    for (const w of [8_000, 16_000, 32_000, 200_000, 1_048_576]) {
      const usable = usableContextBudget({
        contextWindow: w,
        maxOutputTokens: 32_000,
      });
      const budgets = compactionBudgets(usable);
      expect(assertBudgetsFitWithin(budgets, usable)).toEqual([]);
    }
  });

  it("holds even for absurdly small budgets", () => {
    for (const usable of [1, 10, 500, 999]) {
      expect(assertBudgetsFitWithin(compactionBudgets(usable), usable)).toEqual(
        [],
      );
    }
  });

  it("scales with the budget rather than sitting at a constant", () => {
    const small = compactionBudgets(10_000);
    const large = compactionBudgets(1_000_000);
    expect(large.pruneProtectRecent).toBeGreaterThan(small.pruneProtectRecent);
    expect(large.preserveRecent).toBeGreaterThan(small.preserveRecent);
    expect(large.microcompactKeepTokens).toBeGreaterThan(
      small.microcompactKeepTokens,
    );
  });
});

describe("compactionWouldTrigger", () => {
  it("fires once the request exceeds what it may occupy", () => {
    expect(trigger(901).willTrigger).toBe(true);
    expect(trigger(1_500).willTrigger).toBe(true);
  });

  it("does NOT fire while there is room — a turn keeps its detail", () => {
    expect(trigger(880).willTrigger).toBe(false);
    expect(trigger(500).willTrigger).toBe(false);
  });

  it("counts the system prompt toward the fill, not just the messages", () => {
    const under = compactionWouldTrigger({
      messages: msgsOfRoughly(850),
      systemPromptEstimate: 0,
      tierLimit: WINDOW,
      usableTokens: 900,
    });
    const over = compactionWouldTrigger({
      messages: msgsOfRoughly(850),
      systemPromptEstimate: 100,
      tierLimit: WINDOW,
      usableTokens: 900,
    });
    expect(under.willTrigger).toBe(false);
    expect(over.willTrigger).toBe(true);
  });

  it("falls back to the tier limit when no usable budget is supplied", () => {
    const r = compactionWouldTrigger({
      messages: msgsOfRoughly(2_000),
      systemPromptEstimate: 0,
      tierLimit: 10_000,
    });
    expect(r.willTrigger).toBe(false);
    expect(r.usable).toBe(10_000);
  });
});

describe("absolute compaction ceiling", () => {
  it("caps a 1M-window model at 200k, so it compacts long before its usable budget", () => {
    // 1M window, 32k reserve → usable ≈ 1,016,576. The ceiling must bind first.
    const usable = usableContextBudget({
      contextWindow: 1_048_576,
      maxOutputTokens: 32_000,
    });
    expect(ABSOLUTE_COMPACTION_CEILING).toBe(200_000);
    expect(compactionCeiling(usable)).toBe(200_000);
    // History passes the ceiling but is still far under the model's usable budget:
    // the absolute ceiling is what triggers.
    expect(compactionShouldTrigger({ dispatchEstimate: 200_001, usableTokens: usable })).toBe(true);
    expect(compactionShouldTrigger({ dispatchEstimate: 199_999, usableTokens: usable })).toBe(false);
  });

  it("still lets a small window govern itself below the ceiling", () => {
    expect(compactionCeiling(9_600)).toBe(9_600);
    expect(compactionCeiling(150_000)).toBe(150_000);
    expect(compactionShouldTrigger({ dispatchEstimate: 9_601, usableTokens: 9_600 })).toBe(true);
    expect(compactionShouldTrigger({ dispatchEstimate: 9_599, usableTokens: 9_600 })).toBe(false);
  });
});
