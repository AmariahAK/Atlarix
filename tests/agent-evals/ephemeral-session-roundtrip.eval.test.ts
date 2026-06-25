import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  setupEvalContext,
  runTurn,
  getIpcHandler,
  type EvalContext,
} from "../infra/turn";
import { scenario } from "../infra/scenario";
import {
  expectNoStreamError,
  expectStreamEnded,
  expectDbSessionMessage,
} from "../infra/assert";

/**
 * Eval 4 (Tier 4): ephemeral → session persistence round-trip.
 *
 * The dual-store convention under test (docs/TODO.md 0.4): the MAIN process
 * persists the user message into session_messages during the stream and keeps
 * the turn in the ephemeral store; the RENDERER appends the final assistant
 * message via `messages:add`; on reload the renderer loads `sessions:get` and
 * rehydrates a fresh ephemeral transport. This eval plays both sides and
 * asserts content fidelity across the full cycle.
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("ephemeral → session round-trip", () => {
  it("persists the turn and survives a simulated reload", async () => {
    ctx.server.register(
      scenario("roundtrip")
        .text("Ahadi ni deni — message persisted.")
        .build(),
    );

    const chatId = await ctx.newChat();
    const prompt = "sc=roundtrip Say something memorable.";
    const { fakeIpc } = await runTurn(ctx, { chatId, prompt, mode: "build" });

    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    // Main-side: the user message persisted into session_messages during the
    // stream, bound to a session auto-created for the transport chat.
    await expectDbSessionMessage(ctx.testDb, {
      role: "user",
      contentContains: "Say something memorable.",
    });

    const sessionRow = await ctx.testDb.db.query.chatSessions.findFirst();
    expect(sessionRow).toBeTruthy();
    expect(sessionRow!.streamChatId).toBe(chatId);

    // Ephemeral side: the turn is in the in-memory store.
    const { getStreamTransport, hydrateStreamTransport } = await import(
      "@/lib/chat/stream-transport"
    );
    const liveMessages = getStreamTransport(chatId)?.messages ?? [];
    const liveAssistant = liveMessages.find((m) => m.role === "assistant");
    expect(liveAssistant?.content).toContain("Ahadi ni deni");

    // Renderer-side convention: append the final assistant message.
    // (Cast: the IPC handler signature is variadic at runtime.)
    const messagesAdd = (await getIpcHandler("messages:add")) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    await messagesAdd({}, sessionRow!.id, "assistant", liveAssistant!.content);
    await expectDbSessionMessage(ctx.testDb, {
      role: "assistant",
      contentContains: "Ahadi ni deni",
    });

    // Simulated reload: fresh transport + sessions:get + rehydrate.
    const allocateTransport = await getIpcHandler(
      "sessions:allocate-transport",
    );
    const sessionsGet = await getIpcHandler("sessions:get");

    // Forget the old transport (renderer restart ⇒ new ephemeral id).
    const loaded: any = await sessionsGet({} as any, sessionRow!.id);
    expect(loaded.messages.length).toBe(2);
    expect(loaded.messages[0].role).toBe("user");
    expect(loaded.messages[1].role).toBe("assistant");

    const newChatId = await ctx.newChat();
    hydrateStreamTransport(
      newChatId,
      loaded.messages.map((m: any) => ({
        role: m.role,
        content: m.content,
        id: undefined,
      })),
    );

    const rehydrated = getStreamTransport(newChatId)?.messages ?? [];
    expect(rehydrated.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(rehydrated[0].content).toContain("Say something memorable.");
    expect(rehydrated[1].content).toContain("Ahadi ni deni");
    // task_complete stripped before persistence — never re-enters context.
    expect(rehydrated[1].content).not.toContain("<task_complete>");

    // And allocate-transport reuses or replaces the transport binding sanely.
    const allocated: any = await allocateTransport({} as any, sessionRow!.id);
    expect(typeof allocated.chatId).toBe("number");
    expect(allocated.chatId).toBeLessThan(0);
  });
});
