import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * v14.8.7 §A1/§A1a — the live task ledger is re-injected near the latest turn.
 *
 * Turn 1 creates a session plan and marks a step done via update_step WITHOUT a
 * planId (A1a: latest plan assumed). Turn 2's request must then carry the
 * compact "[Task ledger]" block (A1 recency injection built from the plan
 * artifact), so the model reads "what's left" as the freshest thing.
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

type RecordedRequest = { messages: Array<{ role: string; content?: unknown }> };

describe("task ledger recency injection", () => {
  it("injects the compact ledger block on the turn after a plan is created", async () => {
    ctx.server.register(
      scenario("ledger-create")
        .toolCall("plan", {
          operation: "write",
          title: "Auth flow",
          content:
            "1. [ ] Scaffold routes\n2. [ ] Wire the login handler\n3. [ ] Add session cookies\n",
        })
        // A1a: update_step with NO planId — the session's latest plan is assumed.
        .toolCall("plan", {
          operation: "update_step",
          step_index: 1,
          state: "done",
        })
        .text("Plan created and step 1 done.")
        .repeatLast()
        .build(),
    );
    // repeatLast: turn 2 runs in Build with the plan still holding pending steps,
    // so the v14.8.9 plan-completeness gate correctly nudges "continue" — absorb
    // those bounded nudges (the assertion below is on the FIRST request).
    ctx.server.register(
      scenario("ledger-next").text("Continuing.").repeatLast().build(),
    );

    const chatId = await ctx.newChat();

    const turn1 = await runTurn(ctx, {
      chatId,
      prompt: "sc=ledger-create Make a plan for the auth flow and start it.",
      mode: "build",
    });
    expectNoStreamError(turn1.fakeIpc.sends, chatId);

    const turn2 = await runTurn(ctx, {
      chatId,
      prompt: "sc=ledger-next Keep going.",
      mode: "build",
    });
    expectNoStreamError(turn2.fakeIpc.sends, chatId);
    expectStreamEnded(turn2.fakeIpc.sends, chatId);

    const turn2Req = (
      ctx.server.requestsFor("ledger-next") as RecordedRequest[]
    )[0];
    const blob = JSON.stringify(turn2Req);
    expect(blob).toContain("[Session plan]");
    // v14.8.8: the harness-injected block is framed out-of-band, not as a user turn.
    expect(blob).toContain("<system-reminder>");
    // step 1 marked done via the planId-less update_step (A1a)
    expect(blob).toContain("1/3 steps done");
    // remaining steps carried at high salience
    expect(blob).toContain("Add session cookies");
  });
});
