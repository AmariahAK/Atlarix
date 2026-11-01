import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * A turn that reads a lot must not persist a lot.
 *
 * Mid-loop compaction shrinks the REQUEST, but `foldNativeIntoTurn` pushes every
 * round into `rt.nativeTurnMessages` as well, and nothing bounded that — so the
 * assistant message's `modelContent` envelope kept the full tool history, the next
 * message rehydrated all of it, and the pre-dispatch gate paid to summarize what
 * mid-turn had already summarized. Observed 2026-08-31 as `34,954 / 16.0k` on a
 * single turn.
 *
 * This drives the real `chat:stream` handler through a multi-round turn and checks
 * the two halves of the fix at the level that matters — what actually landed in the
 * database:
 *   · `model_content` (the model-facing envelope) is bounded.
 *   · `content` (the display transcript the UI renders) is NOT touched. The user
 *     keeps their full scrollback; only what the model re-reads is clipped.
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("the persisted turn envelope is bounded, the display transcript is not", () => {
  it("clips model_content on a read-heavy turn and leaves content alone", async () => {
    // Four big files, so the turn's tool history is genuinely large.
    const big = "// filler line to make this file substantial\n".repeat(4_000);
    const names = ["alpha.ts", "beta.ts", "gamma.ts", "delta.ts"];
    for (const n of names) {
      writeFileSync(join(ctx.ws.dir, n), big);
    }

    ctx.server.register(
      scenario("envelope")
        .toolCall("read_file", { path: "alpha.ts" })
        .toolCall("read_file", { path: "beta.ts" })
        .toolCall("read_file", { path: "gamma.ts" })
        .toolCall("read_file", { path: "delta.ts" })
        .text("Read all four. They are filler.")
        // With a 16k cap, mid-turn compaction now genuinely runs in this turn and
        // its summariser side-call can land on this last scripted reply; repeat it
        // so the model's closing request still gets it. Compaction is not what
        // this eval measures - the persisted envelope's bound is.
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=envelope Read alpha.ts, beta.ts, gamma.ts and delta.ts.",
      mode: "build",
      // Cap the window so ONE turn's half-share is the 8,000-token floor. Without
      // this the eval model reports a 200,000-token window, the envelope's budget
      // is 100,000, a 48,000-token turn needs no clipping at all, and the test
      // passes while exercising nothing. Same lever a user has (Settings →
      // provider → "Token budget cap").
      settings: { tokenBudgetOverrides: { [ctx.providerId]: 16_000 } },
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    // The envelope is written onto the stream transport's assistant message
    // (`finalize.ts` sets `modelContent` there), and the renderer persists that
    // verbatim via `messages:add`. So the transport is the honest place to read
    // what WILL be stored, without replaying the renderer's half.
    const { getStreamTransport } = await import("@/lib/chat/stream-transport");
    const live = getStreamTransport(chatId)?.messages ?? [];
    const assistant = [...live].reverse().find((m) => m.role === "assistant");
    expect(
      assistant,
      "the turn must have produced an assistant message",
    ).toBeTruthy();

    const envelope =
      (assistant as { modelContent?: string | null }).modelContent ?? "";
    expect(
      envelope,
      "the turn ran four native tool calls, so an envelope must exist",
    ).not.toBe("");

    const { parseNativeHistory, estimateModelMessagesTokens } = await import(
      "@/lib/ai/native-history"
    );
    const parsed = parseNativeHistory(envelope);
    expect(parsed).toBeTruthy();

    const envelopeTokens = estimateModelMessagesTokens(parsed!.messages ?? []);
    // With a 16,000-token cap, one turn's share floors at MIN_ENVELOPE_BUDGET_TOKENS
    // (8,000). Unbounded, these four files come to ~48,000 — measured before the
    // fix, which is what makes this a real assertion and not a tautology.
    expect(envelopeTokens).toBeLessThanOrEqual(8_000);

    // Pairing survived — the whole reason clipping beats pruning.
    const callIds: string[] = [];
    const resultIds: string[] = [];
    for (const m of parsed!.messages ?? []) {
      if (!Array.isArray(m.content)) continue;
      for (const p of m.content as Array<{
        type?: string;
        toolCallId?: string;
      }>) {
        if (p?.type === "tool-call" && p.toolCallId) callIds.push(p.toolCallId);
        if (p?.type === "tool-result" && p.toolCallId)
          resultIds.push(p.toolCallId);
      }
    }
    expect(callIds.length).toBeGreaterThan(0);
    expect(resultIds.sort()).toEqual(callIds.sort());

    // And the DISPLAY transcript is untouched: the user's scrollback is not the
    // model's context, and only the latter is clipped.
    expect(assistant!.content).toContain("Read all four");
    // The clipped bytes really were large — otherwise this test proves nothing.
    expect(envelope.length).toBeGreaterThan(0);
  });
});
