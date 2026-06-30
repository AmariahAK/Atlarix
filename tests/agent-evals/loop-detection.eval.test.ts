import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectStreamEnded } from "../infra/assert";

/**
 * Eval 3 (Tier 4): loop-detection → abort — Build mode.
 *
 * The scripted model calls the SAME read_file on the SAME path forever
 * (repeatLast). The agentic repetition guard (read threshold 6/10) must
 * surface a loop_detected activity and the turn must terminate in bounded
 * time/requests — not run to the 30-minute cap.
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: { "src/loop.ts": "export const loop = true;\n" },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("loop detection (build mode)", () => {
  it("aborts a model that repeats the same tool call", async () => {
    ctx.server.register(
      scenario("loop-read")
        .toolCall("read_file", { path: "src/loop.ts" })
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=loop-read What is in src/loop.ts?",
      mode: "build",
      timeoutMs: 20_000,
    });

    // Stage 5: the doom-loop (3 consecutive byte-identical calls) fires the
    // graceful force-finish — surfaced as a "wrapping up" activity, NOT the old
    // sliding-window `loop_detected` nudge.
    const activities = fakeIpc
      .sentOn("chat:activity")
      .map((s) => s.payload?.type);
    expect(activities).toContain("loop_repetition_aborted");
    expect(activities).not.toContain("loop_detected");

    // …and the turn terminated in bounded requests (not the 30-min cap).
    const requestCount = ctx.server.requestsFor("loop-read").length;
    expect(requestCount).toBeLessThan(30);

    expectStreamEnded(fakeIpc.sends, chatId);
  }, 30_000);
});
