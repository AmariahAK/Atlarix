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
  // Leftovers from an earlier launch: an hour old. A session another process
  // created moments ago is its, never reused or pruned (A7, FRESH_EMPTY_MS).
  const created = new Date(Date.now() - 60 * 60_000);
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
    (
      await ctx.testDb.db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, id))
    ).length > 0
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

  it("KEEPS a session that has been written to, and reuses it if it holds nothing", async () => {
    // REVISED 2026-09-01. This test used to assert `not.toBe("guard-touched")` —
    // that a drifted `updatedAt` disqualified a session from reuse as well as from
    // deletion. That was the v14.38.4 guard's mistake and it caused the Untitled
    // litter: see the "reuse SURVIVES being reused" describe below for the loop.
    //
    // The guarantee this test exists for is UNCHANGED and still asserted: the row
    // is never destroyed. What changed is that a timestamp alone no longer costs
    // the user a new session on every start, because the re-count is authoritative
    // about whether a conversation is in there.
    const { appId } = await ctx.testDb.seedApp({
      path: "/tmp/reuse-guard-2",
      name: "reuse-guard-2",
    });
    await seedSession(appId, "guard-touched", { messages: 0, touch: true });

    const { startWorkspaceSession } = await import(
      "@/ipc/handlers/workspace_session_handlers"
    );
    const started = await startWorkspaceSession(appId);

    expect(started.sessionId).toBe("guard-touched");
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

describe("reuse SURVIVES being reused — the Untitled-litter regression", () => {
  /**
   * OBSERVED 2026-09-01, one day after the guard above shipped. The sidebar filled
   * with empty "Untitled" sessions: three in the owner's DB, one (cdf6f368) with
   * zero messages and 11,783 seconds of `updatedAt` drift, permanently unreusable
   * and permanently unprunable.
   *
   * THE LOOP. `startWorkspaceSession` ends by binding a fresh transport to
   * whatever session it settled on — INCLUDING one it has just reused — and
   * `persistSessionStreamChatId` used to set `updatedAt: new Date()`. So:
   *
   *   start 1  create A, bind A          → A.updated == A.created (same second)
   *   start 2  reuse A, bind A           → A.updated  >  A.created, forever
   *   start 3  A refused (drift), create B
   *   start 4  B refused, create C …
   *
   * Nothing ever un-drifts a timestamp, so every start minted a row that could
   * never be reused or pruned again. The fix is two-sided: binding a transport no
   * longer counts as activity, and the drift condition now gates only the
   * DESTRUCTIVE prune, never reuse.
   *
   * This asserts the loop directly — the same workspace opened three times — which
   * is the shape no single-start test could catch.
   */
  it("reuses the SAME empty session across repeated starts", async () => {
    const { appId } = await ctx.testDb.seedApp({
      path: "/tmp/reuse-repeat",
      name: "reuse-repeat",
    });
    const { startWorkspaceSession } = await import(
      "@/ipc/handlers/workspace_session_handlers"
    );

    const first = await startWorkspaceSession(appId);
    const second = await startWorkspaceSession(appId);
    const third = await startWorkspaceSession(appId);

    // One conversation-less session, not three.
    expect(second.sessionId).toBe(first.sessionId);
    expect(third.sessionId).toBe(first.sessionId);

    const { chatSessions } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await ctx.testDb.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.workspaceId, appId));
    expect(rows).toHaveLength(1);
  });

  it("binding a transport does not count as activity", async () => {
    // The root cause in isolation, and it needs a session created in an EARLIER
    // second than the bind. `created_at`/`updated_at` are `unixepoch()` — whole
    // seconds — so a session created and bound inside one start shows zero drift
    // even with the bug present, and a test built that way measures nothing.
    // (Same trap as the `"x".repeat(n)` token fixture: the units hide the effect.)
    const { appId } = await ctx.testDb.seedApp({
      path: "/tmp/reuse-bind-clean",
      name: "reuse-bind-clean",
    });
    const { chatSessions } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    // Second-aligned: the columns are `unixepoch()`, so a Date carrying millis
    // never compares equal to what comes back out.
    const past = new Date(Math.floor((Date.now() - 5 * 60_000) / 1000) * 1000);
    await ctx.testDb.db.insert(chatSessions).values({
      id: "bind-clean",
      workspaceId: appId,
      title: "Untitled",
      createdAt: past,
      updatedAt: past,
    });

    const { startWorkspaceSession } = await import(
      "@/ipc/handlers/workspace_session_handlers"
    );
    const started = await startWorkspaceSession(appId);
    expect(started.sessionId).toBe("bind-clean");

    const [row] = await ctx.testDb.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, "bind-clean"));
    // Untouched: reusing and binding a session is not something that happened IN
    // the conversation. If this drifts, the next start refuses the row and mints
    // an Untitled instead — forever.
    expect(row!.updatedAt.getTime()).toBe(past.getTime());
    // …and the binding itself still happened.
    expect(row!.streamChatId).toBe(started.chatId);
  });

  it("still reuses a session whose timestamp already drifted, but never PRUNES it", async () => {
    // Heals the rows already poisoned in the field (cdf6f368 and friends): drift
    // with zero messages must not disqualify reuse. Prune stays conservative.
    const { appId } = await ctx.testDb.seedApp({
      path: "/tmp/reuse-drifted",
      name: "reuse-drifted",
    });
    await seedSession(appId, "drifted-empty", { messages: 0, touch: true });

    const { startWorkspaceSession } = await import(
      "@/ipc/handlers/workspace_session_handlers"
    );
    const started = await startWorkspaceSession(appId);

    expect(started.sessionId).toBe("drifted-empty");
    expect(await sessionExists("drifted-empty")).toBe(true);
  });

  it("a drifted empty session is still never DELETED as a prune candidate", async () => {
    // The asymmetry, asserted on the DESTRUCTIVE side — and it only tests anything
    // if the drifted session is actually a prune candidate. `pickSessionReuse`
    // takes the newest empty as the reuse target, so seeding both "now" hands the
    // drifted one the reuse slot and the prune branch never sees it. The drifted
    // row must therefore be OLDER, with the clean row newest.
    const { appId } = await ctx.testDb.seedApp({
      path: "/tmp/prune-drifted",
      name: "prune-drifted",
    });
    const { chatSessions } = await import("@/db/schema");
    const sec = (ms: number) => new Date(Math.floor(ms / 1000) * 1000);
    const now = Date.now();
    // Old, empty, and drifted → a prune target that must survive anyway.
    await ctx.testDb.db.insert(chatSessions).values({
      id: "prune-drifted-touched",
      workspaceId: appId,
      title: "Untitled",
      createdAt: sec(now - 10 * 60_000),
      updatedAt: sec(now - 9 * 60_000),
    });
    // Newest and untouched → wins the reuse slot. Still older than the 2 min an
    // empty another process just created counts as its own (A7), or it is no
    // candidate at all and the drifted row takes the reuse slot.
    await ctx.testDb.db.insert(chatSessions).values({
      id: "prune-clean",
      workspaceId: appId,
      title: "Untitled",
      createdAt: sec(now - 5 * 60_000),
      updatedAt: sec(now - 5 * 60_000),
    });

    const { startWorkspaceSession } = await import(
      "@/ipc/handlers/workspace_session_handlers"
    );
    const started = await startWorkspaceSession(appId);

    expect(started.sessionId).toBe("prune-clean");
    expect(await sessionExists("prune-drifted-touched")).toBe(true);
  });
});

/**
 * v14.52.0: switching to an older session removes the empty one LEFT behind —
 * through the same guard as reuse, because a wrong "empty" deletes a
 * conversation.
 */
describe("pruning the session the user left", () => {
  const prune = async (id: string) => {
    const { pruneSessionIfEmpty } = await import(
      "@/ipc/handlers/workspace_session_handlers"
    );
    return pruneSessionIfEmpty(id);
  };

  it("removes a fresh, untouched, default-titled empty session", async () => {
    await seedSession(1, "left-empty");
    expect((await prune("left-empty")).pruned).toBe(true);
    expect(await sessionExists("left-empty")).toBe(false);
  });

  it("never removes one with a message", async () => {
    await seedSession(1, "left-with-message", { messages: 1 });
    expect((await prune("left-with-message")).pruned).toBe(false);
    expect(await sessionExists("left-with-message")).toBe(true);
  });

  it("never removes one the user named", async () => {
    await seedSession(1, "left-named", { title: "Keep me" });
    expect((await prune("left-named")).pruned).toBe(false);
    expect(await sessionExists("left-named")).toBe(true);
  });

  it("never removes one that has been written to", async () => {
    await seedSession(1, "left-touched", { touch: true });
    expect((await prune("left-touched")).pruned).toBe(false);
    expect(await sessionExists("left-touched")).toBe(true);
  });
});
