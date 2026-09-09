import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Compaction must work on a SMALL window. It did not, and every step had its own
 * reason not to.
 *
 * Measured in the packaged app on 2026-08-31 against a real session: 4 messages,
 * ~41,000 tokens, against a 16,000-token cap set via `tokenBudgetOverrides`. The
 * meter read 35,223 / 16.0k and nothing happened — no summary, no marker, turn
 * after turn. Each step compared against an ABSOLUTE token constant tuned for a
 * large window and opted itself out:
 *
 *   microcompact   keep last 3 TURNS      the session had 2 → no-op
 *   prune          PRUNE_MINIMUM 20,000   protected MORE than the whole budget,
 *                                         so a 19,000-token message stayed whole
 *   prune (accept) tokensPruned > 20,000  would have DISCARDED a 15,000-token win
 *   summarise      count precondition     impossible at 4 messages
 *   tail select    last 2 TURNS by count  newest turn was 22,348 tokens on its
 *                                         own, so nothing fit and everything
 *                                         became head → refused
 *
 * This file reproduces that shape and asserts the outcome that matters: it gets
 * under budget. Each individual fix is mutation-tested against these cases.
 */

const sessionHandlers = vi.hoisted(() => ({
  persistSpy: vi.fn(async (_s: string, _c: string, _o: object) => {}),
  resolveSpy: vi.fn(async () => "resolved-session" as string | null),
}));
vi.mock("@/ipc/handlers/workspace_session_handlers", () => ({
  resolveOrBindWorkspaceSessionForStream: sessionHandlers.resolveSpy,
  persistWorkspaceSessionUserMessage: sessionHandlers.persistSpy,
}));

const llm = vi.hoisted(() => ({
  generateText: vi.fn(async (_o: { system?: string }) => ({
    text: "## Goal\n- Explore the telios monorepo\n## Critical Context\n- three subprojects",
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  })),
}));
vi.mock("ai", () => ({ generateText: llm.generateText }));
vi.mock("@/main/settings", () => ({ readSettings: () => ({}) }));
vi.mock("@/lib/summarization_model", () => ({
  getCompactionSummarizationModel: async () => ({ provider: "t", name: "m" }),
}));
vi.mock("@/ipc/utils/get_model_client", () => ({
  getModelClient: async () => ({ modelClient: { model: {} } }),
}));

import {
  runSteppedCompaction,
  countMessagesTokens,
  isCompactionSummaryMessage,
  pruneToolOutputs,
} from "@/lib/context/compaction";
import {
  compactionBudgets,
  usableContextBudget,
} from "@/lib/context/mid-loop-threshold";

/**
 * A tool result the pruner and microcompact both recognise.
 *
 * Realistic prose, NOT `"x".repeat(n)`: a long run of one character is a couple of
 * BPE tokens however many bytes it is, so a 70,000-char fixture built that way
 * scores ~300 tokens and the whole test measures nothing. Sized in TOKENS for
 * that reason.
 */
const toolResult = (label: string, tokens: number) => {
  const body = Array.from(
    { length: tokens },
    (_, i) => `line${i} const value${i} = compute(${i});`,
  ).join("\n");
  return `<atlarix-tool-result tool="read_file">${label}\n${body}</atlarix-tool-result>`;
};

/**
 * The owner's session: two user messages, two enormous assistant turns that are
 * ~93% inlined tool-result XML (76,003 and 89,394 chars in the original).
 */
function ownersSession() {
  return [
    {
      id: 1,
      role: "user",
      content: "hey how are you, could u tell me about this project in depth",
    },
    { id: 2, role: "assistant", content: toolResult("explore-1", 1_800) },
    { id: 3, role: "user", content: "continue" },
    { id: 4, role: "assistant", content: toolResult("explore-2", 2_200) },
  ];
}

// The owner's real configuration: a 16,000 cap on a reasoning-capable model, so
// the reply reserve is clamped and `usable` lands at 9,600.
const CAP = 16_000;
const USABLE = usableContextBudget({
  contextWindow: CAP,
  maxOutputTokens: 32_000,
});

describe("a small window is still a workable window", () => {
  beforeEach(() => {
    sessionHandlers.persistSpy.mockClear();
    sessionHandlers.resolveSpy.mockClear();
    sessionHandlers.resolveSpy.mockResolvedValue("resolved-session");
    llm.generateText.mockClear();
  });

  it("the fixture really is the problem shape", () => {
    const msgs = ownersSession();
    const total = countMessagesTokens(msgs);
    // Far over the cap, and dominated by two messages.
    expect(total).toBeGreaterThan(CAP * 2);
    expect(USABLE).toBe(9_600);
    // The newest assistant turn alone exceeds everything we may protect.
    const newest = countMessagesTokens([{ content: msgs[3]!.content }]);
    expect(newest).toBeGreaterThan(compactionBudgets(USABLE).preserveRecent);
  });

  it("COMPACTS — the whole point, and what did not happen before", () => {
    const msgs = ownersSession();
    const before = countMessagesTokens(msgs);

    return runSteppedCompaction(msgs, USABLE, "test", {
      chatId: -42,
      workspaceSessionId: "s1",
    }).then((out) => {
      expect(out.compactionApplied).toBe(true);
      const after = countMessagesTokens(out.modelContext);
      expect(after).toBeLessThan(before);
      // The outcome the owner was looking for: under the budget afterwards.
      expect(after).toBeLessThanOrEqual(USABLE);
    });
  });

  it("PRUNER: protects only what the budget allows, not a fixed 20,000", () => {
    // Driven directly, because an end-to-end fixture can be rescued by a later
    // step and then proves nothing about this one. `minKeep` used to be
    // `max(20_000, protect)`, so on any budget under 20,000 the pruner protected
    // everything it saw and freed nothing.
    // Sized so the WHOLE history of tool output is under 20,000 tokens. That is
    // the case the old floor got wrong: it protected 20,000 tokens' worth, which
    // was everything here, so it freed nothing on any budget smaller than that.
    const msgs = [
      { id: 1, role: "user", content: "go" },
      { id: 2, role: "assistant", content: toolResult("old", 170) },
      { id: 3, role: "user", content: "more" },
      { id: 4, role: "assistant", content: toolResult("new", 170) },
    ];
    const toolTokens = countMessagesTokens([
      { content: msgs[1]!.content },
      { content: msgs[3]!.content },
    ]);
    expect(toolTokens).toBeLessThan(20_000);

    const protect = compactionBudgets(USABLE).pruneProtectRecent;
    expect(protect).toBeLessThan(toolTokens); // there IS something to reclaim
    const { tokensPruned } = pruneToolOutputs(msgs, protect);
    expect(tokensPruned).toBeGreaterThan(0);
  });

  it("PRUNER RESULT: a reduction smaller than 20,000 tokens is kept, not discarded", async () => {
    // `if (tokensPruned > PRUNE_MINIMUM_TOKENS)` meant a 15,000-token win on a
    // 16,000-token budget was thrown away for being too small.
    // Sized into the narrow band where PRUNE is the operative step: the tool
    // output fits microcompact's keep-window (so it drops nothing) but exceeds the
    // pruner's protection budget (so it trims). Plain prose makes up the rest of
    // the fill, since neither step will touch that. If the pruner's result is
    // discarded for being under 20,000 tokens, nothing else rescues it and the
    // strategy falls back to "none" — which is exactly what the assertion catches.
    const b = compactionBudgets(USABLE);
    expect(b.pruneProtectRecent).toBeLessThan(b.microcompactKeepTokens);
    const filler = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `narrative sentence ${i} explaining things.`,
      ).join(" ");
    // Measured: toolResult(120) ≈ 1,344 tok, so the pair ≈ 2,688 — inside
    // microcompact's 3,360 keep-window, past the pruner's 2,400 protection. The
    // 4,416-token filler pushes the total past the 5,760 trigger without giving
    // either step anything else to reclaim.
    const msgs = [
      { id: 1, role: "user", content: filler(700) },
      { id: 2, role: "assistant", content: toolResult("old", 120) },
      { id: 3, role: "user", content: "and again" },
      { id: 4, role: "assistant", content: toolResult("new", 120) },
    ];
    const before = countMessagesTokens(msgs);
    const out = await runSteppedCompaction(msgs, USABLE, "test", {
      chatId: -42,
    });
    const freed = before - countMessagesTokens(out.modelContext);

    expect(out.strategy).toBe("pruned");
    expect(freed).toBeGreaterThan(0);
    expect(freed).toBeLessThan(20_000); // exactly the size the old gate rejected
    expect(llm.generateText).not.toHaveBeenCalled(); // no provider call needed
  });

  it("TAIL: an oversized newest turn falls into the head instead of blocking everything", async () => {
    // PLAIN PROSE, so neither microcompact nor the pruner can touch it — only the
    // summariser can, which forces tail selection to actually run. With the old
    // count-based rule the newest turn could not fit the protection budget, no
    // split fit either, nothing was protected, head became everything, and the
    // count precondition then refused. Nothing compacted at any fill level.
    const prose = (label: string, n: number) =>
      Array.from(
        { length: n },
        (_, i) => `${label} sentence ${i} about the code.`,
      ).join(" ");
    const msgs = [
      { id: 1, role: "user", content: "explain the project" },
      { id: 2, role: "assistant", content: prose("first", 1_500) },
      { id: 3, role: "user", content: "continue" },
      { id: 4, role: "assistant", content: prose("second", 2_500) },
    ];
    const before = countMessagesTokens(msgs);
    const out = await runSteppedCompaction(msgs, USABLE, "test", {
      chatId: -42,
      workspaceSessionId: "s1",
    });

    expect(out.strategy).toBe("summarized");
    expect(countMessagesTokens(out.modelContext)).toBeLessThan(before);
    // The last USER message survives verbatim — never an empty protected region,
    // or we would be summarising the request being answered.
    expect(
      out.modelContext.some((m) => (m.content ?? "").includes("continue")),
    ).toBe(true);
  });

  it("still summarises and persists a durable marker when it has to", () => {
    return runSteppedCompaction(ownersSession(), USABLE, "test", {
      chatId: -42,
      workspaceSessionId: "s1",
    }).then((out) => {
      // The cheap steps may be enough; when they are not, the summary is durable.
      if (out.strategy === "summarized") {
        expect(out.summaryPersisted).toBe(true);
        expect(
          out.modelContext.some((m) => isCompactionSummaryMessage(m.content)),
        ).toBe(true);
      }
      expect(out.compactionApplied).toBe(true);
    });
  });

  it("a LARGE window still behaves — this is not a small-window special case", () => {
    const usableBig = usableContextBudget({
      contextWindow: 1_048_576,
      maxOutputTokens: 32_000,
    });
    const msgs = ownersSession();
    return runSteppedCompaction(msgs, usableBig, "test", { chatId: -42 }).then(
      (out) => {
        // ~41K against ~1M: nothing needs doing, and nothing is spent finding out.
        expect(out.compactionApplied).toBe(false);
        expect(llm.generateText).not.toHaveBeenCalled();
      },
    );
  });
});
