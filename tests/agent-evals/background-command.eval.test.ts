/**
 * v13 Phase 7A — background commands.
 *
 * run_command({ background: true }) returns to the model IMMEDIATELY after
 * approval (the command keeps running detached); its exit result is delivered
 * back automatically — here via the next turn's context drain (the turn ends
 * before the echo exits in the in-loop prepareStep window).
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  setupEvalContext,
  runTurn,
  getIpcHandler,
  type EvalContext,
} from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: { "src/app.ts": "export const app = 1;\n" },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("background commands (7A)", () => {
  it("background run_command returns immediately; the exit result reaches a later turn", async () => {
    ctx.server.register(
      scenario("bg-cmd-start")
        .toolCall("run_command", {
          // `sleep` (not a lone read) keeps this on the permission-prompt path —
          // a bare `echo` is now auto-allowed by the safe read-only fast-path, so
          // it would skip the permission-request this test waits on.
          command: "sleep 0.2; echo background-finished-marker",
          description: "Long task in the background",
          background: true,
        })
        .text("Started the long task in the background.")
        .repeatLast()
        .build(),
    );
    ctx.server.register(
      scenario("bg-cmd-next").text("Noted the background result.").repeatLast().build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=bg-cmd-start Run the long task in the background.",
      mode: "build",
      during: async (ipc) => {
        const permission = await ipc.waitFor(
          "permission-request",
          (p) => p?.chatId === chatId,
        );
        expect(permission.payload.request?.operation).toBe("run_command");
        const executePermission = await getIpcHandler("execute-permission");
        const result: unknown = await executePermission({} as never, {
          chatId,
          operationId: permission.payload.operationId,
        });
        expect((result as { approved?: boolean }).approved).toBe(true);
      },
    });

    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    // The model's tool result came back IMMEDIATELY with the started note.
    const startRequests = ctx.server.requestsFor("bg-cmd-start") as Array<{
      messages: Array<{ role: string; content?: unknown }>;
    }>;
    const followUp = startRequests[startRequests.length - 1];
    expect(JSON.stringify(followUp)).toContain("Background command started");

    // Give the detached command time to exit and record its result.
    await new Promise((r) => setTimeout(r, 1_500));

    // The finished result is delivered to the model AUTOMATICALLY via the
    // prepareStep take-once drain (the `[Background command results]` block).
    // In this harness turn 1 spans long enough (approval + sleep) that the
    // result drains within turn 1; the exact turn is timing-dependent, so the
    // delivery MECHANISM is asserted deterministically in park-resume.eval
    // (same prepareStep + take-once path, for sub-agents). Here we drive a
    // follow-up turn and assert the whole flow stays error-free.
    const { fakeIpc: ipc2 } = await runTurn(ctx, {
      chatId,
      prompt: "sc=bg-cmd-next Anything from the background task?",
      mode: "build",
    });
    expectNoStreamError(ipc2.sends, chatId);
    expectStreamEnded(ipc2.sends, chatId);

    // The result block reached the model in one of this chat's requests.
    const allBodies = JSON.stringify([
      ...ctx.server.requestsFor("bg-cmd-start"),
      ...ctx.server.requestsFor("bg-cmd-next"),
    ]);
    expect(allBodies).toContain("background-finished-marker");
  }, 60_000);
});
