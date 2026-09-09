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
  extractPriorSummary,
  runSteppedCompaction,
  countMessagesTokens,
} from "@/lib/context/compaction";
import { buildCompactionUserPromptPrefix } from "@/prompts/context_compaction_prompt";

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
    expect(isContextOverflowError(new Error("rate limit exceeded"))).toBe(
      false,
    );
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
      {
        role: "assistant",
        content: `${COMPACTION_SUMMARY_PREFIX} quoted in reply`,
      },
      { role: "user", content: "q" },
    ];
    expect(sliceFromLastCompactionSummary(messages)).toBe(messages);
  });
});

/**
 * The prior-summary chain. `CONTEXT_COMPACTION_SYSTEM` promises to "update the
 * PRIOR SUMMARY, removing stale details" and `buildCompactionUserPromptPrefix`
 * has a branch for it — but nothing ever supplied one (the resolver was a
 * `return null` stub), so the previous summary arrived as an ordinary message
 * and got flattened and cut at 2,000 chars with everything else. These pin the
 * repair: it comes out labelled, whole, and generation-tagged.
 */
describe("compaction summary chaining", () => {
  /** A realistic marker body — the seven sections the compaction prompt asks for. */
  const SECTIONS = [
    "## Goal",
    "## Constraints & Preferences",
    "## Progress",
    "## Key Decisions",
    "## Next Steps",
    "## Critical Context",
    "## Relevant Files",
  ];
  const realisticSummary = SECTIONS.map(
    (h) => `${h}\n- ${h.replace("## ", "")} detail. ${"x".repeat(400)}`,
  ).join("\n\n");

  const marker = (text: string, gen?: number) => ({
    role: "user",
    content: `${COMPACTION_SUMMARY_PREFIX}${gen ? ` gen=${gen}` : ""}\n${text}\n[END COMPACTION]`,
  });

  it("lifts the LAST summary out and returns the rest without it", () => {
    const messages = [
      marker("first pass", 1),
      { role: "user", content: "mid turn" },
      marker("second pass", 2),
      { role: "assistant", content: "recent reply" },
    ];
    const { prior, rest } = extractPriorSummary(messages);
    expect(prior?.summaryText).toBe("second pass");
    expect(prior?.compactionGeneration).toBe(2);
    expect(rest).toHaveLength(3);
    expect(rest.some((m) => m.content.includes("second pass"))).toBe(false);
    // The older marker is left alone — only the newest is lifted.
    expect(rest[0].content).toContain("first pass");
  });

  it("strips the marker wrapper, leaving only the summary body", () => {
    const { prior } = extractPriorSummary([marker(realisticSummary, 3)]);
    expect(prior?.summaryText).toBe(realisticSummary);
    expect(prior?.summaryText).not.toContain(COMPACTION_SUMMARY_PREFIX);
    expect(prior?.summaryText).not.toContain("[END COMPACTION]");
    expect(prior?.summaryText).not.toContain("gen=");
  });

  it("reads a legacy marker (no gen= token) as generation 1", () => {
    const { prior } = extractPriorSummary([marker("older session")]);
    expect(prior?.compactionGeneration).toBe(1);
    expect(prior?.summaryText).toBe("older session");
  });

  it("returns no prior when the history has never been compacted", () => {
    const messages = [{ role: "user", content: "a" }];
    const { prior, rest } = extractPriorSummary(messages);
    expect(prior).toBeNull();
    expect(rest).toBe(messages);
  });

  it("ignores an assistant message that merely quotes the marker", () => {
    const messages = [
      {
        role: "assistant",
        content: `${COMPACTION_SUMMARY_PREFIX} quoted back`,
      },
    ];
    // Same rule sliceFromLastCompactionSummary applies: only user rows count.
    expect(extractPriorSummary(messages).prior).toBeNull();
  });

  /**
   * THE ACTUAL DEFECT. Before the fix the prior summary went through the
   * per-message formatter — `.replace(/\n/g, " ").slice(0, 2000)` — so a
   * seven-section summary reached the next pass as one line, cut off partway
   * through. A test that only asserted "a prior summary was passed" would have
   * gone green against the broken code; these assert it arrives INTACT.
   */
  it("delivers the prior summary to the prompt whole, not flattened or cut at 2,000 chars", () => {
    const { prior } = extractPriorSummary([marker(realisticSummary, 2)]);
    const prompt = buildCompactionUserPromptPrefix(prior ?? undefined);

    expect(realisticSummary.length).toBeGreaterThan(2000); // guards the premise
    for (const heading of SECTIONS) {
      expect(prompt).toContain(heading);
    }
    expect(prompt).toContain("PRIOR SUMMARY (generation 2)");
    // Newlines survive: a flattened summary would have collapsed these.
    expect(prompt).toContain("\n## Relevant Files");
  });

  it("omits the prior-summary section entirely on a first compaction", () => {
    const prompt = buildCompactionUserPromptPrefix(undefined);
    expect(prompt).not.toContain("PRIOR SUMMARY");
  });

  it("keeps a gen=-tagged marker readable by the slicer and the recognizer", () => {
    // Back-compat pin: both match on startsWith, so adding ` gen=N` to the
    // marker line must not break dispatch slicing or any persisted row.
    const tagged = marker("second pass", 2);
    expect(isCompactionSummaryMessage(tagged.content)).toBe(true);

    const sliced = sliceFromLastCompactionSummary([
      { role: "user", content: "ancient" },
      tagged,
      { role: "assistant", content: "after" },
    ]);
    expect(sliced).toHaveLength(2);
    expect(sliced[0].content).toContain("second pass");
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

describe("runSteppedCompaction gates (W6 v14.8.11)", () => {
  const msg = (id: number, role: string, content: string) => ({
    id,
    role,
    content,
  });
  const filler = (n: number) => "word ".repeat(n);

  it("counts message lists per-message (meter scope), not role-joined", () => {
    const tokens = countMessagesTokens([
      { content: "hello world" },
      { content: "" },
      { content: null },
    ]);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBe(countMessagesTokens([{ content: "hello world" }]));
  });

  it("alreadyUsedTokens raises the usage ratio (system prompt + input now count)", async () => {
    const messages = [
      msg(1, "user", filler(2000)),
      msg(2, "assistant", filler(2000)),
    ];
    const historyTokens = countMessagesTokens(messages);
    const tierLimit = historyTokens * 2; // messages-only ratio = 0.5 (< 0.60 gate)
    const withoutOverhead = await runSteppedCompaction(
      messages,
      tierLimit,
      "test-provider",
    );
    expect(withoutOverhead.usageRatio).toBeLessThan(0.6);
    const withOverhead = await runSteppedCompaction(
      messages,
      tierLimit,
      "test-provider",
      {
        alreadyUsedTokens: historyTokens, // + overhead → ratio 1.0
      },
    );
    expect(withOverhead.usageRatio).toBeGreaterThanOrEqual(1);
  });

  it("force below the 8K-history floor returns an honest no-op", async () => {
    const messages = [msg(1, "user", "short"), msg(2, "assistant", "reply")];
    const out = await runSteppedCompaction(messages, 100_000, "test-provider", {
      force: true,
    });
    expect(out.compactionApplied).toBe(false);
    expect(out.strategy).toBe("none");
    expect(out.modelContext).toEqual(messages);
  });

  it("non-forced call below the 60% gate stays a no-op (auto path unchanged)", async () => {
    const messages = [
      msg(1, "user", filler(2000)),
      msg(2, "assistant", filler(2000)),
    ];
    const tierLimit = countMessagesTokens(messages) * 10;
    const out = await runSteppedCompaction(
      messages,
      tierLimit,
      "test-provider",
    );
    expect(out.compactionApplied).toBe(false);
  });
});
