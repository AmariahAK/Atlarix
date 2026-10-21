import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError } from "../infra/assert";

/**
 * `session_search` against a REAL database: the tool's own behaviour, not its
 * registration. The unit tests cover workspace/orphan scoping with hand-built
 * SQLite; this drives the registered handler over rows that a real turn wrote.
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function search(args: Record<string, unknown>) {
  const { executeSessionSearch } = await import("@/lib/tools/sessions");
  return executeSessionSearch(args as never);
}

describe("session_search over a real session", () => {
  it("finds a fact from an earlier turn, and pages full turns around it", async () => {
    ctx.server.register(
      scenario("s-search")
        .text("Understood, using the staging bucket.")
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt:
        "sc=s-search Deploy to gs://atlarix-staging-7f3a and keep the old bucket alive.",
      mode: "build",
    });
    expectNoStreamError(fakeIpc.sends, chatId);

    const sessionRow = await ctx.testDb.db.query.chatSessions.findFirst();
    expect(sessionRow).toBeTruthy();
    const workspaceId = sessionRow!.workspaceId;

    // The exact-identifier case this tool exists for: a bucket name the user gave
    // once, twenty turns ago, that a summary would have paraphrased away.
    const hit = await search({
      query: "atlarix-staging-7f3a",
      session: "all",
      workspaceId,
    });
    expect(hit.success).toBe(true);
    expect(hit.result).toContain("atlarix-staging-7f3a");
    // The expand view reuses grep's match_list shape.
    expect(hit.ui?.groups?.length).toBeGreaterThan(0);
    expect(hit.ui!.groups[0]!.file).toContain("turn ");

    // read mode returns whole turns, self-paginated like read_file.
    const page = await search({
      mode: "read",
      session: sessionRow!.id,
      workspaceId,
      limit: 5,
      offset: 0,
    });
    expect(page.success).toBe(true);
    expect(page.result).toContain("gs://atlarix-staging-7f3a");
    expect(page.result).toMatch(/turn 1 · user/);
  });

  it("misses cleanly, and refuses without a workspace", async () => {
    const sessionRow = await ctx.testDb.db.query.chatSessions.findFirst();
    const workspaceId = sessionRow!.workspaceId;

    const miss = await search({
      query: "a-string-nobody-ever-typed-42",
      session: "all",
      workspaceId,
    });
    expect(miss.success).toBe(true);
    expect(miss.result).toContain("No messages matching");
    expect(miss.ui?.groups).toEqual([]);

    // workspaceId is harness-injected; without it there is no isolation boundary,
    // so the tool must refuse rather than fall back to "all sessions".
    const noWorkspace = await search({ query: "anything" });
    expect(noWorkspace.success).toBe(false);
    expect(noWorkspace.error).toContain("workspace");

    // A named session that does not exist in this workspace is a clean refusal,
    // never a silent search of everything.
    const badSession = await search({
      query: "anything",
      session: "no-such-session-title",
      workspaceId,
    });
    expect(badSession.success).toBe(false);
    expect(badSession.error).toContain("No session in this workspace");
  });

  it("caps its own output so recovering detail cannot re-inflate the context", async () => {
    const sessionRow = await ctx.testDb.db.query.chatSessions.findFirst();
    const workspaceId = sessionRow!.workspaceId;

    // "e" matches nearly every message; the cap must hold regardless.
    const wide = await search({
      query: "e",
      session: "all",
      workspaceId,
      limit: 2,
    });
    expect(wide.success).toBe(true);
    expect(wide.ui!.groups.length).toBeLessThanOrEqual(2);
  });
});

describe("isolation, against the REAL query", () => {
  /**
   * The unit test in `session-search-scoping.test.ts` mirrors the query shape by
   * hand, which is only as good as the mirror. This drives `executeSessionSearch`
   * itself across two workspaces in one database, so it exercises the actual
   * window-function query — including the JOIN that re-asserts workspace scope.
   */
  it("cannot see another workspace's sessions, by id OR by title", async () => {
    const { chatSessions, sessionMessages } = await import("@/db/schema");
    const db = ctx.testDb.db;

    // A second workspace with its own session and a distinctive secret.
    const { appId: otherWorkspaceId } = await ctx.testDb.seedApp({
      path: "/tmp/other-workspace",
      name: "other-ws",
    });
    await db.insert(chatSessions).values({
      id: "other-ws-session",
      workspaceId: otherWorkspaceId,
      title: "Shared Title",
    });
    await db.insert(sessionMessages).values({
      id: "other-ws-msg",
      sessionId: "other-ws-session",
      role: "user",
      content: "the other workspace's secret is MOMBASA-9",
    });

    const ours = (await db.query.chatSessions.findFirst())!.workspaceId;
    expect(ours).not.toBe(otherWorkspaceId);

    // By content, across "all" our sessions.
    const byContent = await search({
      query: "MOMBASA-9",
      session: "all",
      workspaceId: ours,
    });
    expect(byContent.success).toBe(true);
    expect(byContent.result).toContain("No messages matching");

    // By naming the foreign session id outright.
    const byId = await search({
      query: "MOMBASA-9",
      session: "other-ws-session",
      workspaceId: ours,
    });
    expect(byId.success).toBe(false);
    expect(byId.error).toContain("No session in this workspace");

    // By a title that exists in BOTH workspaces.
    await db.insert(chatSessions).values({
      id: "our-shared-title",
      workspaceId: ours,
      title: "Shared Title",
    });
    await db.insert(sessionMessages).values({
      id: "our-msg",
      sessionId: "our-shared-title",
      role: "user",
      content: "ours is NAIROBI-1",
    });
    const byTitle = await search({
      query: "MOMBASA-9",
      session: "Shared Title",
      workspaceId: ours,
    });
    expect(byTitle.success).toBe(true);
    expect(byTitle.result).toContain("No messages matching");
    // ...and the same lookup DOES find our own row, so the filter is doing the
    // work rather than the query simply being broken.
    const ourOwn = await search({
      query: "NAIROBI-1",
      session: "Shared Title",
      workspaceId: ours,
    });
    expect(ourOwn.result).toContain("NAIROBI-1");

    // The other workspace can still read its own — proving the data was there to
    // leak, and only the scope stopped it.
    const theirs = await search({
      query: "MOMBASA-9",
      session: "all",
      workspaceId: otherWorkspaceId,
    });
    expect(theirs.result).toContain("MOMBASA-9");
  });

  it("returns nothing once the session is deleted", async () => {
    const { chatSessions, sessionMessages } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = ctx.testDb.db;

    const { appId: wsId } = await ctx.testDb.seedApp({
      path: "/tmp/doomed-workspace",
      name: "doomed-ws",
    });
    await db.insert(chatSessions).values({
      id: "doomed-session",
      workspaceId: wsId,
      title: "Doomed",
    });
    await db.insert(sessionMessages).values({
      id: "doomed-msg",
      sessionId: "doomed-session",
      role: "user",
      content: "delete me: KISUMU-3",
    });

    const before = await search({
      query: "KISUMU-3",
      session: "all",
      workspaceId: wsId,
    });
    expect(before.result).toContain("KISUMU-3");

    await db.delete(chatSessions).where(eq(chatSessions.id, "doomed-session"));

    const after = await search({
      query: "KISUMU-3",
      session: "all",
      workspaceId: wsId,
    });
    expect(after.success).toBe(true);
    expect(after.result).toContain("No sessions to search.");
  });
});

describe("the CURRENT conversation — the default the tool advertises", () => {
  /**
   * SHIPPED BROKEN, caught before release. The schema declared
   * `chatId: numberParam("Current chat id (auto-provided)")` and nothing provided
   * it: `execArgs.chatId` is set only for `stream_terminal_output`, while every
   * tool receives `workspaceSessionId` and `_chatSessionId`. So omitting `session`
   * — exactly what the tool's own description tells the model to do for the
   * current conversation — returned "No current session to search", and the only
   * way forward was `session:"all"`.
   *
   * That is why it is a release blocker and not a papercut: the SAFE default was
   * unreachable and the WIDE scope was the fallback. Every test in this file
   * passed `session` explicitly, which is precisely how it got through.
   *
   * These assert the injection CONTRACT — the two argument shapes the two call
   * sites actually produce. If a call site is ever changed to inject something
   * else, one of these fails.
   */

  it("resolves from the injected workspaceSessionId, with no `session` argument", async () => {
    // The shape a turn injects: ask-branch.ts / build-branch.ts set
    // `workspaceSessionId: req.workspaceSessionId`.
    const { chatSessions, sessionMessages } = await import("@/db/schema");
    const db = ctx.testDb.db;
    const { appId } = await ctx.testDb.seedApp({
      path: "/tmp/current-by-uuid",
      name: "current-by-uuid",
    });
    await db.insert(chatSessions).values({
      id: "current-uuid-session",
      workspaceId: appId,
      title: "Current",
    });
    await db.insert(sessionMessages).values({
      id: "current-uuid-msg",
      sessionId: "current-uuid-session",
      role: "user",
      content: "the marker is NAIROBI-118",
    });
    // A second session in the SAME workspace that must NOT be searched — this is
    // what distinguishes "resolved the current one" from "quietly searched all".
    await db.insert(chatSessions).values({
      id: "other-uuid-session",
      workspaceId: appId,
      title: "Other",
    });
    await db.insert(sessionMessages).values({
      id: "other-uuid-msg",
      sessionId: "other-uuid-session",
      role: "user",
      content: "the marker is NAIROBI-118 as well",
    });

    const hit = await search({
      query: "NAIROBI-118",
      workspaceId: appId,
      workspaceSessionId: "current-uuid-session",
    });
    expect(hit.success).toBe(true);
    expect(hit.result).toContain("NAIROBI-118");
    // Exactly one session's worth of hits: the current one, not both.
    expect(hit.result).toContain("Current");
    expect(hit.result).not.toContain("Other");
  });

  it("falls back to the injected _chatSessionId — the sub-agent shape", async () => {
    // run-subagent.ts injects `_chatSessionId` and no `workspaceSessionId`, so the
    // uuid path above cannot be the only one that works.
    const { chatSessions, sessionMessages } = await import("@/db/schema");
    const db = ctx.testDb.db;
    const { appId } = await ctx.testDb.seedApp({
      path: "/tmp/current-by-chatid",
      name: "current-by-chatid",
    });
    // A live transport in THIS process, bound to the session, as the parent
    // turn's is: the shared column alone is not trusted, another process's
    // transport may carry the number (1a), and a bare bound number with no
    // transport behind it isn't one either.
    const { bindTransportToSession, createStreamTransport, deleteStreamTransport } = await import(
      "@/lib/chat/stream-transport"
    );
    const transportChatId = createStreamTransport(appId);
    await db.insert(chatSessions).values({
      id: "current-chatid-session",
      workspaceId: appId,
      title: "Sub-agent parent",
      streamChatId: transportChatId,
    });
    bindTransportToSession(transportChatId, "current-chatid-session");
    await db.insert(sessionMessages).values({
      id: "current-chatid-msg",
      sessionId: "current-chatid-session",
      role: "user",
      content: "the marker is MOMBASA-77",
    });

    const hit = await search({
      query: "MOMBASA-77",
      workspaceId: appId,
      _chatSessionId: transportChatId,
    });
    deleteStreamTransport(transportChatId);
    expect(hit.success).toBe(true);
    expect(hit.result).toContain("MOMBASA-77");
  });

  it("refuses when the harness injected neither — never widens to every session", async () => {
    const { chatSessions, sessionMessages } = await import("@/db/schema");
    const db = ctx.testDb.db;
    const { appId } = await ctx.testDb.seedApp({
      path: "/tmp/current-none",
      name: "current-none",
    });
    await db.insert(chatSessions).values({
      id: "unreachable-session",
      workspaceId: appId,
      title: "Unreachable",
    });
    await db.insert(sessionMessages).values({
      id: "unreachable-msg",
      sessionId: "unreachable-session",
      role: "user",
      content: "the marker is ELDORET-9",
    });

    const out = await search({ query: "ELDORET-9", workspaceId: appId });
    // A clean refusal. The failure mode that matters is the opposite one: falling
    // through to every session in the workspace because none was resolved.
    expect(out.success).toBe(false);
    expect(out.result ?? "").not.toContain("ELDORET-9");
  });

  it("a model-supplied session id still cannot cross workspaces", async () => {
    // `session` IS model-facing, unlike the two injected names. The workspace
    // re-read is what makes that safe, and it applies to the default path too.
    const { chatSessions } = await import("@/db/schema");
    const db = ctx.testDb.db;
    const { appId: mine } = await ctx.testDb.seedApp({
      path: "/tmp/xws-mine",
      name: "xws-mine",
    });
    const { appId: theirs } = await ctx.testDb.seedApp({
      path: "/tmp/xws-theirs",
      name: "xws-theirs",
    });
    await db.insert(chatSessions).values({
      id: "their-session",
      workspaceId: theirs,
      title: "Theirs",
    });

    const out = await search({
      query: "anything",
      session: "their-session",
      workspaceId: mine,
    });
    expect(out.success).toBe(false);
    expect(out.error).toContain("No session in this workspace");
  });
});
