import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  setupEvalContext,
  runTurn,
  getIpcHandler,
  type EvalContext,
} from "../infra/turn";
import { scenario } from "../infra/scenario";
import {
  expectFile,
  expectStreamEnded,
  expectNoStreamError,
} from "../infra/assert";

/**
 * Eval 2 (Tier 4): multi-turn edit-with-approval — Build mode.
 *
 * The model (scripted) calls write_file; auto-approve is OFF, so the
 * PermissionInterceptor buffers the operation, the stream emits
 * `permission-request` and BLOCKS on waitForApproval. The test plays the
 * renderer: it observes the event and invokes the real `execute-permission`
 * handler. Asserts the approval round-trip, the file on disk, and a clean
 * stream end.
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("edit with approval (build mode)", () => {
  it("buffers write_file for approval, applies it on approve", async () => {
    ctx.server.register(
      scenario("edit-approve")
        .toolCall("write_file", {
          path: "src/answer.ts",
          content: "export const answer = 42;\n",
          description: "Answer module",
        })
        .text("Created src/answer.ts. <task_complete>")
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=edit-approve Create an answer module.",
      mode: "build",
      during: async (ipc) => {
        // Play the renderer: wait for the permission card, then approve.
        const permission = await ipc.waitFor(
          "permission-request",
          (p) => p?.chatId === chatId,
        );
        expect(permission.payload.operationId).toBeTruthy();
        expect(permission.payload.request?.operation).toBe("write_file");

        // File must NOT exist while the approval is pending.
        expect(ctx.ws.exists("src/answer.ts")).toBe(false);

        const executePermission = await getIpcHandler("execute-permission");
        const result: any = await executePermission({} as any, {
          chatId,
          operationId: permission.payload.operationId,
        });
        expect(result.approved).toBe(true);
      },
    });

    expectNoStreamError(fakeIpc.sends, chatId);

    // Approved write landed in the real workspace.
    expectFile(ctx.ws, "src/answer.ts", "export const answer = 42;");

    // The model saw the success result and finished.
    const requests = ctx.server.requestsFor("edit-approve") as any[];
    expect(requests.length).toBeGreaterThanOrEqual(2);

    expectStreamEnded(fakeIpc.sends, chatId);

    const { getEphemeralChat } = await import("@/lib/ephemeral-chat");
    const lastAssistant = [...(getEphemeralChat(chatId)?.messages ?? [])]
      .reverse()
      .find((m) => m.role === "assistant");
    expect(lastAssistant?.content).toContain("Created src/answer.ts.");
  });

  it("does NOT write the file when the user rejects", async () => {
    ctx.server.register(
      scenario("edit-reject")
        .toolCall("write_file", {
          path: "src/rejected.ts",
          content: "export const nope = true;\n",
          description: "Module the user will reject",
        })
        .text("Understood, not writing the file. <task_complete>")
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=edit-reject Create a module.",
      mode: "build",
      during: async (ipc) => {
        const permission = await ipc.waitFor(
          "permission-request",
          (p) => p?.chatId === chatId,
        );
        const rejectPermission = await getIpcHandler("reject-permission");
        const result: any = await rejectPermission({} as any, {
          chatId,
          operationId: permission.payload.operationId,
        });
        expect(result.approved).toBe(false);
      },
    });

    expectNoStreamError(fakeIpc.sends, chatId);
    expect(ctx.ws.exists("src/rejected.ts")).toBe(false);
    expectStreamEnded(fakeIpc.sends, chatId);
  });
});
