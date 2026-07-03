import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * v14.8.10 Fix R: the doom-loop guard is STAGED — a byte-identical repeated
 * tool call is answered with corrective guidance (as the tool result, without
 * executing) at 3 and 6 repeats, and only the 9th fires the tools-off
 * force-finish backstop. Varying args never trigger anything (the v14.8.9
 * permission-path key bug collapsed edit_file to {path}, so consecutive
 * DIFFERENT edits to one file force-finished a legitimate turn).
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({ seedFiles: { "src/x.ts": "export const x = 1;\n" } });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("repetition escalation — guide, guide harder, circuit-break", () => {
  it("corrects a repeated identical call, escalates, and force-finishes only at the backstop", async () => {
    const b = scenario("rep-escalate");
    // The model stubbornly repeats the SAME read_file call. The SDK consumes
    // one scripted response per step, so the guard sees consecutive identical
    // calls: corrections at 3 and 6 (synthetic results, no abort), abort at 9,
    // then the force-finish round consumes the final text.
    for (let i = 0; i < 10; i++) {
      b.toolCall("read_file", { path: "src/x.ts" });
    }
    ctx.server.register(b.text("Summary: I was stuck re-reading x.ts.").repeatLast().build());

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=rep-escalate Inspect the file.",
      mode: "build",
      timeoutMs: 30_000,
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const blob = JSON.stringify(ctx.server.requestsFor("rep-escalate"));
    // Correction 1 fed back as the tool result (call NOT executed).
    expect(blob).toContain("This call was NOT executed");
    // Correction 2 invites the model's own stop.
    expect(blob).toContain("end your turn with a status report");
    // The backstop still exists: the force-finish round ran after 9 repeats.
    expect(blob).toContain("tools are now disabled");
  });

  it("never triggers on varying args (legit sequential work)", async () => {
    ctx.server.register(
      scenario("rep-legit")
        .toolCall("read_file", { path: "src/x.ts", offset: 1 })
        .toolCall("read_file", { path: "src/x.ts", offset: 50 })
        .toolCall("read_file", { path: "src/x.ts", offset: 100 })
        .toolCall("read_file", { path: "src/x.ts", offset: 150 })
        .text("Read it all — done.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=rep-legit Page through the file.",
      mode: "build",
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const blob = JSON.stringify(ctx.server.requestsFor("rep-legit"));
    expect(blob).not.toContain("This call was NOT executed");
    expect(blob).not.toContain("tools are now disabled");
  });
});
