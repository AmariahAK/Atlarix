/**
 * v13.1: "revert this turn's file changes". A build turn that wrote a file
 * captures a shadow-git snapshot keyed by the assistant message id; the
 * chat:response:end payload carries that as `snapshotTurnId`. Reverting with
 * `filesOnly: true` restores the file WITHOUT flagging the conversation.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  setupEvalContext,
  runTurn,
  getIpcHandler,
  type EvalContext,
} from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectStreamEnded, expectNoStreamError } from "../infra/assert";

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: { "src/keep.ts": "export const keep = 1;\n" },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("revert turn file changes (v13.1)", () => {
  it("restores the file and does NOT flag the conversation as reverted", async () => {
    ctx.server.register(
      scenario("revert-turn")
        .toolCall("write_file", {
          path: "src/keep.ts",
          content: "export const keep = 999;\n",
          description: "Bump keep",
        })
        .text("Updated src/keep.ts. <task_complete>")
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=revert-turn Bump the keep constant.",
      mode: "build",
      during: async (ipc) => {
        const permission = await ipc.waitFor(
          "permission-request",
          (p) => p?.chatId === chatId,
        );
        const executePermission = await getIpcHandler("execute-permission");
        await executePermission({} as never, {
          chatId,
          operationId: permission.payload.operationId,
        });
      },
    });

    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    // The write landed.
    expect(ctx.ws.read("src/keep.ts")).toContain("keep = 999");

    // response:end carries a numeric snapshotTurnId (= the assistant msg id).
    const ends = fakeIpc.sentOn("chat:response:end");
    expect(ends.length).toBeGreaterThanOrEqual(1);
    const snapshotTurnId = ends[ends.length - 1]!.payload?.snapshotTurnId as
      | string
      | undefined;
    expect(snapshotTurnId).toBeTruthy();
    expect(Number.isFinite(Number(snapshotTurnId))).toBe(true);

    // snapshot:files lists the changed file.
    const snapFiles = await getIpcHandler("snapshot:files");
    const files = (await snapFiles({} as never, {
      chatId,
      turnId: snapshotTurnId,
    })) as { filesChanged: string[]; createdFiles: string[] } | null;
    expect(files?.filesChanged).toContain("src/keep.ts");

    // Revert files only → content restored, conversation not flagged reverted.
    const revert = await getIpcHandler("revert:snapshot");
    const res = (await revert({} as never, {
      chatId,
      turnId: snapshotTurnId,
      filesOnly: true,
    })) as { success: boolean; restoredFiles?: number };
    expect(res.success).toBe(true);
    expect(ctx.ws.read("src/keep.ts")).toContain("keep = 1");

    const { getStreamTransport } = await import("@/lib/chat/stream-transport");
    const msgs = getStreamTransport(chatId)?.messages ?? [];
    expect(msgs.some((m) => (m as { isReverted?: boolean }).isReverted)).toBe(false);
  }, 30_000);
});
