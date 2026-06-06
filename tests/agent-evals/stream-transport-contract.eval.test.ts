import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  setupEvalContext,
  runTurn,
  getIpcHandler,
  type EvalContext,
} from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * v12 0.4-C3 — the stream-transport contract (docs/message-store.md).
 *
 * The in-memory transport is a TURN BUFFER, not a store of record: after a
 * completed turn (+ the renderer's messages:add convention) the buffer and
 * the session DB are in lockstep, and every persisted message in the buffer
 * carries its DB row UUID (`sessionRowId`).
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("stream-transport contract (0.4)", () => {
  it("buffer and DB are in lockstep after a turn; persisted messages carry row ids", async () => {
    ctx.server.register(
      scenario("transport-lockstep")
        .text("Uthibitisho wa mkataba. <task_complete>")
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=transport-lockstep Say the contract phrase.",
      mode: "build",
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const { getStreamTransport } = await import("@/lib/chat/stream-transport");
    const buffer = getStreamTransport(chatId)?.messages ?? [];
    const bufferUser = buffer.find((m) => m.role === "user");
    const bufferAssistant = buffer.find((m) => m.role === "assistant");
    expect(bufferUser).toBeTruthy();
    expect(bufferAssistant?.content).toContain("Uthibitisho wa mkataba");

    // Invariant: a streamed (persisted) user message carries its row UUID.
    expect(
      bufferUser?.sessionRowId,
      "streamed user message must carry sessionRowId",
    ).toBeTruthy();

    // Play the renderer convention: persist the assistant message.
    const sessionRow = await ctx.testDb.db.query.chatSessions.findFirst({
      where: (s: any, { eq }: any) => eq(s.streamChatId, chatId),
    });
    expect(sessionRow).toBeTruthy();
    const messagesAdd = (await getIpcHandler("messages:add")) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    await messagesAdd(
      {},
      sessionRow!.id,
      "assistant",
      bufferAssistant!.content,
    );

    // Lockstep: DB rows match the buffer by role + content.
    const sessionsGet = await getIpcHandler("sessions:get");
    const loaded: any = await sessionsGet({} as any, sessionRow!.id);
    const dbVisible = (
      loaded.messages as Array<{ role: string; content: string }>
    ).filter((m) => m.role === "user" || m.role === "assistant");
    expect(dbVisible.length).toBe(2);
    expect(dbVisible[0].role).toBe("user");
    expect(dbVisible[0].content).toBe(bufferUser!.content);
    expect(dbVisible[1].role).toBe("assistant");
    expect(dbVisible[1].content).toBe(bufferAssistant!.content);

    // And the user row's UUID is exactly the buffer's sessionRowId.
    const userRow = await ctx.testDb.db.query.sessionMessages.findFirst({
      where: (m: any, { eq }: any) => eq(m.id, bufferUser!.sessionRowId!),
    });
    expect(userRow?.content).toBe(bufferUser!.content);
  });

  it("ask_user Q→A inserts carry their row id (0.4-C3 gap closed)", async () => {
    ctx.server.register(
      scenario("transport-qa")
        .toolCall("ask_user", {
          question: "Which one?",
          options: ["a", "b"],
        })
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=transport-qa Ask me something.",
      mode: "ask",
    });
    expect(fakeIpc.sentOn("user-question-request").length).toBe(1);
    const questionPayload = fakeIpc.sentOn("user-question-request")[0].payload;

    // Submit the answer through the real handler.
    const submitAnswer = await getIpcHandler(
      "chat:submit-user-question-answer",
    );
    const result: any = await submitAnswer(fakeIpc.event, {
      chatId,
      questionId: questionPayload.questionId,
      questionText: questionPayload.question,
      answer: "a",
    });
    expect(result.success).toBe(true);

    const { getStreamTransport } = await import("@/lib/chat/stream-transport");
    const qaMessage = [...(getStreamTransport(chatId)?.messages ?? [])]
      .reverse()
      .find((m) => m.role === "user");
    expect(qaMessage?.content).toContain("a");
    expect(
      qaMessage?.sessionRowId,
      "Q→A insert must carry its persisted row id",
    ).toBeTruthy();
  });
});
