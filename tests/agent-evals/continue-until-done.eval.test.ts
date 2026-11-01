import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * v15.12 plan tool trusts the model (owner decision 2026-10-31). The forced
 * "continue-until-done" gate is gone: a Build turn no longer has to tick every
 * plan step before it may end, so a prose-only yield while steps are still
 * pending ends the turn instead of being nudged on. And `reason` on an
 * `external` step is optional — without one the step shows its own text plus
 * "Atlarix says only you can do this".
 */

/** Stable substring of the removed gate nudge — must NOT appear now. */
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

describe("plan tool trusts the model — no forced step marking", () => {
  it("ends the turn on a prose yield even while steps are still pending (no nudge)", async () => {
    ctx.server.register(
      scenario("trust-pending")
        .toolCall("plan", {
          operation: "write",
          title: "Feature",
          content: "1. [ ] Scaffold\n2. [ ] Wire it up\n",
        })
        .text("Made a start; here's the plan so far.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=trust-pending Implement the feature.",
      mode: "build",
      timeoutMs: 25_000,
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId); // ends — never held open

    const blob = JSON.stringify(ctx.server.requestsFor("trust-pending"));
    expect(blob).not.toContain(NUDGE);
  });

  it("external without a reason succeeds and shows the default hand-over note", async () => {
    ctx.server.register(
      scenario("trust-external-noreason")
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
      prompt: "sc=trust-external-noreason Ship the build.",
      mode: "build",
      timeoutMs: 30_000,
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const blob = JSON.stringify(
      ctx.server.requestsFor("trust-external-noreason"),
    );
    // `reason` is optional now — no refusal…
    expect(blob).not.toContain("requires `reason`");
    // …and the step carries the default note.
    expect(blob).toContain("Atlarix says only you can do this");
  });

  it("external with a reason keeps the model's wording", async () => {
    ctx.server.register(
      scenario("trust-external-reason")
        .toolCall("plan", {
          operation: "write",
          title: "Ship it",
          content: "1. [ ] Rotate the signing key\n",
        })
        .toolCall("plan", {
          operation: "update_step",
          step_text: "Rotate the signing key",
          state: "external",
          reason: "no signing cert on this machine — do it in the dashboard",
        })
        .text("Sign step is yours — see the plan.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=trust-external-reason Ship the build.",
      mode: "build",
      timeoutMs: 25_000,
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const blob = JSON.stringify(ctx.server.requestsFor("trust-external-reason"));
    expect(blob).toContain("no signing cert on this machine");
    expect(blob).not.toContain("requires `reason`");
  });

  it("blocked still ends the turn", async () => {
    ctx.server.register(
      scenario("trust-blocked")
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
        .text("Parser patched. The flaky test still fails; here's what I tried.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=trust-blocked Fix the parser.",
      mode: "build",
      timeoutMs: 25_000,
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);
  });
});
