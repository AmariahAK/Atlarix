import { describe, expect, it } from "vitest";
import type { CoreMessage } from "../core/client";
import {
  MAX_RESERVE_FRACTION,
  assertBudgetsFitWithin,
  budgetHealth,
  compactionBudgets,
  compactionWouldTrigger,
  estimateMessages,
  estimateTokens,
  measureContext,
  messageText,
  usableContextBudget,
} from "./budget";

describe("the estimator", () => {
  it("is four characters to a token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("rounds a partial token up rather than losing it", () => {
    // Down would let a long transcript of short messages under-count by one
    // token per message, which on a hundred messages is a hundred tokens of
    // silent optimism.
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("usableContextBudget", () => {
  it("hands the reply its whole allowance back", () => {
    expect(
      usableContextBudget({ contextWindow: 200_000, maxOutputTokens: 32_000 }),
    ).toBe(168_000);
  });

  it("clamps the reserve so a small window cannot invert the arithmetic", () => {
    // 16,000 window, 32,000 output floor. Unclamped this is NEGATIVE, and every
    // ratio computed from it is nonsense.
    const usable = usableContextBudget({
      contextWindow: 16_000,
      maxOutputTokens: 32_000,
    });
    expect(usable).toBe(16_000 - 16_000 * MAX_RESERVE_FRACTION);
    expect(usable).toBeGreaterThan(0);
  });

  it("is zero for an unknown window, so a caller can tell unknown from empty", () => {
    expect(
      usableContextBudget({ contextWindow: 0, maxOutputTokens: 32_000 }),
    ).toBe(0);
  });
});

describe("compactionBudgets", () => {
  it("never lets a protection floor exceed the budget it protects within", () => {
    // THE INVARIANT, driven across the real spread of Core windows. Every
    // absolute constant this replaced violated it at the small end — which is
    // how a 41,000-token session against a 16,000-token cap compacted nothing
    // at all.
    for (const window of [8_000, 16_000, 32_000, 128_000, 200_000, 1_000_000]) {
      const usable = usableContextBudget({
        contextWindow: window,
        maxOutputTokens: 32_000,
      });
      expect(assertBudgetsFitWithin(compactionBudgets(usable), usable)).toEqual(
        [],
      );
    }
  });

  it("leaves most of a tool-heavy turn reclaimable", () => {
    // A pruner that protected most of the budget could not free enough to be
    // worth running, which is the failure this fraction exists to prevent.
    const b = compactionBudgets(100_000);
    expect(b.pruneProtectRecent).toBe(25_000);
  });
});

describe("messageText", () => {
  it("counts tool call arguments, not just content", () => {
    // An assistant message with null content and four calls is not free. Missing
    // this makes a tool-heavy conversation — the kind that needs compacting —
    // look half its real size.
    const message: CoreMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_0",
          type: "function",
          function: { name: "read_page", arguments: '{"tab_id":12345}' },
        },
      ],
    };
    expect(messageText(message)).toContain("read_page");
    expect(messageText(message)).toContain("12345");
    expect(estimateMessages([message])).toBeGreaterThan(0);
  });

  it("counts a tool result, which is the bulk of a long conversation", () => {
    const result: CoreMessage = {
      role: "tool",
      tool_call_id: "call_0",
      content: "x".repeat(40_000),
    };
    expect(estimateMessages([result])).toBe(10_000);
  });
});

describe("compactionWouldTrigger", () => {
  const long: CoreMessage[] = [
    { role: "user", content: "x".repeat(400_000) },
  ];

  it("fires when the transcript plus the overhead exceeds usable", () => {
    const r = compactionWouldTrigger({
      messages: long,
      overheadTokens: 2_500,
      usable: 100_000,
    });
    expect(r.willTrigger).toBe(true);
    expect(r.beforeTokens).toBe(102_500);
  });

  it("counts the fixed overhead, which is ~2,500 tokens every round", () => {
    // Without it a conversation sitting just under the line reads as fitting and
    // then 400s at the provider.
    const messages: CoreMessage[] = [{ role: "user", content: "x".repeat(400) }];
    expect(
      compactionWouldTrigger({ messages, overheadTokens: 2_500, usable: 1_000 })
        .willTrigger,
    ).toBe(true);
    expect(
      compactionWouldTrigger({ messages, overheadTokens: 0, usable: 1_000 })
        .willTrigger,
    ).toBe(false);
  });
});

describe("budgetHealth", () => {
  it("uses the desktop's thresholds", () => {
    expect(budgetHealth(0)).toBe("healthy");
    expect(budgetHealth(0.49)).toBe("healthy");
    expect(budgetHealth(0.5)).toBe("warning");
    expect(budgetHealth(0.69)).toBe("warning");
    expect(budgetHealth(0.7)).toBe("critical");
    expect(budgetHealth(0.84)).toBe("critical");
    expect(budgetHealth(0.85)).toBe("over");
    expect(budgetHealth(2)).toBe("over");
  });
});

describe("measureContext", () => {
  it("returns null for an unknown window rather than a full bar", () => {
    // THE ONE THAT MATTERS FOR THE UI. `contextWindow: 0` means the proxy had no
    // catalog row. Treated as a number it makes `usable` zero and every
    // conversation permanently over budget, so a brand-new chat shows a red bar.
    expect(
      measureContext({
        messages: [{ role: "user", content: "hi" }],
        overheadTokens: 100,
        contextWindow: 0,
        maxOutputTokens: 32_000,
      }),
    ).toBeNull();
  });

  it("measures a real conversation against a real tier", () => {
    const status = measureContext({
      messages: [{ role: "user", content: "x".repeat(336_000) }],
      overheadTokens: 0,
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
    });
    expect(status).not.toBeNull();
    // 84,000 tokens against a usable 168,000.
    expect(status?.usedTokens).toBe(84_000);
    expect(status?.usable).toBe(168_000);
    expect(status?.ratio).toBeCloseTo(0.5);
    expect(status?.health).toBe("warning");
    expect(status?.willCompact).toBe(false);
  });

  it("says compaction is due once the transcript passes usable", () => {
    const status = measureContext({
      messages: [{ role: "user", content: "x".repeat(800_000) }],
      overheadTokens: 0,
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
    });
    expect(status?.willCompact).toBe(true);
    expect(status?.health).toBe("over");
  });
});
