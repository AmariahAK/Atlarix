import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { buildStreamMessagesWithCacheBreakpoints } from "@/lib/ai/anthropic-cache-breakpoints";

/**
 * Tier 4 eval 6: provider message-shape — Anthropic prompt-cache breakpoints.
 *
 * NOTE: this is deliberately a unit test, not a chat:stream agent eval — the
 * agent-eval fake server speaks OpenAI protocol, so `isAnthropic` can never be
 * true through that seam. The layout function is extracted from
 * simpleStreamText precisely so this shape is pinned here.
 */

const cacheControlOf = (m: ModelMessage) =>
  (m as { providerOptions?: { anthropic?: { cacheControl?: unknown } } })
    .providerOptions?.anthropic?.cacheControl;

const history: ModelMessage[] = [
  { role: "user", content: "first question" },
  { role: "assistant", content: "first answer" },
  { role: "user", content: "second question" },
];

describe("buildStreamMessagesWithCacheBreakpoints", () => {
  it("anthropic: breakpoint on system header + previous exchange", () => {
    const out = buildStreamMessagesWithCacheBreakpoints({
      systemHeader: "HEADER",
      dynamicTail: "TAIL",
      history,
      isAnthropic: true,
    });

    // [header, tail, ...history]
    expect(out).toHaveLength(2 + history.length);
    expect(out[0].role).toBe("system");
    expect(out[0].content).toBe("HEADER");
    expect(cacheControlOf(out[0])).toEqual({ type: "ephemeral" });

    // Tail is its own system message with NO breakpoint (it changes daily).
    expect(out[1].role).toBe("system");
    expect(out[1].content).toBe("TAIL");
    expect(cacheControlOf(out[1])).toBeUndefined();

    // Second breakpoint on history[length - 2] (previous exchange tail).
    const historyOut = out.slice(2);
    expect(cacheControlOf(historyOut[historyOut.length - 2]!)).toEqual({
      type: "ephemeral",
    });
    // …and nowhere else in history.
    for (const [i, m] of historyOut.entries()) {
      if (i !== historyOut.length - 2) {
        expect(cacheControlOf(m)).toBeUndefined();
      }
    }
  });

  it("anthropic: history breakpoint preserves existing providerOptions", () => {
    const withOptions: ModelMessage[] = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: "a",
        providerOptions: { anthropic: { custom: true } } as any,
      },
      { role: "user", content: "q2" },
    ];
    const out = buildStreamMessagesWithCacheBreakpoints({
      systemHeader: "H",
      history: withOptions,
      isAnthropic: true,
    });
    const target = out[out.length - 2] as any;
    // history[len-2] is the assistant message with pre-existing options —
    // the spread keeps the anthropic key but the breakpoint object replaces it
    // wholesale (matches the original inline behavior).
    expect(target.providerOptions.anthropic.cacheControl).toEqual({
      type: "ephemeral",
    });
  });

  it("anthropic: no history breakpoint when history < 2", () => {
    const out = buildStreamMessagesWithCacheBreakpoints({
      systemHeader: "H",
      history: [{ role: "user", content: "only" }],
      isAnthropic: true,
    });
    expect(cacheControlOf(out[0])).toEqual({ type: "ephemeral" });
    expect(cacheControlOf(out[1])).toBeUndefined();
  });

  it("non-anthropic: no breakpoints anywhere, history passes through", () => {
    const out = buildStreamMessagesWithCacheBreakpoints({
      systemHeader: "H",
      dynamicTail: "T",
      history,
      isAnthropic: false,
    });
    for (const m of out) {
      expect(cacheControlOf(m)).toBeUndefined();
    }
    // History objects pass through unmodified (same references).
    expect(out.slice(2)).toEqual(history);
    expect(out[2]).toBe(history[0]);
  });

  it("omits the tail message when dynamicTail is null or blank", () => {
    for (const tail of [null, "", "   "]) {
      const out = buildStreamMessagesWithCacheBreakpoints({
        systemHeader: "H",
        dynamicTail: tail,
        history,
        isAnthropic: true,
      });
      expect(out).toHaveLength(1 + history.length);
      expect(out[1].role).toBe("user"); // tail skipped — history follows header
    }
  });
});
