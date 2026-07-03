import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * v14.8.10 plan-tool robustness: a bogus update_step must return a
 * SELF-CORRECTING error — the current checklist inline plus the rewrite-and
 * -step_text guidance — so a weak model can fix it in ONE follow-up call
 * (observed live: DeepSeek hit the bare "retry with a valid step_index" error
 * twice and only recovered because it thought to re-read; weaker models stop
 * marking steps, which then feeds the continue-until-done gate).
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({ seedFiles: { "src/x.ts": "export const x = 1;\n" } });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("plan update_step — self-correcting errors + text addressing", () => {
  it("bogus index returns the checklist inline; step_text then succeeds without a read", async () => {
    ctx.server.register(
      scenario("plan-step-fix")
        .toolCall("plan", {
          operation: "write",
          title: "Feature",
          content: "1. [ ] Scaffold the module\n2. [ ] Wire the handler\n3. [ ] Run the tests\n",
        })
        // Drifted bookkeeping: the model thinks there's a step 9.
        .toolCall("plan", { operation: "update_step", step_index: 9, state: "done" })
        // Self-corrects using text addressing (no plan(read) round-trip).
        .toolCall("plan", {
          operation: "update_step",
          step_text: "wire the handler",
          state: "done",
        })
        .text("Marked progress; the remaining steps need the user's manual test.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=plan-step-fix Track the work in a plan.",
      mode: "build",
      timeoutMs: 25_000,
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const blob = JSON.stringify(ctx.server.requestsFor("plan-step-fix"));
    // The failed call's result carries the checklist + both recovery routes.
    expect(blob).toContain("Current steps:");
    expect(blob).toContain("Wire the handler");
    expect(blob).toContain("operation:'write'");
    expect(blob).not.toContain("retry with a valid step_index"); // old dead-end copy
    // The step_text follow-up actually landed (progress in its result).
    expect(blob).toContain("steps done");
  });
});
