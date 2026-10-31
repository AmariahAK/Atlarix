import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * 0j: a long build turn ends its round at the compaction point.
 *
 * The mid-turn guard (`roundShouldEndForCompaction` in the round's `stopWhen`)
 * ends the round once the provider's input count passes `compactionLimit`
 * (0.75 x the working window). The bug: `compactionLimit` was dropped in the
 * `simpleStreamText` wrapper in build-branch.ts, so the guard read `undefined`
 * and never fired — a session sat at 98% of the window, re-sending it all on
 * every step. This drives a build turn where the provider reports past the
 * point and asserts the round ENDS there (a second round starts) instead of
 * running on in the same round.
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: { "src/x.ts": "export const x = 1;\n" },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("a long build turn ends its round at the compaction point", () => {
  it("ends the round once the provider reports past the point", async () => {
    ctx.server.register(
      scenario("compaction-round-end")
        // Under the point: the round keeps going.
        .toolCall(
          "plan",
          { operation: "write", title: "T", content: "1. [ ] a\n" },
          { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        )
        // Over the point: the round must END here, not run on.
        .toolCall(
          "plan",
          { operation: "write", title: "T", content: "1. [ ] b\n" },
          { prompt_tokens: 1_000_000, completion_tokens: 20, total_tokens: 1_000_020 },
        )
        .text("All done.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=compaction-round-end Do the thing.",
      mode: "build",
      timeoutMs: 30_000,
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    // The round ended at the point, so the turn loop started a SECOND round
    // (the "responding" phase fires once per round). Without the fix the
    // stopWhen never fires and the whole turn is ONE round.
    const responding = fakeIpc
      .sentOn("chat:stream:phase")
      .filter((s) => s.payload?.phase === "responding").length;
    expect(responding, "expected the round to end and a second round to start").toBeGreaterThanOrEqual(2);
  });
});
