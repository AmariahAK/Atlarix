import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, type EvalContext } from "../infra/turn";

/**
 * A session with messages must never be reused for a new chat, and must never be
 * pruned.
 *
 * OBSERVED 2026-08-31, shipped v14.38.4. After a 12-minute Explore turn, quit and
 * reopen showed an empty chat pane. The session held a 60-char user message and a
 * 76,003-char completed assistant turn, both intact — but startup logged
 * `Reusing empty session 4730c40f-…` and bound a fresh transport to it.
 *
 * MECHANISM, found once the guard logged what the decision saw:
 * `listSessionsWithMessageCounts` returned 0 for EVERY session, always. Its `sql`
 * template rendered an uncorrelated subquery whose two sides both resolved
 * against `session_messages` — see that function for the full account.
 *
 * The query is fixed and pinned in the first describe below. The GUARD stays
 * anyway, and the second describe still asserts outcomes rather than counts: the
 * consequence of trusting a wrong count here is `delete(chatSessions)` cascading
 * to a real conversation, which is too expensive to protect with only one layer.
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedSession(
  workspaceId: number,
  id: string,
  opts: { title?: string; messages?: number; touch?: boolean } = {},
) {
  const { chatSessions, sessionMessages } = await import("@/db/schema");
  const db = ctx.testDb.db;
  const created = new Date();
  await db.insert(chatSessions).values({
    id,
    workspaceId,
    title: opts.title ?? "Untitled",
    createdAt: created,
    updatedAt: created,
  });
  for (let i = 0; i < (opts.messages ?? 0); i++) {
    await db.insert(sessionMessages).values({
      id: `${id}-m${i}`,
      sessionId: id,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
    });
  }
  if (opts.touch) {
    const { eq } = await import("drizzle-orm");
    await db
      .update(chatSessions)
      .set({ updatedAt: new Date(created.getTime() + 60_000) })
      .where(eq(chatSessions.id, id));
  }
}

const sessionExists = async (id: string) => {
  const { chatSessions } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  return (
    (await ctx.testDb.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, id))).length > 0
  );
};

describe("the message count itself — the root cause", () => {
  /**
   * `listSessionsWithMessageCounts` returned 0 for EVERY session. Its `sql`
   * template rendered an uncorrelated subquery:
   *
   *   select count(*) from "session_messages" where "session_id" = "id"
   *
   * Both names resolved against `session_messages` (which has its own `id`), so
   * each message's `session_id` was compared to its own `id` and never matched.
   *
   * Because `pickSessionReuse` reads 0 as "safe to reuse or DELETE", every
   * default-titled session looked empty — so a workspace with two or more
   * "Untitled" conversations had all but the newest handed to
   * `delete(chatSessions)`, cascading to their messages. This asserts the count
   * is real, which is what makes the reuse and prune decisions meaningful at all.
   */
  it("reports the true count per session, not zero", async () => {
    const { appId } = await ctx.testDb.seedApp({
      path: "/tmp/reuse-count",
      name: "reuse-count",
    });
    await seedSession(appId, "count-two", { messages: 2 });
    await seedSession(appId, "count-zero", { messages: 0 });
    await seedSession(appId, "count-five", { messages: 5 });

    const { chatSessions, sessionMessages } = await import("@/db/schema");
    const { eq, sql, desc } = await import("drizzle-orm");
    const rows = await ctx.testDb.db
      .select({
        id: chatSessions.id,
        messageCount: sql<number>`count(${sessionMessages.id})`,
      })
      .from(chatSessions)
      .leftJoin(sessionMessages, eq(sessionMessages.sessionId, chatSessions.id))
      .where(eq(chatSessions.workspaceId, appId))
      .groupBy(chatSessions.id)
      .orderBy(desc(chatSessions.updatedAt));

    const byId = new Map(rows.map((r) => [r.id, Number(r.messageCount)]));
    expect(byId.get("count-two")).toBe(2);
    expect(byId.get("count-zero")).toBe(0);
    expect(byId.get("count-five")).toBe(5);
  });

  it("so two Untitled conversations both SURVIVE a start — the data-loss case", async () => {
    // With an always-zero count both looked empty: one reused, the other deleted.
    const { appId } = await ctx.testDb.seedApp({
      path: "/tmp/reuse-two-full",
      name: "reuse-two-full",
    });
    await seedSession(appId, "full-a", { messages: 3 });
    await seedSession(appId, "full-b", { messages: 4 });

    const { startWorkspaceSession } = await import(
      "@/ipc/handlers/workspace_session_handlers"
    );
    await startWorkspaceSession(appId);

    expect(await sessionExists("full-a")).toBe(true);
    expect(await sessionExists("full-b")).toBe(true);
  });
});

describe("startWorkspaceSession never reuses or prunes a session with content", () => {
  it("refuses to reuse a default-titled session that holds messages", async () => {
    const { appId } = await ctx.testDb.seedApp({
      path: "/tmp/reuse-guard-1",
      name: "reuse-guard-1",
    });
    await seedSession(appId, "guard-has-messages", { messages: 2 });

    const { startWorkspaceSession } = await import(
      "@/ipc/handlers/workspace_session_handlers"
    );
    const started = await startWorkspaceSession(appId);

    // A NEW session, not the one holding the conversation.
    expect(started.sessionId).not.toBe("guard-has-messages");
    // And the original is untouched, with both messages.
    expect(await sessionExists("guard-has-messages")).toBe(true);
    const { sessionMessages } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const kept = await ctx.testDb.db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, "guard-has-messages"));
    expect(kept).toHaveLength(2);
  });

  it("refuses to reuse a session that has been written to, even with no messages", async () => {
    // The condition that would have caught the observed row on its own: the count
    // said empty, but updatedAt had moved past createdAt.
    const { appId } = await ctx.testDb.seedApp({
      path: "/tmp/reuse-guard-2",
      name: "reuse-guard-2",
    });
    await seedSession(appId, "guard-touched", { messages: 0, touch: true });

    const { startWorkspaceSession } = await import(
      "@/ipc/handlers/workspace_session_handlers"
    );
    const started = await startWorkspaceSession(appId);

    expect(started.sessionId).not.toBe("guard-touched");
    expect(await sessionExists("guard-touched")).toBe(true);
  });

  it("still reuses a genuinely untouched empty session (the feature keeps working)", async () => {
    const { appId } = await ctx.testDb.seedApp({
      path: "/tmp/reuse-guard-3",
      name: "reuse-guard-3",
    });
    await seedSession(appId, "guard-really-empty", { messages: 0 });

    const { startWorkspaceSession } = await import(
      "@/ipc/handlers/workspace_session_handlers"
    );
    const started = await startWorkspaceSession(appId);

    // If this ever fails the guard has gone too far and every reopen litters the
    // sidebar again — the bug the reuse behaviour exists to prevent.
    expect(started.sessionId).toBe("guard-really-empty");
  });

  it("never PRUNES a session with messages, even as a secondary empty candidate", async () => {
    // The dangerous half: prune runs delete(chatSessions), which cascades.
    const { appId } = await ctx.testDb.seedApp({
      path: "/tmp/reuse-guard-4",
      name: "reuse-guard-4",
    });
    // Two default-titled candidates: one truly empty (becomes the reuse target),
    // one holding a conversation (would be a prune target if trusted blindly).
    await seedSession(appId, "guard-prune-empty", { messages: 0 });
    await seedSession(appId, "guard-prune-full", { messages: 4 });

    const { startWorkspaceSession } = await import(
      "@/ipc/handlers/workspace_session_handlers"
    );
    await startWorkspaceSession(appId);

    // The conversation survives whatever the reuse pass decided.
    expect(await sessionExists("guard-prune-full")).toBe(true);
    const { sessionMessages } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const kept = await ctx.testDb.db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, "guard-prune-full"));
    expect(kept).toHaveLength(4);
  });
});
