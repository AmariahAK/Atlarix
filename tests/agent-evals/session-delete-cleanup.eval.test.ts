import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  setupEvalContext,
  runTurn,
  getIpcHandler,
  type EvalContext,
} from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError } from "../infra/assert";

/**
 * v12 TODO 2.4 (quick win B3): sessions:delete prunes in-memory transport
 * state — ephemeral chat entry + per-chat stream maps — instead of only
 * deleting the DB row.
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("session delete cleanup", () => {
  it("prunes the ephemeral chat and returns the transport id", async () => {
    ctx.server.register(
      scenario("delete-cleanup")
        .text("Stored.")
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=delete-cleanup Remember something.",
      mode: "build",
    });
    expectNoStreamError(fakeIpc.sends, chatId);

    const { getStreamTransport } = await import("@/lib/chat/stream-transport");
    expect(getStreamTransport(chatId)).toBeTruthy();

    const sessionRow = await ctx.testDb.db.query.chatSessions.findFirst();
    expect(sessionRow?.streamChatId).toBe(chatId);

    const sessionsDelete = await getIpcHandler("sessions:delete");
    const result: any = await sessionsDelete({} as any, sessionRow!.id);

    expect(result.ok).toBe(true);
    expect(result.streamChatId).toBe(chatId);

    // In-memory transport gone (main-process leak fixed).
    expect(getStreamTransport(chatId)).toBeUndefined();

    // DB row gone.
    const remaining = await ctx.testDb.db.query.chatSessions.findMany();
    expect(remaining.find((s) => s.id === sessionRow!.id)).toBeUndefined();
  });
});
