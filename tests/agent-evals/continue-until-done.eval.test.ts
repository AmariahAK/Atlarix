import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * v14.8.9 continue-until-done: a Build turn drives an active session plan to
 * completion instead of stopping at a phase boundary. When the model yields
 * (prose-only round) with plan steps still ACTIONABLE, the plan-completeness gate
 * nudges it to continue (bounded by PLAN_YIELD_MAX_NUDGES).
 *
 * v14.23.0: "actionable" means `todo`/`in_progress` only. A step marked `external`
 * (the user's to do) or `blocked` (tried, stuck) is an ANSWER, and the gate must
 * accept it — re-asking was the harness overriding a correct decision and forcing
 * the model to re-attempt work it could never finish.
 */

/** Stable substring of the gate nudge — the wording around it may be tuned. */
const NUDGE = "you haven't accounted for";

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: { "src/x.ts": "export const x = 1;\n" },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("continue-until-done — plan-completeness gate", () => {
  it("nudges the model to continue when actionable steps remain, then bounds out", async () => {
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
    expect(blob).toContain(NUDGE);
    // Mark-don't-redo: a completed-in-reality plan must be marked done and the
    // turn ended, never re-executed.
    expect(blob).toContain("never redo work that succeeded");
    // The nudge must offer the two non-actionable dispositions, or the model has
    // no way to express "this isn't mine" and the fight starts again.
    expect(blob).toContain("external");
    expect(blob).toContain("blocked");
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
    expect(blob).not.toContain(NUDGE);
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
    const nudgeCount = last.split(NUDGE).length - 1;
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
    expect(blob).not.toContain(NUDGE);
  });

  /**
   * The regression this release exists for. Before v14.23.0 the gate counted any
   * step that wasn't `done` as remaining, so a step the model correctly handed to
   * the user kept the turn open and the nudge told it to carry on with that very
   * step — up to 12 times.
   */
  it("a step marked external ends the turn — the user's work is not the model's", async () => {
    ctx.server.register(
      scenario("cud-external")
        .toolCall("plan", {
          operation: "write",
          title: "Ship it",
          content: "1. [ ] Wire the sign step\n2. [ ] Rotate the signing key\n",
        })
        .toolCall("plan", {
          operation: "update_step",
          step_text: "Wire the sign step",
          state: "done",
        })
        .toolCall("plan", {
          operation: "update_step",
          step_text: "Rotate the signing key",
          state: "external",
          reason: "no signing cert on this machine — do it in the dashboard",
        })
        .text("Sign step is wired. Rotating the key is yours — see the plan.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=cud-external Ship the build.",
      mode: "build",
      timeoutMs: 25_000,
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const blob = JSON.stringify(ctx.server.requestsFor("cud-external"));
    // Nothing actionable is left → the gate must stay silent.
    expect(blob).not.toContain(NUDGE);
    // And the tool result must tell the model it may stop.
    expect(blob).toContain("Nothing actionable remains");
  });

  it("a step marked blocked also ends the turn", async () => {
    ctx.server.register(
      scenario("cud-blocked")
        .toolCall("plan", {
          operation: "write",
          title: "Fix it",
          content: "1. [ ] Patch the parser\n2. [ ] Make the flaky test pass\n",
        })
        .toolCall("plan", {
          operation: "update_step",
          step_text: "Patch the parser",
          state: "done",
        })
        .toolCall("plan", {
          operation: "update_step",
          step_text: "Make the flaky test pass",
          state: "blocked",
        })
        .text(
          "Parser patched. The flaky test still fails; here's what I tried.",
        )
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=cud-blocked Fix the parser.",
      mode: "build",
      timeoutMs: 25_000,
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    expect(JSON.stringify(ctx.server.requestsFor("cud-blocked"))).not.toContain(
      NUDGE,
    );
  });

  it("external without a reason is rejected, so it can't be a silent escape hatch", async () => {
    ctx.server.register(
      scenario("cud-external-noreason")
        .toolCall("plan", {
          operation: "write",
          title: "Ship it",
          content: "1. [ ] Rotate the signing key\n",
        })
        .toolCall("plan", {
          operation: "update_step",
          step_text: "Rotate the signing key",
          state: "external",
        })
        .text("Handed over.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=cud-external-noreason Ship the build.",
      mode: "build",
      timeoutMs: 30_000,
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const blob = JSON.stringify(
      ctx.server.requestsFor("cud-external-noreason"),
    );
    // The tool refuses and says how to fix it...
    expect(blob).toContain("requires `reason`");
    // ...and because the step stayed actionable, the gate still asks for it.
    expect(blob).toContain(NUDGE);
  });
});
