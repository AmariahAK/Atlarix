import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * A network reset in the REQUEST phase, end to end.
 *
 * The distinction from `provider-finish-error.eval.test.ts` is the whole reason this
 * file exists. There, HTTP 200 had already arrived and the throw came from our own
 * code inside `processStreamChunks`, so it propagated normally and the network branch
 * armed. Here the socket dies before a single header: no step completes, and the SDK
 * hands us a SYNTHETIC `NoOutputGeneratedError` instead of the transport error —
 * discarding the `APICallError` entirely, not even as a `cause`.
 *
 * So `isEmptyOutputStreamError` matched first. The round retried twice, one second
 * apart, telling the model it had "produced only internal reasoning" — to a dead
 * socket — and then reported `EmptyModelOutputAfterRetryError`, i.e. "Something went
 * wrong". The 2s/5s/10s network retry that exists for exactly this was unreachable,
 * and because `sentry-ignore-patterns.ts` drops every "no output generated" pattern,
 * none of it produced a single event. It took a hand-read log to find.
 *
 * A mid-stream reset already recovered, which is precisely why the request-phase hole
 * survived. That phase stays covered by `provider-finish-error.eval` rather than here —
 * see the `socket_reset` docblock in `fake-llm-server/scenario.ts` for why neither way
 * of scripting a mid-stream transport fault is usable.
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

describe("a network reset before any response header", () => {
  it("retries as a network error and recovers, instead of blaming the model", async () => {
    ctx.server.register(
      scenario("req-reset")
        .socketResetBeforeHeaders()
        .text("Recovered after the reset.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const turn = await runTurn(ctx, {
      chatId,
      prompt: "sc=req-reset Summarize src/x.ts.",
      mode: "ask",
      timeoutMs: 60_000,
    });

    // The user is shown no failure, because it recovered.
    expectNoStreamError(turn.fakeIpc.sends, chatId);
    expectStreamEnded(turn.fakeIpc.sends, chatId);

    // It retried at all.
    expect(ctx.server.requestsFor("req-reset").length).toBeGreaterThanOrEqual(2);

    // And the real answer landed. Before the fix the turn died here with
    // "Something went wrong — please try again."
    expect(JSON.stringify(turn.fakeIpc.sends)).toContain(
      "Recovered after the reset.",
    );

    /**
     * THE ASSERTION THAT PINS THE ACTUAL BUG, not just the symptom.
     *
     * Retrying and recovering is not enough to prove this is fixed: the
     * empty-output branch ALSO retries, and with one attempt it could have
     * recovered by accident while still being misclassified. What makes it a
     * network retry is `reset-partial` — the empty-output path never sends it,
     * which is why the fallback text it had already painted stayed on screen.
     */
    expect(
      turn.fakeIpc.sentOn("chat:stream:reset-partial").length,
    ).toBeGreaterThan(0);

    // And no "no response" filler was written into a message about to be retried.
    expect(JSON.stringify(turn.fakeIpc.sends)).not.toContain(
      "produced only internal reasoning",
    );
  });

  it("an empty stream is NOT treated as a transport failure", async () => {
    // The other half of the fix: the unwrap must fire only when a transport error
    // was actually recorded, or a model that simply said nothing would burn
    // 2s/5s/10s of network backoff on a perfectly healthy socket.
    //
    // Note what this scenario does and does not reach: a well-formed empty stream
    // completes a step, so the SDK raises no `NoOutputGeneratedError` at all — the
    // turn ends on `applyEmptyFallback` after ONE request. Driving the genuine
    // empty-output ERROR needs a stream that completes no steps, which the fake
    // provider cannot express; that side is unit-tested instead.
    ctx.server.register(scenario("empty-out").text("").repeatLast().build());

    const chatId = await ctx.newChat();
    const turn = await runTurn(ctx, {
      chatId,
      prompt: "sc=empty-out Summarize src/x.ts.",
      mode: "ask",
      timeoutMs: 60_000,
    });

    // No network retry: one request, no partial reset.
    expect(ctx.server.requestsFor("empty-out")).toHaveLength(1);
    expect(turn.fakeIpc.sentOn("chat:stream:reset-partial")).toHaveLength(0);
  });
});
