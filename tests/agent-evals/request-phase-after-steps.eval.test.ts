import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import {
  expectNoStreamError,
  expectStreamEnded,
  expectToolSequence,
} from "../infra/assert";

/**
 * A request-phase network reset AFTER the round has already completed a step.
 *
 * `request-phase-reset.eval` covers the reset on the round's FIRST request, where
 * the SDK throws a synthetic `NoOutputGeneratedError`. Here a tool step has
 * finished first, and the SDK behaves differently: it does not throw at all. The
 * failing request's error goes to `onError`, `finishReason` resolves, and the
 * round looks finished. Only the catch in `round-retry.ts` ever read the recorded
 * transport error, so the turn simply stopped — no answer, no error card.
 *
 * Observed on Windows, 14.52.2, Atlarix Auto: two steps done, then step 3 "Cannot
 * connect to API", then silence.
 *
 * The fix resumes from the completed steps rather than restarting the round, so
 * the tool must run ONCE: a restart re-runs every tool call, which is also what
 * duplicated the tool rows in that session.
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

describe("a network reset after a completed step", () => {
  it("resumes from the completed step and answers, instead of stopping silently", async () => {
    ctx.server.register(
      scenario("steps-reset")
        .toolCall("read_file", { path: "src/x.ts" })
        .socketResetBeforeHeaders()
        .text("Recovered after the reset.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const turn = await runTurn(ctx, {
      chatId,
      prompt: "sc=steps-reset Summarize src/x.ts.",
      mode: "ask",
      timeoutMs: 60_000,
    });

    expectNoStreamError(turn.fakeIpc.sends, chatId);
    expectStreamEnded(turn.fakeIpc.sends, chatId);

    // The answer landed. Before the fix the turn ended right after the reset.
    expect(JSON.stringify(turn.fakeIpc.sends)).toContain(
      "Recovered after the reset.",
    );

    // Resumed, not restarted: the tool ran once, and the rendered turn was kept
    // (a restart sends reset-partial and re-runs the read).
    expectToolSequence(turn.fakeIpc.sends, ["read_file"]);
    expect(turn.fakeIpc.sentOn("chat:stream:reset-partial")).toHaveLength(0);
  });
});
