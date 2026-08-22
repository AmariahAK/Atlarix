import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * A provider error delivered as a SUCCESSFUL finish, end to end.
 *
 * The gateway answers HTTP 200 with a complete, well-formed stream whose
 * `finish_reason` is `"network_error"`. Nothing at the transport layer is wrong,
 * so before the rawFinishReason guard nothing threw: the SDK mapped the
 * unrecognized value to "unknown", the turn ended on its structural yield proxy,
 * and the user got an answer that stopped mid-word with no error anywhere. The
 * failure mode is silence, which is why it needs a real turn to pin rather than
 * a unit test — the unit tests can only prove that something throws.
 *
 * What this asserts: the turn RECOVERS. The guard throws, the existing
 * mid-stream backoff arms, the round is re-issued, and the scripted good
 * response lands — no surfaced error, a clean terminal, and the truncated
 * partial replaced by the real answer.
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

describe("a provider error in the finish reason", () => {
  it("retries and finishes cleanly instead of truncating in silence", async () => {
    ctx.server.register(
      scenario("finish-err")
        // 200 + clean stream + `finish_reason: "network_error"`.
        .finishReasonError("network_error", "Partial answ")
        .text("Recovered and finished.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const turn = await runTurn(ctx, {
      chatId,
      prompt: "sc=finish-err Summarize src/x.ts.",
      mode: "ask",
      timeoutMs: 30_000,
    });

    // The whole point: the user is not shown a failure, because it recovered.
    expectNoStreamError(turn.fakeIpc.sends, chatId);
    expectStreamEnded(turn.fakeIpc.sends, chatId);

    // It actually retried — two requests, not one.
    expect(ctx.server.requestsFor("finish-err").length).toBeGreaterThanOrEqual(2);

    // And the real answer arrived. Without the guard this assertion is what
    // fails: the turn ends after the first response and never asks again.
    expect(JSON.stringify(turn.fakeIpc.sends)).toContain("Recovered and finished.");
  });

  // A provider that reports an ordinary reason must be untouched — a false
  // positive here would retry a COMPLETED answer, doubling cost and re-running
  // whatever tools it had called.
  it("does not retry an ordinary finish", async () => {
    ctx.server.register(
      scenario("finish-ok").text("Answered once.").repeatLast().build(),
    );

    const chatId = await ctx.newChat();
    const turn = await runTurn(ctx, {
      chatId,
      prompt: "sc=finish-ok Summarize src/x.ts.",
      mode: "ask",
      timeoutMs: 30_000,
    });

    expectNoStreamError(turn.fakeIpc.sends, chatId);
    expect(ctx.server.requestsFor("finish-ok").length).toBe(1);
  });
});
