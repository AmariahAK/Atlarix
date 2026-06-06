/**
 * v11.1 compaction hardening: overflow-error classifier, durable-summary
 * history slicing, and the overflow feedback clamp on context limits.
 */

import { describe, expect, it, vi } from "vitest";
import {
  isContextOverflowError,
  COMPACTION_SUMMARY_PREFIX,
  isCompactionSummaryMessage,
  sliceFromLastCompactionSummary,
} from "@/lib/context/compaction";

describe("isContextOverflowError", () => {
  it.each([
    "This model's maximum context length is 8192 tokens",
    "400 context_length_exceeded",
    "prompt is too long: 250000 tokens > 200000 maximum",
    "Input is too many tokens for this model",
    "the maximum length of the conversation was exceeded",
    "Please reduce the length of the messages",
    "input length and `max_tokens` exceed context limit",
  ])("classifies %s as overflow", (msg) => {
    expect(isContextOverflowError(new Error(msg))).toBe(true);
  });

  it("does not classify unrelated errors", () => {
    expect(isContextOverflowError(new Error("rate limit exceeded"))).toBe(false);
    expect(isContextOverflowError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isContextOverflowError(new Error("invalid api key"))).toBe(false);
    expect(isContextOverflowError(null)).toBe(false);
  });

  // v12 3.4: structured provider error codes win over the message regex.
  it("classifies by structured provider error code (APICallError shape)", () => {
    const apiErr = Object.assign(new Error("Bad Request"), {
      data: { error: { code: "context_length_exceeded" } },
    });
    expect(isContextOverflowError(apiErr)).toBe(true);
  });

  it("classifies a code wrapped in error.cause (RetryError shape)", () => {
    const inner = Object.assign(new Error("Bad Request"), {
      data: { error: { code: "context_length_exceeded" } },
    });
    const wrapped = Object.assign(new Error("Failed after 3 attempts"), {
      cause: inner,
    });
    expect(isContextOverflowError(wrapped)).toBe(true);
  });

  it("scans the raw responseBody when the message is generic", () => {
    const apiErr = Object.assign(new Error("Bad Request"), {
      responseBody: '{"error":{"message":"prompt is too long: 250000 tokens"}}',
    });
    expect(isContextOverflowError(apiErr)).toBe(true);
  });

  it("ignores non-overflow structured codes", () => {
    const apiErr = Object.assign(new Error("Bad Request"), {
      data: { error: { code: "rate_limit_exceeded" } },
    });
    expect(isContextOverflowError(apiErr)).toBe(false);
  });
});

describe("durable compaction summary slicing", () => {
  const summary = (text: string) => ({
    role: "user",
    content: `${COMPACTION_SUMMARY_PREFIX}\n${text}\n[END COMPACTION]`,
  });

  it("recognizes summary messages by prefix", () => {
    expect(isCompactionSummaryMessage(summary("s").content)).toBe(true);
    expect(isCompactionSummaryMessage("regular text")).toBe(false);
    expect(isCompactionSummaryMessage(null)).toBe(false);
  });

  it("slices model history from the LAST summary (reload re-expansion fix)", () => {
    const messages = [
      { role: "user", content: "old turn 1" },
      { role: "assistant", content: "old reply 1" },
      summary("first compaction"),
      { role: "user", content: "mid turn" },
      { role: "assistant", content: "mid reply" },
      summary("second compaction"),
      { role: "user", content: "recent turn" },
      { role: "assistant", content: "recent reply" },
    ];
    const sliced = sliceFromLastCompactionSummary(messages);
    expect(sliced).toHaveLength(3);
    expect(sliced[0].content).toContain("second compaction");
    expect(sliced[2].content).toBe("recent reply");
  });

  it("returns input unchanged when no summary exists", () => {
    const messages = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    expect(sliceFromLastCompactionSummary(messages)).toBe(messages);
  });

  it("ignores assistant messages that quote the marker", () => {
    const messages = [
      { role: "assistant", content: `${COMPACTION_SUMMARY_PREFIX} quoted in reply` },
      { role: "user", content: "q" },
    ];
    expect(sliceFromLastCompactionSummary(messages)).toBe(messages);
  });
});

describe("overflow feedback clamp", () => {
  it("lowers the effective context limit after reported overflows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })) as unknown as typeof fetch,
    );
    const { resolveModelContextLimit, reportContextOverflowForModel } =
      await import("@/lib/context/resolve-model-context-limit");

    const model = { provider: "groq", name: "llama-3.3-70b" } as never;
    const settings = {} as never;

    const before = await resolveModelContextLimit(model, settings);
    reportContextOverflowForModel(model);
    const after = await resolveModelContextLimit(model, settings);
    expect(after.tierLimit).toBeLessThan(before.tierLimit);

    // Compounds, but never below the 40% floor.
    for (let i = 0; i < 20; i++) reportContextOverflowForModel(model);
    const floored = await resolveModelContextLimit(model, settings);
    expect(floored.tierLimit).toBeGreaterThanOrEqual(
      Math.floor(before.tierLimit * 0.39),
    );
    vi.unstubAllGlobals();
  });
});
