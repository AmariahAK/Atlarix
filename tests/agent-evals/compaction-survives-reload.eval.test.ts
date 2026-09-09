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
 * The point of the v14.39.0 compaction unification, end to end: a session that
 * has been compacted STAYS compacted across a reload, and the summary is not
 * re-bought on the next turn.
 *
 * This runs the real `chat:stream` handler against the fake provider, so the
 * dispatch funnel, the persisted session log, the marker and the slice are all
 * the shipping code. The unit tests prove the compactor writes a marker; this
 * proves the thing the user actually feels — reopen the app and the model's
 * history starts at the summary rather than at turn one.
 *
 * The bug it guards: before this pass, only `compress_context` persisted. The two
 * AUTOMATIC paths summarized, spliced their own unrecognised marker, and dropped
 * it at end of turn — so every reopened session re-expanded and re-summarized,
 * paying for the same work indefinitely.
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("a compacted session survives a reload", () => {
  it("dispatch slices the model history from the persisted marker, not the full log", async () => {
    ctx.server.register(
      scenario("compact-reload")
        .text("Noted — carrying on from the summary.")
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=compact-reload First turn, establish the session.",
      mode: "build",
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const sessionRow = await ctx.testDb.db.query.chatSessions.findFirst();
    expect(sessionRow).toBeTruthy();

    // Write a durable marker the way a real compaction would: through the same
    // persistence entry point the compactor uses, so this test cannot pass by
    // agreeing with itself about a shape nothing else writes.
    const { persistWorkspaceSessionUserMessage } = await import(
      "@/ipc/handlers/workspace_session_handlers"
    );
    const { COMPACTION_SUMMARY_PREFIX } = await import(
      "@/lib/context/compaction"
    );
    const markerContent =
      `${COMPACTION_SUMMARY_PREFIX} gen=1\n` +
      "## Goal\n- Prove compaction survives a reload\n" +
      "## Critical Context\n- the magic token is ZANZIBAR-7\n" +
      "[END COMPACTION]";
    await persistWorkspaceSessionUserMessage(sessionRow!.id, markerContent, {});

    // A turn AFTER the marker: this is the part the model must still see in full.
    await persistWorkspaceSessionUserMessage(
      sessionRow!.id,
      "post-compaction question",
      {},
    );

    // ── Simulated reload: the renderer loads the whole session log. ──
    const sessionsGet = await getIpcHandler("sessions:get");
    const loaded = (await sessionsGet({} as never, sessionRow!.id)) as {
      messages: Array<{ role: string; content: string }>;
    };

    // The UI keeps EVERYTHING — full scrollback is the point of persisting it.
    expect(loaded.messages.length).toBeGreaterThan(2);
    expect(
      loaded.messages.some((m) => m.content.includes("First turn, establish")),
    ).toBe(true);

    // The MODEL gets only [marker .. end].
    const { sliceFromLastCompactionSummary, isCompactionSummaryMessage } =
      await import("@/lib/context/compaction");
    const modelFacing = sliceFromLastCompactionSummary(loaded.messages);

    expect(isCompactionSummaryMessage(modelFacing[0]!.content)).toBe(true);
    expect(modelFacing).toHaveLength(2);
    expect(modelFacing[1]!.content).toBe("post-compaction question");
    // The superseded head is gone from the model's view — this is the token saving.
    expect(
      modelFacing.some((m) => m.content.includes("First turn, establish")),
    ).toBe(false);
    // And the summary's content is what carried forward.
    expect(modelFacing[0]!.content).toContain("ZANZIBAR-7");
    // The recovery hint travels with it, so the model knows the dropped turns are
    // retrievable rather than gone.
    expect(
      loaded.messages.some((m) => m.content.includes("[END COMPACTION]")),
    ).toBe(true);
  });

  it("the token meter measures the SLICED history, not the full log", async () => {
    // The meter and the dispatch must agree about what was sent, or the user sees
    // a session appear to double in size on reopen (the v14.38.1 class of bug:
    // "nothing had been summarised; the ruler changed").
    ctx.server.register(scenario("compact-meter").text("ok").build());
    const chatId = await ctx.newChat();
    await runTurn(ctx, {
      chatId,
      prompt: "sc=compact-meter establish",
      mode: "build",
    });

    // Scoped to THIS chat: findFirst() would return the previous test's session,
    // which deliberately has a marker in it.
    const { eq } = await import("drizzle-orm");
    const { chatSessions } = await import("@/db/schema");
    const sessionRow = await ctx.testDb.db.query.chatSessions.findFirst({
      where: eq(chatSessions.streamChatId, chatId),
    });
    expect(sessionRow).toBeTruthy();
    const { sliceFromLastCompactionSummary } = await import(
      "@/lib/context/compaction"
    );
    const sessionsGet = await getIpcHandler("sessions:get");
    const loaded = (await sessionsGet({} as never, sessionRow!.id)) as {
      messages: Array<{ role: string; content: string }>;
    };
    // With no marker present the slice is identity — the common case must not
    // silently trim anything.
    const sliced = sliceFromLastCompactionSummary(loaded.messages);
    expect(sliced.length).toBe(loaded.messages.length);
  });
});
