import { describe, expect, it, vi } from "vitest";
import type { CoreMessage } from "../core/client";
import { compactionBudgets, estimateMessages } from "./budget";
import {
  COMPACTION_MARKER_PREFIX,
  COMPACTION_MARKER_SUFFIX,
  COMPACTION_RECOVERY_HINT,
  TOOL_OUTPUT_MAX_CHARS,
  compactConversation,
  compactionMarker,
  extractPriorSummary,
  isCompactionMarker,
  markerBody,
  markerGeneration,
  microcompactStaleToolOutputs,
  pruneToolOutputs,
  renderForSummary,
  selectMessagesForCompaction,
} from "./compact";

const user = (text: string): CoreMessage => ({ role: "user", content: text });

const assistantCall = (id: string, name = "read_page"): CoreMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [
    { id, type: "function", function: { name, arguments: '{"tab_id":1}' } },
  ],
});

const toolResult = (id: string, size: number): CoreMessage => ({
  role: "tool",
  tool_call_id: id,
  content: "p".repeat(size),
});

/** Find a tool result whose content mentions `needle`, narrowed to the role. */
function findToolResult(messages: CoreMessage[], needle: string) {
  return messages.find(
    (m): m is Extract<CoreMessage, { role: "tool" }> =>
      m.role === "tool" && m.content.includes(needle),
  );
}

/** A conversation of N read-a-page turns, each with a big result. */
function pageReadingSession(turns: number, resultChars = 40_000): CoreMessage[] {
  const out: CoreMessage[] = [];
  for (let i = 0; i < turns; i++) {
    out.push(user(`read page ${i}`));
    out.push(assistantCall(`call_${i}`));
    out.push(toolResult(`call_${i}`, resultChars));
    out.push({ role: "assistant", content: `page ${i} says things` });
  }
  return out;
}

/**
 * THE WIRE-FORMAT INVARIANT, and the one this shape can break where the desktop
 * cannot.
 *
 * The OpenAI format requires every assistant `tool_calls` entry to be answered
 * by a `tool` message with a matching id, and forbids a `tool` message whose
 * call is absent. A provider answers either mistake with a 400 that names
 * neither the message nor the reason, so this is asserted structurally rather
 * than hoped for.
 */
function assertToolPairsIntact(messages: CoreMessage[]): void {
  const answered = new Set<string>();
  const called = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const c of m.tool_calls ?? []) called.add(c.id);
    }
    if (m.role === "tool") {
      expect(
        called.has(m.tool_call_id),
        `tool result ${m.tool_call_id} has no preceding call`,
      ).toBe(true);
      answered.add(m.tool_call_id);
    }
  }
  for (const id of called) {
    expect(answered.has(id), `call ${id} was never answered`).toBe(true);
  }
}

describe("the marker", () => {
  it("round-trips a summary, its generation and the recovery hint", () => {
    const marker = compactionMarker("## Goal\n- buy a kettle", 3);
    expect(isCompactionMarker(marker)).toBe(true);
    const content = marker.content as string;
    expect(content.startsWith(COMPACTION_MARKER_PREFIX)).toBe(true);
    expect(content).toContain("gen=3");
    expect(markerBody(content)).toBe("## Goal\n- buy a kettle");
    expect(markerGeneration(content)).toBe(3);
  });

  it("puts the recovery hint AFTER the suffix, so it is never re-summarised", () => {
    // `extractPriorSummary` cuts at the last suffix. Inside the body, the hint
    // would be folded into generation N+1 as though the user had said it — and
    // a summary that contains instructions to itself degrades every pass.
    const content = compactionMarker("body", 1).content as string;
    expect(content.indexOf(COMPACTION_RECOVERY_HINT)).toBeGreaterThan(
      content.indexOf(COMPACTION_MARKER_SUFFIX),
    );
    const { prior } = extractPriorSummary([compactionMarker("body", 1)]);
    expect(prior?.summaryText).toBe("body");
    expect(prior?.summaryText).not.toContain("recall");
  });

  it("reads a marker with no generation as generation 1", () => {
    const legacy: CoreMessage = {
      role: "user",
      content: `${COMPACTION_MARKER_PREFIX}\nold body\n${COMPACTION_MARKER_SUFFIX}`,
    };
    expect(extractPriorSummary([legacy]).prior?.generation).toBe(1);
  });

  it("takes the marker OUT of what gets summarised", () => {
    // Left inline it is flattened and clipped like any other message, so
    // generation 3 compresses a structureless read of generation 2.
    const history = [compactionMarker("prior", 1), user("next question")];
    const { prior, rest } = extractPriorSummary(history);
    expect(prior?.summaryText).toBe("prior");
    expect(rest.map((m) => m.content)).toEqual(["next question"]);
  });

  it("is not fooled by an assistant quoting the marker back", () => {
    const echo: CoreMessage = {
      role: "assistant",
      content: `${COMPACTION_MARKER_PREFIX} gen=9\nnot a real summary`,
    };
    expect(isCompactionMarker(echo)).toBe(false);
    expect(extractPriorSummary([echo]).prior).toBeNull();
  });
});

describe("microcompact", () => {
  it("replaces stale tool results but never removes the message", () => {
    // Removing one orphans its assistant call and the next request is malformed.
    const history = pageReadingSession(4);
    const out = microcompactStaleToolOutputs(history, 2_000);
    expect(out.tokensDropped).toBeGreaterThan(0);
    expect(out.messages).toHaveLength(history.length);
    assertToolPairsIntact(out.messages);
  });

  it("protects a token budget, not a turn count", () => {
    // A session of two turns and 41,000 tokens is what broke the turn-count
    // version: everything was "recent", so it did nothing at all.
    const history = pageReadingSession(2, 80_000);
    const out = microcompactStaleToolOutputs(history, 2_000);
    expect(out.tokensDropped).toBeGreaterThan(20_000);
  });

  it("leaves the newest results alone", () => {
    const history = pageReadingSession(3, 4_000);
    const out = microcompactStaleToolOutputs(history, 1_000);
    const results = out.messages.filter((m) => m.role === "tool");
    expect(results[results.length - 1].content).not.toContain("omitted");
  });

  it("does not tell the model to read the page again", () => {
    // That exact wording drove a re-read loop on the desktop: the model obeyed
    // the marker, produced a fresh result, and the next pass dropped that too.
    const out = microcompactStaleToolOutputs(pageReadingSession(3), 100);
    const dropped = findToolResult(out.messages, "omitted");
    expect(dropped?.content).not.toMatch(/read .* again|re-read|call the tool/i);
  });

  it("touches nothing but tool results", () => {
    const history = pageReadingSession(3);
    const out = microcompactStaleToolOutputs(history, 0);
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === "tool") continue;
      expect(out.messages[i]).toEqual(history[i]);
    }
  });
});

describe("prune", () => {
  it("clips to the head of a result rather than dropping it", () => {
    const history = pageReadingSession(4);
    const out = pruneToolOutputs(history, 1_000);
    const clipped = findToolResult(out.messages, "clipped");
    expect(clipped).toBeDefined();
    // The marker plus the kept head — recognisable, not reasonable-from.
    expect(clipped?.content).toContain("p".repeat(100));
    expect(clipped?.content.length).toBeLessThan(TOOL_OUTPUT_MAX_CHARS + 300);
    assertToolPairsIntact(out.messages);
  });

  it("says what is missing and how to get it back", () => {
    // A truncated result with no marker is worse than no result: the model
    // reads half a page as the whole page.
    const out = pruneToolOutputs(pageReadingSession(3), 100);
    expect(findToolResult(out.messages, "clipped")?.content).toContain("recall");
  });

  it("does not re-clip what microcompact already dropped", () => {
    // Double-marking produces "[omitted] [clipped] [omitted]" nesting and
    // charges tokens for saying nothing three times.
    const micro = microcompactStaleToolOutputs(pageReadingSession(4), 100);
    const out = pruneToolOutputs(micro.messages, 100);
    for (const m of out.messages) {
      if (m.role !== "tool") continue;
      expect(m.content).not.toMatch(/omitted.*clipped/s);
    }
  });

  it("leaves a short result alone rather than growing it", () => {
    const history: CoreMessage[] = [
      user("q"),
      assistantCall("c1"),
      { role: "tool", tool_call_id: "c1", content: "tiny" },
    ];
    expect(pruneToolOutputs(history, 0).messages[2].content).toBe("tiny");
  });
});

describe("selecting the head", () => {
  it("never starts the tail on a tool result", () => {
    // THE 400 THIS PREVENTS. A tail beginning with a tool result is a result
    // whose call is on the other side of the summary.
    for (const budget of [1, 50, 500, 5_000, 50_000]) {
      const { tail } = selectMessagesForCompaction(
        pageReadingSession(6, 8_000),
        budget,
      );
      if (tail.length > 0) expect(tail[0].role).not.toBe("tool");
    }
  });

  it("keeps head and tail complete and in order", () => {
    const history = pageReadingSession(5, 8_000);
    const { head, tail } = selectMessagesForCompaction(history, 20_000);
    expect([...head, ...tail]).toEqual(history);
  });

  it("protects the last user message even when the newest turn is enormous", () => {
    // The desktop's earlier version protected NOTHING here, which made the head
    // the whole conversation and let the caller refuse — so a message was
    // untouchable purely for being recent, at any fill level.
    const history = [
      user("first"),
      { role: "assistant" as const, content: "a" },
      user("second"),
      assistantCall("c"),
      toolResult("c", 400_000),
    ];
    const { head, tail } = selectMessagesForCompaction(history, 4_000);
    expect(head.length).toBeGreaterThan(0);
    expect(tail[0].content).toBe("second");
  });

  it("protects more when there is more budget", () => {
    const history = pageReadingSession(8, 2_000);
    const small = selectMessagesForCompaction(history, 4_000).tail.length;
    const large = selectMessagesForCompaction(history, 400_000).tail.length;
    expect(large).toBeGreaterThanOrEqual(small);
  });
});

describe("rendering the head", () => {
  it("renders a tool call as a line rather than a message", () => {
    const text = renderForSummary([
      user("open it"),
      assistantCall("c1", "open_tab"),
      toolResult("c1", 20),
    ]);
    expect(text).toContain("user: open it");
    expect(text).toContain("assistant called open_tab");
    expect(text).toContain("tool result:");
  });
});

describe("compactConversation", () => {
  const summarise = vi.fn(
    async (_messages: CoreMessage[], _signal?: AbortSignal) =>
      "## Goal\n- read six pages",
  );

  const run = (messages: CoreMessage[], usable: number, over = {}) =>
    compactConversation({
      messages,
      overheadTokens: 2_500,
      usable,
      summarise,
      ...over,
    });

  it("does nothing at all when the conversation fits", async () => {
    summarise.mockClear();
    const history = [user("hello")];
    const out = await run(history, 100_000);
    expect(out.changed).toBe(false);
    expect(out.messages).toBe(history);
    expect(summarise).not.toHaveBeenCalled();
  });

  it("gets back under budget WITHOUT a model call when it can", async () => {
    // The cheapest-first order is the point. Tool results are the bulk and they
    // are regenerable; paying for a summary before trying to drop them is
    // buying the expensive answer first.
    summarise.mockClear();
    const history = pageReadingSession(6, 40_000);
    const out = await run(history, 20_000);
    expect(out.summarised).toBe(false);
    expect(summarise).not.toHaveBeenCalled();
    expect(out.afterTokens).toBeLessThanOrEqual(20_000);
    expect(out.steps.join(" ")).toMatch(/dropped|clipped/);
    assertToolPairsIntact(out.messages);
  });

  it("summarises when dropping and clipping were not enough", async () => {
    summarise.mockClear();
    // Bulk in USER messages, which neither cheap step may touch — they are the
    // one part of a conversation that cannot be regenerated.
    const history: CoreMessage[] = [];
    for (let i = 0; i < 12; i++) {
      history.push(user("q".repeat(20_000)));
      history.push({ role: "assistant", content: "a".repeat(20_000) });
    }
    const out = await run(history, 20_000);
    expect(out.summarised).toBe(true);
    expect(summarise).toHaveBeenCalledOnce();
    expect(isCompactionMarker(out.messages[0])).toBe(true);
    expect(out.afterTokens).toBeLessThan(out.beforeTokens);
    assertToolPairsIntact(out.messages);
  });

  it("folds the previous summary forward as a labelled prior", async () => {
    summarise.mockClear();
    const history: CoreMessage[] = [compactionMarker("earlier findings", 1)];
    for (let i = 0; i < 12; i++) {
      history.push(user("q".repeat(20_000)));
      history.push({ role: "assistant", content: "a".repeat(20_000) });
    }
    const out = await run(history, 20_000);
    const sent = summarise.mock.calls[0][0];
    expect(sent[1].content).toContain("PRIOR SUMMARY (generation 1)");
    expect(sent[1].content).toContain("earlier findings");
    // And the new marker is the next generation, not a restart at 1.
    expect(markerGeneration(out.messages[0].content as string)).toBe(2);
  });

  it("keeps the cheap steps' work when the summariser fails", async () => {
    // One recoverable failure must not become two. The turn continues with a
    // conversation that is smaller than it was.
    const failing = vi.fn(async () => {
      throw new Error("network error");
    });
    const history = pageReadingSession(20, 40_000);
    const out = await compactConversation({
      messages: history,
      overheadTokens: 2_500,
      usable: 5_000,
      summarise: failing,
    });
    expect(out.summarised).toBe(false);
    expect(out.afterTokens).toBeLessThan(out.beforeTokens);
    assertToolPairsIntact(out.messages);
  });

  it("refuses to summarise a history too small to be worth the round trip", async () => {
    summarise.mockClear();
    // Over budget only because the overhead is enormous. Deleting the user's
    // words here frees almost nothing and costs a model call to do it.
    const out = await compactConversation({
      messages: [user("a short question")],
      overheadTokens: 50_000,
      usable: 10_000,
      summarise,
    });
    expect(summarise).not.toHaveBeenCalled();
    expect(out.summarised).toBe(false);
  });

  it("reports what it did, in the order it did it", async () => {
    summarise.mockClear();
    const out = await run(pageReadingSession(10, 40_000), 12_000);
    expect(out.steps.length).toBeGreaterThan(0);
    expect(out.beforeTokens).toBeGreaterThan(out.afterTokens);
  });

  it("leaves a conversation it cannot help alone rather than emptying it", async () => {
    summarise.mockClear();
    const history = [user("one question")];
    const out = await compactConversation({
      messages: history,
      overheadTokens: 0,
      usable: 1,
      summarise,
    });
    expect(out.messages.length).toBeGreaterThan(0);
  });
});

describe("the budgets it runs against", () => {
  it("never protects more than the budget it is protecting within", () => {
    for (const usable of [1_000, 8_000, 100_000, 600_000]) {
      const b = compactionBudgets(usable);
      expect(b.preserveRecent).toBeLessThanOrEqual(usable);
      expect(b.microcompactKeepTokens).toBeLessThanOrEqual(usable);
      expect(b.pruneProtectRecent).toBeLessThanOrEqual(usable);
    }
  });

  it("actually shrinks a real page-reading session", () => {
    const history = pageReadingSession(6, 40_000);
    const before = estimateMessages(history);
    const after = estimateMessages(
      microcompactStaleToolOutputs(history, compactionBudgets(20_000).microcompactKeepTokens)
        .messages,
    );
    expect(after).toBeLessThan(before / 2);
  });
});
