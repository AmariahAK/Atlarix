import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  setupEvalContext,
  runTurn,
  type EvalContext,
} from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * edit_file near-miss guidance: an edit whose old_content no longer matches the
 * file returns a structured retry hint (closest candidate + "re-read and retry
 * with EXACT current content") instead of a bare error.
 *
 * (v13.1: the post-write LSP verify tests that lived here were removed with the
 * LSP feature — verification is now the project's own checks/tests.)
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("edit_file no-match guidance", () => {
  it("returns structured retry guidance on a stale old_content", async () => {
    // The near-miss heuristic keys on the first 30 chars of old_content —
    // the stale part must come AFTER that prefix for the candidate to hit.
    ctx.ws.write(
      "src/target.ts",
      "export const realAnswerValue = computeAnswer(1);\n",
    );
    ctx.server.register(
      scenario("nomatch-guidance")
        .toolCall("edit_file", {
          path: "src/target.ts",
          operation: "replace",
          old_content: "export const realAnswerValue = computeAnswer(999);",
          new_content: "export const realAnswerValue = computeAnswer(2);",
          description: "Edit with stale content",
        })
        .text("I see — re-reading.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=nomatch-guidance Update the constant.",
      mode: "build",
    });

    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const blob = JSON.stringify(ctx.server.requestsFor("nomatch-guidance"));
    expect(blob).toContain("Closest candidate at line");
    expect(blob).toContain("retry with the EXACT current content");
  }, 30_000);
});
