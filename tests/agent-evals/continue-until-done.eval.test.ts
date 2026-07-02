import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * v14.8.9 continue-until-done: a Build turn drives an active session plan to
 * completion instead of stopping at a phase boundary. When the model yields
 * (prose-only round) with plan steps still pending, the plan-completeness gate
 * nudges it to continue (bounded by PLAN_YIELD_MAX_NUDGES); when the plan is all
 * done, the turn ends cleanly.
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({ seedFiles: { "src/x.ts": "export const x = 1;\n" } });
});

afterAll(async () => {
  await ctx.cleanup();
});

type RecordedRequest = { messages: Array<{ role: string; content?: unknown }> };

describe("continue-until-done — plan-completeness gate", () => {
  it("nudges the model to continue when plan steps remain, then bounds out", async () => {
    ctx.server.register(
      scenario("cud-pending")
        // Create a plan with pending steps (a productive round → resets streak).
        .toolCall("plan", {
          operation: "write",
          title: "Feature",
          content: "1. [ ] Scaffold\n2. [ ] Wire it up\n",
        })
        // Then yield prose-only while steps remain → gate should nudge, not end.
        .text("Made a start; I'll continue.")
        .text("Still going.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=cud-pending Implement the feature.",
      mode: "build",
      timeoutMs: 25_000,
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId); // bounded — doesn't hang

    const blob = JSON.stringify(ctx.server.requestsFor("cud-pending"));
    // The plan-completion nudge was injected (turn continued past the yield).
    expect(blob).toContain("session plan is not finished");
    expect(blob).toContain("do NOT end the turn");
  });

  it("ends cleanly when the plan is fully done (no nudge)", async () => {
    ctx.server.register(
      scenario("cud-done")
        .toolCall("plan", {
          operation: "write",
          title: "Feature",
          content: "1. [x] Scaffold\n2. [x] Wire it up\n",
        })
        .text("All steps complete.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=cud-done Implement the feature.",
      mode: "build",
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const blob = JSON.stringify(ctx.server.requestsFor("cud-done"));
    // All steps done → the gate returns null → no continuation nudge.
    expect(blob).not.toContain("session plan is not finished");
  });
});
