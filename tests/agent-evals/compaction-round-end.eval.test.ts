import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * 0j (REOPENED): the round used to END at the compaction point and then
 * compaction silently declined — the guard read the provider's input count but
 * `runMidLoopCompaction` re-decided from an estimate that omitted the tool
 * schemas, so it stayed "under the point" and the turn kept re-sending the
 * whole conversation (every step became its own round).
 *
 * The fix: the round's `prepareStep` decides from the ONE complete count
 * (system + tool schemas + messages, tool-call args and reasoning priced in
 * full) BEFORE each step, and compacts there, sending the smaller messages.
 * This drives a build turn whose tool work pushes that count past a (deliberately
 * low) compaction point and asserts:
 *   1. compaction RAN — a request to the model carries the in-task summary; and
 *   2. the next request is under the point — the request carrying the summary is
 *      smaller than the largest request before it.
 */

/**
 * Reads per phase. The fake model's window resolves to 128k, so at the lowest LEGAL
 * threshold (0.6 - the settings schema allows 0.6-0.9; a lower value fails
 * validation and the settings fall back to DEFAULTS, i.e. Atlarix Auto, which is
 * why an earlier 0.4 version of this test errored before compaction could run) the
 * point is ~77k. ~10k tokens per read: 7 distinct reads + the prefix cross it on the 7th exactly (the summarizer takes the next scripted reply); after
 * compaction the protected 3 reads + summary sit well under it.
 */
const READ_COUNT = 7;
const SECOND_PHASE_READS = 4;

let ctx: EvalContext;

beforeAll(async () => {
  // ~40 KB of text: one read_file result is ~10k tokens, so 3 protected reads
  // (~30k) + the fixed prefix sits under the low compaction point while the 4th
  // read pushes the estimate over it and lands one big read in the summarised
  // head.
  // DISTINCT files: read_file answers a repeat read of an unchanged file with a
  // short "unchanged" note, so re-reading one file never grows the context.
  const bigText = "word ".repeat(10_000);
  const seedFiles: Record<string, string> = {};
  for (let i = 0; i < 12; i++) seedFiles[`big${i}.txt`] = `${i} ${bigText}`;
  ctx = await setupEvalContext({ seedFiles });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("a long turn compacts mid-round at the compaction point", () => {
  it("compaction runs and the next request is under the point", async () => {
    ctx.server.register(
      (() => {
        const b = scenario("compaction-round-end");
        // Enough tool work to grow the estimate past the point with a non-empty
        // summarisable head (the last 3 exchanges are protected).
        for (let i = 0; i < READ_COUNT; i++) b.toolCall("read_file", { path: `big${i}.txt` });
        return b;
      })()
        // The summarizer's own call, answered with a plain-text summary.
        .text("Earlier work summarized. Task: sc=compaction-round-end Do the thing.")
        // The model's reply on the compacted step.
        .text("All done.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=compaction-round-end Do the thing.",
      mode: "build",
      // The lowest legal point (0.6), so the estimate crosses it mid-turn without
      // scripting hundreds of KB of history.
      settings: {
        aiConfiguration: { contextSummarization: { compactionThreshold: 0.6 } },
      },
      timeoutMs: 60_000,
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const { IN_TASK_SUMMARY_PREFIX } = await import("@/lib/context/compaction");
    const requests = ctx.server.requestsFor("compaction-round-end");

    // 1. Compaction RAN: the summary was produced and sent to the model.
    const withSummary = requests.find((r) =>
      JSON.stringify(r).includes(IN_TASK_SUMMARY_PREFIX),
    );
    expect(
      withSummary,
      "compaction must run and send a summary, not just end the round",
    ).toBeTruthy();

    // 2. The next request is under the point: the request carrying the summary
    //    is smaller than the largest request that preceded it (the older head
    //    collapsed into one summary instead of growing).
    const msgChars = (r: unknown): number =>
      JSON.stringify((r as { messages?: unknown[] })?.messages ?? []).length;
    const idx = requests.indexOf(withSummary!);
    expect(idx, "the compacted request must not be the first").toBeGreaterThan(0);
    const maxBefore = Math.max(
      0,
      ...requests.slice(0, idx).map(msgChars),
    );
    expect(msgChars(withSummary)).toBeLessThan(maxBefore);

    // The model should still have finished cleanly on the compacted step — not
    // re-read the whole file. It answered "All done." and the turn ended.
    expect(fakeIpc.sentOn("chat:stream:phase").filter(
      (s) => s.payload?.phase === "responding",
    ).length).toBeGreaterThanOrEqual(1);
  });

  /**
   * A long turn is ONE round with native tools, so it must compact AGAIN each time
   * it grows back past the point. A once-per-round guard compacted the first time
   * and then let the round grow without bound - the same bug, delayed.
   */
  it("compacts again when the same round grows back past the point", async () => {
    const b = scenario("compaction-round-twice");
    for (let i = 0; i < READ_COUNT; i++) b.toolCall("read_file", { path: `big${i}.txt` });
    b.text("Earlier work summarized. Task: sc=compaction-round-twice Do the long thing.");
    for (let i = 0; i < SECOND_PHASE_READS; i++) b.toolCall("read_file", { path: `big${READ_COUNT + i}.txt` });
    b.text("Earlier work summarized again. Task: sc=compaction-round-twice Do the long thing.");
    ctx.server.register(b.text("All done.").repeatLast().build());

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=compaction-round-twice Do the long thing.",
      mode: "build",
      settings: {
        aiConfiguration: { contextSummarization: { compactionThreshold: 0.6 } },
      },
      timeoutMs: 90_000,
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const { IN_TASK_SUMMARY_PREFIX } = await import("@/lib/context/compaction");
    const requests = ctx.server.requestsFor("compaction-round-twice");
    const msgChars = (r: unknown): number =>
      JSON.stringify((r as { messages?: unknown[] })?.messages ?? []).length;
    const first = requests.findIndex((r) => JSON.stringify(r).includes(IN_TASK_SUMMARY_PREFIX));
    expect(first, "the first compaction must run").toBeGreaterThan(0);
    const maxBefore = Math.max(...requests.slice(0, first).map(msgChars));
    // After the first compaction, four more reads would push a request well past
    // anything sent before it unless the round compacts a second time.
    const later = requests.slice(first + 1).map(msgChars);
    expect(later.length, "the turn must keep working after the first compaction").toBeGreaterThan(0);
    expect(
      Math.max(...later),
      "a request after the first compaction grew past the pre-compaction peak: the round did not compact again",
    ).toBeLessThan(maxBefore);
  });
});
