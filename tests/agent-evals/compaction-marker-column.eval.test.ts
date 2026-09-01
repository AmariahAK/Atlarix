import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, type EvalContext } from "../infra/turn";

/**
 * The compaction marker's `kind` column, end to end against a real database.
 *
 * The unit tests in `src/__tests__/compaction-marker-kind.test.ts` cover the
 * detector's logic. This covers the part that logic depends on and that no unit
 * test can see: that the column is actually WRITTEN, and that it actually
 * SURVIVES the trip back out through hydration. `kind` was dropped at three
 * separate hops before this change (`joinTransportRows`, `hydrateStreamTransport`,
 * and the dispatch `.map()`) — the same shape of bug both of those functions
 * already carry a comment about for `maxTokensUsed`, which silently halved the
 * context meter for a release.
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("the durable row carries its kind", () => {
  it("persistCompactionSummaryToSession writes kind=compaction_marker", async () => {
    const { chatSessions, sessionMessages } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = ctx.testDb.db;
    const { appId } = await ctx.testDb.seedApp({
      path: "/tmp/marker-kind",
      name: "marker-kind",
    });
    await db.insert(chatSessions).values({
      id: "marker-kind-session",
      workspaceId: appId,
      title: "Untitled",
    });

    const { persistCompactionSummaryToSession, COMPACTION_SUMMARY_PREFIX } =
      await import("@/lib/context/compaction");
    const ok = await persistCompactionSummaryToSession(
      undefined,
      [
        { role: "user", content: "earlier" },
        {
          role: "user",
          kind: "compaction_marker",
          content: `${COMPACTION_SUMMARY_PREFIX} gen=1\nbody\n[END COMPACTION]`,
        },
      ],
      "marker-kind-session",
    );
    expect(ok).toBe(true);

    const rows = await db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, "marker-kind-session"));
    expect(rows).toHaveLength(1);
    // The column, not the bytes. This is the assertion the whole change is for.
    expect(rows[0]!.kind).toBe("compaction_marker");
  });

  it("an ordinary user message is still kind=message", async () => {
    // The default must not have moved: everything else in the app writes through
    // this same helper.
    const { chatSessions, sessionMessages } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = ctx.testDb.db;
    const { appId } = await ctx.testDb.seedApp({
      path: "/tmp/marker-default",
      name: "marker-default",
    });
    await db.insert(chatSessions).values({
      id: "marker-default-session",
      workspaceId: appId,
      title: "Untitled",
    });

    const { persistWorkspaceSessionUserMessage } = await import(
      "@/ipc/handlers/workspace_session_handlers"
    );
    await persistWorkspaceSessionUserMessage(
      "marker-default-session",
      "just a message",
      {},
    );

    const [row] = await db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, "marker-default-session"));
    expect(row!.kind).toBe("message");
  });
});

describe("kind survives the trip back to the model", () => {
  it("joinTransportRows carries it, so the dispatch slice can see it", async () => {
    const { joinTransportRows } = await import(
      "@/ipc/handlers/workspace_session_handlers"
    );
    const now = new Date();
    const joined = joinTransportRows(
      [
        {
          id: "row-marker",
          sessionId: "s",
          role: "user",
          content: "[COMPACTION MARKER] gen=1\nbody",
          kind: "compaction_marker",
          status: "complete",
          createdAt: now,
        },
        {
          id: "row-plain",
          sessionId: "s",
          role: "user",
          content: "hello",
          kind: "message",
          status: "complete",
          createdAt: now,
        },
      ],
      [
        { id: 1, sessionRowId: "row-marker" },
        { id: 2, sessionRowId: "row-plain" },
      ] as never,
    );
    expect(joined[0]!.kind).toBe("compaction_marker");
    expect(joined[1]!.kind).toBe("message");
  });

  it("hydrateStreamTransport keeps it on the live message", async () => {
    const { createStreamTransport, hydrateStreamTransport, getStreamTransport } =
      await import("@/lib/chat/stream-transport");
    const { appId } = await ctx.testDb.seedApp({
      path: "/tmp/marker-hydrate",
      name: "marker-hydrate",
    });
    const chatId = createStreamTransport(appId);
    hydrateStreamTransport(chatId, [
      { role: "user", content: "one" },
      {
        role: "user",
        content: "[COMPACTION MARKER] gen=1\nbody",
        kind: "compaction_marker",
      },
      { role: "assistant", content: "after" },
    ]);

    const chat = getStreamTransport(chatId);
    const msgs = chat!.messages as Array<{ content: string; kind?: string }>;
    expect(msgs[1]!.kind).toBe("compaction_marker");

    // And the slice built on top of it lands on the right boundary.
    const { sliceFromLastCompactionSummary } = await import(
      "@/lib/context/compaction"
    );
    expect(sliceFromLastCompactionSummary(msgs as never)).toHaveLength(2);
  });
});

describe("the trim never deletes a marker", () => {
  it("skips markers and takes the next-oldest rows instead", async () => {
    // Driven directly: the real gate is SESSION_STORE_MESSAGE_MAX = 100_000, so
    // an end-to-end fixture would be measuring the database rather than the
    // decision.
    const { selectTrimmableMessageIds } = await import(
      "@/ipc/handlers/workspace_session_handlers"
    );
    const rows = [
      { id: "a", kind: "message" },
      { id: "marker", kind: "compaction_marker" },
      { id: "b", kind: "message" },
      { id: "c", kind: "message" },
      { id: "d", kind: "message" },
    ];
    // Two over the cap: without the exemption this would delete "a" and "marker".
    const ids = selectTrimmableMessageIds(rows, 3);
    expect(ids).toEqual(["a", "b"]);
    expect(ids).not.toContain("marker");
  });

  it("deletes nothing while under the cap", async () => {
    const { selectTrimmableMessageIds } = await import(
      "@/ipc/handlers/workspace_session_handlers"
    );
    expect(
      selectTrimmableMessageIds([{ id: "a", kind: "message" }], 3),
    ).toEqual([]);
  });

  it("a session of nothing but markers loses none of them", async () => {
    // The degenerate end of the exemption, stated rather than left to inference:
    // the cap yields to marker durability, it does not win a tie.
    const { selectTrimmableMessageIds } = await import(
      "@/ipc/handlers/workspace_session_handlers"
    );
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      kind: "compaction_marker",
    }));
    expect(selectTrimmableMessageIds(rows, 2)).toEqual([]);
  });
});

describe("the marker is bookkeeping, so it stays out of what the user and model read", () => {
  async function seedWithMarker(name: string) {
    const { chatSessions, sessionMessages } = await import("@/db/schema");
    const db = ctx.testDb.db;
    const { appId } = await ctx.testDb.seedApp({
      path: `/tmp/${name}`,
      name,
    });
    await db.insert(chatSessions).values({
      id: `${name}-s`,
      workspaceId: appId,
      title: "Session",
    });
    const sec = (n: number) => new Date(Math.floor(Date.now() / 1000) * 1000 + n * 1000);
    // Distinct seconds: created_at is unixepoch(), so same-second rows tie and
    // the turn numbering below would be undefined.
    await db.insert(sessionMessages).values([
      { id: `${name}-1`, sessionId: `${name}-s`, role: "user", content: "deploy to KISUMU-4", createdAt: sec(0) },
      {
        id: `${name}-2`,
        sessionId: `${name}-s`,
        role: "user",
        kind: "compaction_marker",
        content: "[COMPACTION MARKER] gen=1\nthe user mentioned KISUMU-4\n[END COMPACTION]",
        createdAt: sec(1),
      },
      { id: `${name}-3`, sessionId: `${name}-s`, role: "assistant", content: "done with KISUMU-4", createdAt: sec(2) },
      {
        id: `${name}-4`,
        sessionId: `${name}-s`,
        role: "user",
        // A LEGACY marker: no kind, prefix only. Must be excluded too.
        content: "[COMPACTION MARKER]\nlegacy summary of KISUMU-4\n[END COMPACTION]",
        createdAt: sec(3),
      },
    ]);
    return { appId, sessionId: `${name}-s` };
  }

  async function search(args: Record<string, unknown>) {
    const { executeSessionSearch } = await import("@/lib/tools/sessions");
    return executeSessionSearch(args as never);
  }

  it("session_search does not return marker rows as conversation", async () => {
    const { appId } = await seedWithMarker("ss-marker");
    const hit = await search({ query: "KISUMU-4", session: "all", workspaceId: appId });
    expect(hit.success).toBe(true);
    // The two real turns match; neither summary does — including the legacy one,
    // which has no `kind` and is caught by the content clause.
    expect(hit.result).toContain("KISUMU-4");
    expect(hit.result).not.toContain("[COMPACTION MARKER]");
    expect(hit.result).not.toContain("legacy summary");
    expect(hit.ui!.groups).toHaveLength(2);
  });

  it("read mode pages past them, and its turn numbers match search's", async () => {
    const { appId, sessionId } = await seedWithMarker("ss-read");
    const page = await search({
      mode: "read",
      session: sessionId,
      workspaceId: appId,
      limit: 10,
      offset: 0,
    });
    expect(page.success).toBe(true);
    expect(page.result).not.toContain("[COMPACTION MARKER]");
    // Two turns, and the total reported to the model counts the same filtered
    // set — a total that included hidden rows would make the model page into
    // nothing.
    expect(page.result).toMatch(/turn 1 · user/);
    expect(page.result).toMatch(/turn 2 · assistant/);
    expect(page.result).not.toMatch(/turn 3/);
  });

  it("the UI filter drops a marker but keeps the conversation", async () => {
    // The renderer's choke point (SimpleInlineChat's `visibleMessages`) uses this
    // predicate. Asserted on the predicate rather than through React, since the
    // filter IS the behaviour.
    const { isCompactionSummaryMessage } = await import(
      "@/lib/chat/compaction-marker"
    );
    const thread = [
      { role: "user", content: "hello" },
      { role: "user", content: "[COMPACTION MARKER] gen=1\nx", kind: "compaction_marker" },
      { role: "user", content: "[COMPACTION MARKER]\nlegacy" },
      { role: "assistant", content: "hi" },
    ];
    const visible = thread.filter((m) => !isCompactionSummaryMessage(m));
    expect(visible.map((m) => m.content)).toEqual(["hello", "hi"]);
  });
});
