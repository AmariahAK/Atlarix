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
    // v14.8.10 wording: mark-don't-redo — a completed-in-reality plan must be
    // marked done and the turn ended, never re-executed.
    expect(blob).toContain("NEVER redo or restart work");
  });

  it("does not nudge in plan work mode — the plan itself is the deliverable", async () => {
    ctx.server.register(
      scenario("cud-plan-mode")
        // Plan mode: the model writes the plan (all steps pending by
        // construction) and presents it for review — the turn must END here.
        .toolCall("plan", {
          operation: "write",
          title: "Feature",
          content: "1. [ ] Scaffold\n2. [ ] Wire it up\n",
        })
        .text("Here is the plan — review it and switch to Build to implement.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=cud-plan-mode Plan the feature.",
      mode: "build",
      settings: { workModePreference: "plan" },
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const blob = JSON.stringify(ctx.server.requestsFor("cud-plan-mode"));
    // Pending steps exist, but plan mode must not be nudged to "continue" —
    // that reads as "proceed without the user" (observed live: the model
    // started implementing right after presenting the plan).
    expect(blob).not.toContain("session plan is not finished");
  });

  it("bounds total nudges per turn even when productive rounds reset the streak", async () => {
    // A model alternating one trivial productive round with a yield re-arms the
    // consecutive 6-cap forever (observed live: 3+ full nudge cycles in one
    // turn). The absolute per-turn total (12) must end the turn regardless.
    const b = scenario("cud-total-cap").toolCall("plan", {
      operation: "write",
      title: "Feature",
      content: "1. [ ] Scaffold\n2. [ ] Wire it up\n",
    });
    for (let i = 0; i < 16; i++) {
      // Vary args so the byte-identical doom-loop guard doesn't fire first.
      b.toolCall("plan", {
        operation: "write",
        title: "Feature",
        content: `1. [ ] Scaffold\n2. [ ] Wire it up (rev ${i})\n`,
      });
      b.text("Pausing here.");
    }
    ctx.server.register(b.text("Done.").repeatLast().build());

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=cud-total-cap Implement the feature.",
      mode: "build",
      timeoutMs: 60_000,
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    // The nudge is folded into the request history, so the final request
    // carries every nudge injected this turn — count must respect the cap.
    const requests = ctx.server.requestsFor("cud-total-cap");
    const last = JSON.stringify(requests[requests.length - 1]);
    const nudgeCount = last.split("session plan is not finished").length - 1;
    expect(nudgeCount).toBeGreaterThan(0);
    expect(nudgeCount).toBeLessThanOrEqual(12);
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
