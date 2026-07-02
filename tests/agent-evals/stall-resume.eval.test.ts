import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * v14.8.7 (deferred eval, now built) — idle-stall detection → recovery, end to
 * end. This path was documented as "not exercisable in-harness" since v14.8.0;
 * the {kind:"stall"} scenario primitive + the ATLARIX_TEST_STALL_MS override
 * make it testable. A round goes silent (one chunk then hang), the watchdog
 * fires, and the turn RECOVERS and completes cleanly instead of hanging.
 *
 * (The §A2 "resume re-asserts the SAME task via the ledger" continuation-prompt
 * logic is unit-covered in src/__tests__/task-ledger.test.ts — the fake server's
 * onAbort step-capture is a harness detail not asserted here.)
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({ seedFiles: { "src/x.ts": "export const x = 1;\n" } });
});

afterAll(async () => {
  await ctx.cleanup();
});

type RecordedRequest = { messages: Array<{ role: string; content?: unknown }> };

describe("idle-stall detection and recovery", () => {
  it("detects a mid-turn stall and recovers to a clean finish", async () => {
    ctx.server.register(
      scenario("stall-run")
        .toolCall("read_file", { path: "src/x.ts" }) // a step completes first
        .stall() // then the model goes silent → watchdog fires
        .text("Resumed and finished.")
        .text("Resumed and finished.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();

    // Shrink the stall watchdog so the hang is caught fast (prod default 600s).
    process.env.ATLARIX_TEST_STALL_MS = "500";
    let turn;
    try {
      turn = await runTurn(ctx, {
        chatId,
        prompt: "sc=stall-run Do the refactor.",
        mode: "build",
        timeoutMs: 20_000,
      });
    } finally {
      delete process.env.ATLARIX_TEST_STALL_MS;
    }

    // Recovered cleanly — no hang, no surfaced error, reached a terminal.
    expectNoStreamError(turn.fakeIpc.sends, chatId);
    expectStreamEnded(turn.fakeIpc.sends, chatId);

    // The stall forced an extra round (the tool step, the stalled step, then the
    // recovered round), and the turn produced its final answer.
    const reqs = ctx.server.requestsFor("stall-run") as RecordedRequest[];
    expect(reqs.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(turn.fakeIpc.sends)).toContain("Resumed and finished.");
  });
});
