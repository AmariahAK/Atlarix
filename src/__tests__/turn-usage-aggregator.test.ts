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
    recordAuxUsage(CHAT, { inputTokens: 100, outputTokens: 20 }, "subagent:task");
    recordAuxUsage(CHAT, { inputTokens: 50, outputTokens: 10 }, "subagent:task");
    const totals = takeAuxUsage(CHAT)!;
    expect(totals.totalTokens).toBe(180);
    expect(totals.calls).toBe(2);
    expect(totals.byLabel["subagent:task"]).toEqual({
      tokens: 180,
      calls: 2,
      inputTokens: 150,
      outputTokens: 30,
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
    recordAuxUsage(CHAT, { inputTokens: 100, outputTokens: 0 }, "subagent:task");
    recordAuxUsage(CHAT, { inputTokens: 900, outputTokens: 0 }, "compaction");
    const totals = takeAuxUsage(CHAT)!;
    expect(totals.byLabel["subagent:task"]!.tokens).toBe(100);
    expect(totals.byLabel["compaction"]!.tokens).toBe(900);
  });

  it("ignores unusable input without throwing", () => {
    expect(recordAuxUsage(null, { inputTokens: 1, outputTokens: 1 }, "x")).toBeNull();
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
    recordAuxUsage(CHAT, { inputTokens: 100, outputTokens: 0 }, "subagent:task");
    recordAuxUsage(CHAT, { inputTokens: 900, outputTokens: 0 }, "compaction");
    const summary = summarizeAuxBySource(takeAuxUsage(CHAT));
    expect(summary).toEqual([
      { source: "compaction", tokens: 900, calls: 1 },
      { source: "subagents", tokens: 100, calls: 1 },
    ]);
  });

  it("groups every subagent label into one bucket, preserving the call count", () => {
    recordAuxUsage(CHAT, { inputTokens: 10, outputTokens: 0 }, "subagent:task");
    recordAuxUsage(CHAT, { inputTokens: 20, outputTokens: 0 }, "subagent:reviewer");
    const summary = summarizeAuxBySource(takeAuxUsage(CHAT));
    expect(summary).toEqual([{ source: "subagents", tokens: 30, calls: 2 }]);
  });

  it("orders largest first, so the dominant spender reads first", () => {
    recordAuxUsage(CHAT, { inputTokens: 5, outputTokens: 0 }, "compaction");
    recordAuxUsage(CHAT, { inputTokens: 500, outputTokens: 0 }, "subagent:task");
    expect(summarizeAuxBySource(takeAuxUsage(CHAT))[0]!.source).toBe("subagents");
  });

  it("buckets an unrecognized label as 'other' rather than dropping it", () => {
    recordAuxUsage(CHAT, { inputTokens: 7, outputTokens: 0 }, "title-generation");
    expect(summarizeAuxBySource(takeAuxUsage(CHAT))).toEqual([
      { source: "other", tokens: 7, calls: 1 },
    ]);
  });

  it("is empty for no usage", () => {
    expect(summarizeAuxBySource(null)).toEqual([]);
  });

  it("sums to the reported total, so the breakdown can't disagree with the headline", () => {
    recordAuxUsage(CHAT, { inputTokens: 100, outputTokens: 20 }, "subagent:task");
    recordAuxUsage(CHAT, { inputTokens: 300, outputTokens: 5 }, "compaction");
    recordAuxUsage(CHAT, { inputTokens: 7, outputTokens: 0 }, "something-else");
    const totals = takeAuxUsage(CHAT)!;
    const summed = summarizeAuxBySource(totals).reduce((a, s) => a + s.tokens, 0);
    expect(summed).toBe(totals.totalTokens);
  });
});
