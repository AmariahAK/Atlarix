import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  setupEvalContext,
  runTurn,
  getIpcHandler,
  type EvalContext,
} from "../infra/turn";
import { scenario } from "../infra/scenario";
import { makeFakeIpcEvent } from "../infra/ipc";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * v12 0.4-C2 + 3.3 — session-edit integrity.
 *
 * C2: streamed user messages carry their session DB row UUID
 * (`sessionRowId`), so edits target the row DIRECTLY — the old
 * window-boundary ordinal failure (3.3) is structurally impossible on this
 * path: an edit that ordinal math could NOT have mapped persists correctly.
 *
 * Legacy fallback (pre-C2 messages without `sessionRowId`, deleted with the
 * ephemeral store in C3): an unmappable ordinal surfaces a visible warning +
 * `persistedToSession:false` instead of silently diverging (the 3.3 fix).
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("session edit integrity (0.4-C2 / 3.3)", () => {
  it("C2: a boundary edit persists via the direct row id (no ordinal math)", async () => {
    ctx.server.register(scenario("edit-direct").text("Reply one.").build());

    const chatId = await ctx.newChat();
    const turn = await runTurn(ctx, {
      chatId,
      prompt: "sc=edit-direct Say something.",
      mode: "ask",
    });
    expectNoStreamError(turn.fakeIpc.sends, chatId);
    expectStreamEnded(turn.fakeIpc.sends, chatId);

    // Pile extra ephemeral user messages on top of the single persisted DB
    // row — the FIRST message's ordinal maps below the visible window
    // (dbOrdinal < 0), which the OLD path could not handle.
    const { addEphemeralMessage, getEphemeralChat } = await import(
      "@/lib/ephemeral-chat"
    );
    addEphemeralMessage(chatId, { role: "user", content: "extra one" });
    addEphemeralMessage(chatId, { role: "user", content: "extra two" });
    addEphemeralMessage(chatId, { role: "user", content: "extra three" });
    const firstUser = (getEphemeralChat(chatId)?.messages ?? []).find(
      (m) => m.role === "user",
    );
    expect(
      firstUser?.sessionRowId,
      "streamed message must carry its row id",
    ).toBeTruthy();

    const editHandler = await getIpcHandler("chat:edit-message");
    const fakeIpc = makeFakeIpcEvent();
    const result = (await editHandler(fakeIpc.event, {
      chatId,
      userMessageId: firstUser!.id,
      newContent: "rewritten beyond the window",
    })) as { success: boolean; persistedToSession: boolean };

    // Direct-row path: the edit PERSISTS despite the unmappable ordinal.
    expect(result.success).toBe(true);
    expect(result.persistedToSession).toBe(true);
    const rows = await ctx.testDb.db.query.sessionMessages.findMany();
    const userRows = rows.filter((r: { role: string }) => r.role === "user");
    expect(
      userRows.some((r: { content: string }) =>
        r.content.includes("rewritten beyond the window"),
      ),
    ).toBe(true);
    expect(
      userRows.some((r: { content: string }) =>
        r.content.includes("Say something."),
      ),
    ).toBe(false);
  });

  it("C2 reload: hydrated messages keep their row id and edit directly", async () => {
    ctx.server.register(
      scenario("edit-reload").text("Reply r. <task_complete>").build(),
    );

    const chatId = await ctx.newChat();
    const turn = await runTurn(ctx, {
      chatId,
      prompt: "sc=edit-reload Remember this prompt.",
      mode: "build",
    });
    expectNoStreamError(turn.fakeIpc.sends, chatId);

    // Simulated reload: load rows, hydrate a FRESH transport carrying the
    // row UUIDs (the WorkspaceSessionList convention).
    const sessionRow = await ctx.testDb.db.query.chatSessions.findFirst({
      where: (s: any, { eq }: any) => eq(s.streamChatId, chatId),
    });
    const sessionsGet = await getIpcHandler("sessions:get");
    const loaded: any = await sessionsGet({} as any, sessionRow!.id);
    const { hydrateEphemeralChatMessages, getEphemeralChat } = await import(
      "@/lib/ephemeral-chat"
    );
    const newChatId = await ctx.newChat();
    hydrateEphemeralChatMessages(
      newChatId,
      loaded.messages.map((m: any) => ({
        role: m.role,
        content: m.content,
        sessionRowId: m.id,
      })),
    );

    const hydratedUser = (getEphemeralChat(newChatId)?.messages ?? []).find(
      (m) => m.role === "user",
    );
    expect(hydratedUser?.sessionRowId).toBeTruthy();

    const editHandler = await getIpcHandler("chat:edit-message");
    const fakeIpc = makeFakeIpcEvent();
    const result = (await editHandler(fakeIpc.event, {
      chatId: newChatId,
      userMessageId: hydratedUser!.id,
      newContent: "edited after reload",
    })) as { success: boolean; persistedToSession: boolean };
    expect(result.persistedToSession).toBe(true);

    const rows = await ctx.testDb.db.query.sessionMessages.findMany();
    expect(
      rows.some((r: { content: string }) =>
        r.content.includes("edited after reload"),
      ),
    ).toBe(true);
  });

  it("legacy fallback: an unmappable ordinal surfaces a warning (3.3)", async () => {
    ctx.server.register(scenario("edit-fallback").text("Reply two.").build());

    const chatId = await ctx.newChat();
    const turn = await runTurn(ctx, {
      chatId,
      prompt: "sc=edit-fallback Say something else.",
      mode: "ask",
    });
    expectNoStreamError(turn.fakeIpc.sends, chatId);
    expectStreamEnded(turn.fakeIpc.sends, chatId);

    // Edit an ephemeral-only extra message (NO sessionRowId → ordinal path).
    // Its ordinal maps past the persisted rows → "unmapped".
    const { addEphemeralMessage, getEphemeralChat } = await import(
      "@/lib/ephemeral-chat"
    );
    addEphemeralMessage(chatId, { role: "user", content: "ephemeral only A" });
    addEphemeralMessage(chatId, { role: "user", content: "ephemeral only B" });
    const extra = [...(getEphemeralChat(chatId)?.messages ?? [])]
      .reverse()
      .find((m) => m.role === "user" && m.content === "ephemeral only A");
    expect(extra).toBeTruthy();
    expect(extra!.sessionRowId).toBeUndefined();

    const editHandler = await getIpcHandler("chat:edit-message");
    const fakeIpc = makeFakeIpcEvent();
    const result = (await editHandler(fakeIpc.event, {
      chatId,
      userMessageId: extra!.id,
      newContent: "rewritten ephemeral",
    })) as { success: boolean; persistedToSession: boolean };

    expect(result.success).toBe(true);
    expect(result.persistedToSession).toBe(false);
    const warning = fakeIpc
      .sentOn("chat:activity")
      .find((s) => s.payload?.label === "Edit not saved to session history");
    expect(
      warning,
      "expected the visible edit-not-persisted warning",
    ).toBeTruthy();

    // DB untouched on the fallback miss.
    const rows = await ctx.testDb.db.query.sessionMessages.findMany();
    expect(
      rows.some((r: { content: string }) =>
        r.content.includes("rewritten ephemeral"),
      ),
    ).toBe(false);
  });
});
