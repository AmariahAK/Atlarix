import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getIpcHandler, setupEvalContext, type EvalContext } from "../infra/turn";

/**
 * Session lineage through the real database and handlers: a chat started by
 * another one records where it came from (a /fork, a peer's message to a
 * session with no row yet, an automation an agent set up), and every list of
 * past chats (sessions:list, which the app, CLI /resume, VS Code and ACP all
 * read) shows it under its parent from the first turn.
 */

let ctx: EvalContext;
beforeAll(async () => {
  ctx = await setupEvalContext();
});
afterAll(async () => {
  await ctx.cleanup();
});

const call = async <T>(channel: string, ...args: unknown[]): Promise<T> =>
  (await (await getIpcHandler(channel))({} as never, ...(args as [never]))) as T;

async function seed(workspaceId: number, id: string, opts: { minutesAgo?: number; parent?: string; kind?: "normal" | "background"; origin?: object } = {}) {
  const { chatSessions, sessionMessages } = await import("@/db/schema");
  const when = new Date(Date.now() - (opts.minutesAgo ?? 60) * 60_000);
  await ctx.testDb.db.insert(chatSessions).values({
    id,
    workspaceId,
    title: id,
    kind: opts.kind ?? "normal",
    parentSessionId: opts.parent ?? null,
    origin: opts.origin ? JSON.stringify(opts.origin) : null,
    createdAt: when,
    updatedAt: when,
  });
  await ctx.testDb.db.insert(sessionMessages).values({ id: `${id}-m`, sessionId: id, role: "user", content: "hi" });
}

async function stored(id: string) {
  const { chatSessions } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const [r] = await ctx.testDb.db.select().from(chatSessions).where(eq(chatSessions.id, id));
  return { parent: r?.parentSessionId ?? null, origin: r?.origin ? JSON.parse(r.origin) : null };
}

type Listed = { id: string; depth: number; runs?: number; parentTitle?: string };

describe("where a chat came from is recorded", () => {
  it("a /fork is its source's child, from the first moment", async () => {
    const { appId } = await ctx.testDb.seedApp({ path: "/tmp/lineage-fork", name: "lineage-fork" });
    await seed(appId, "source");
    const fork = await call<{ id: string; parentSessionId: string; origin: { via: string } }>("sessions:fork", "source");
    expect(fork.parentSessionId).toBe("source");
    expect(fork.origin.via).toBe("fork");
    expect((await stored(fork.id)).origin).toMatchObject({ via: "fork", surface: "app" });

    const listed = await call<Listed[]>("sessions:list", appId);
    expect(listed.map((r) => [r.id, r.depth])).toEqual([
      ["source", 0],
      [fork.id, 1],
    ]);
  });

  it("a session a peer's message started is that peer's child, new or a reused empty row", async () => {
    const { startWorkspaceSession } = await import("@/ipc/handlers/workspace_session_handlers");
    const lineage = {
      parentSessionId: "sender",
      origin: { via: "peer" as const, by: { sessionId: "sender", name: "Plan the API", surface: "app" } },
    };
    const { appId } = await ctx.testDb.seedApp({ path: "/tmp/lineage-peer", name: "lineage-peer" });
    const made = await startWorkspaceSession(appId, { lineage });
    expect(await stored(made.sessionId)).toEqual({
      parent: "sender",
      origin: { via: "peer", by: lineage.origin.by, surface: "app" },
    });

    // An empty leftover is reused for a new chat: it becomes the child too.
    const { appId: other } = await ctx.testDb.seedApp({ path: "/tmp/lineage-peer-reuse", name: "lineage-peer-reuse" });
    const { chatSessions } = await import("@/db/schema");
    const old = new Date(Date.now() - 60 * 60_000);
    await ctx.testDb.db.insert(chatSessions).values({ id: "leftover", workspaceId: other, title: "Untitled", createdAt: old, updatedAt: old });
    const reused = await startWorkspaceSession(other, { lineage });
    expect(reused.sessionId).toBe("leftover");
    expect((await stored("leftover")).parent).toBe("sender");
  });

  it("a chat the user starts records its surface and no parent", async () => {
    const { startWorkspaceSession } = await import("@/ipc/handlers/workspace_session_handlers");
    const { appId } = await ctx.testDb.seedApp({ path: "/tmp/lineage-user", name: "lineage-user" });
    const made = await startWorkspaceSession(appId);
    expect(await stored(made.sessionId)).toEqual({ parent: null, origin: { via: "user", surface: "app" } });
  });

  it("an automation an agent set up remembers that chat", async () => {
    const { appId } = await ctx.testDb.seedApp({ path: "/tmp/lineage-auto", name: "lineage-auto" });
    const { createAutomation } = await import("@/lib/automations/service");
    const { id } = await createAutomation(
      appId,
      {
        name: "nightly",
        enabled: false,
        trigger: { kind: "schedule", cron: "0 3 * * *" },
        prompt: "check",
        runMode: "notify-only",
        notifyAgent: false,
      } as never,
      { sessionId: "maker" },
    );
    const { automations } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const [a] = await ctx.testDb.db.select().from(automations).where(eq(automations.id, id));
    expect(a?.sessionId).toBe("maker");
  });
});

describe("every list shows the tree", () => {
  it("an automation's runs sit under the chat that made it, as its latest run with a count", async () => {
    const { appId } = await ctx.testDb.seedApp({ path: "/tmp/lineage-runs", name: "lineage-runs" });
    await seed(appId, "maker", { minutesAgo: 90 });
    await seed(appId, "other", { minutesAgo: 30 });
    for (const [id, ago] of [["run-1", 80], ["run-2", 50], ["run-3", 20]] as const) {
      await seed(appId, id, { minutesAgo: ago, parent: "maker", kind: "background", origin: { via: "automation", automationId: "nightly" } });
    }
    // A run of an automation made in the UI has no parent: not in the list, as before.
    await seed(appId, "ui-run", { minutesAgo: 5, kind: "background", origin: { via: "automation", automationId: "ui" } });

    const listed = await call<Listed[]>("sessions:list", appId);
    expect(listed.map((r) => [r.id, r.depth, r.runs ?? null])).toEqual([
      ["maker", 0, null],
      ["run-3", 1, 3],
      ["other", 0, null],
    ]);
  });

  it("a child whose parent is in another folder is a root that names it", async () => {
    const { appId: a } = await ctx.testDb.seedApp({ path: "/tmp/lineage-x1", name: "lineage-x1" });
    const { appId: b } = await ctx.testDb.seedApp({ path: "/tmp/lineage-x2", name: "lineage-x2" });
    await seed(a, "far-parent");
    await seed(b, "near-child", { parent: "far-parent", origin: { via: "peer" } });
    const listed = await call<Listed[]>("sessions:list", b);
    expect(listed).toMatchObject([{ id: "near-child", depth: 0, parentTitle: "far-parent" }]);
  });

  it("opening a child names its parent; deleting the parent keeps the child", async () => {
    const { appId } = await ctx.testDb.seedApp({ path: "/tmp/lineage-get", name: "lineage-get" });
    await seed(appId, "mum");
    await seed(appId, "kid", { parent: "mum", origin: { via: "fork" } });
    const got = await call<{ parent: { id: string; title: string } | null }>("sessions:get", "kid");
    expect(got.parent).toEqual({ id: "mum", title: "mum" });

    const { chatSessions } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await ctx.testDb.db.delete(chatSessions).where(eq(chatSessions.id, "mum"));
    const listed = await call<Listed[]>("sessions:list", appId);
    expect(listed).toMatchObject([{ id: "kid", depth: 0 }]);
    expect((await call<{ parent: unknown }>("sessions:get", "kid")).parent).toBeNull();
  });
});

describe("the app opens a chat another surface started, the way its list does", () => {
  /**
   * The app's own path, below its React list: sessions:list (WorkspaceSessionList),
   * then a row's click (handleSelectSession → hydrateSessionIntoChat):
   * allocate-transport → get → hydrate-transport. The same handlers the CLI and
   * the editors call in-process, so a child made by the CLI opens in the app with
   * its whole conversation and its parent, and the reverse.
   */
  async function openLikeTheApp(appId: number, sessionId: string) {
    const listed = await call<Array<Listed & { origin: { via: string } | null }>>("sessions:list", appId);
    const { chatId } = await call<{ chatId: number }>("sessions:allocate-transport", sessionId);
    const got = await call<{ session: { id: string; parentSessionId: string | null }; parent: { id: string; title: string } | null; messages: Array<{ id: string }> }>(
      "sessions:get",
      sessionId,
    );
    const { hydrated } = await call<{ hydrated: number }>("sessions:hydrate-transport", {
      chatId,
      sessionId,
      rows: got.messages.map((m, i) => ({ id: i + 1, sessionRowId: m.id })),
    });
    return { listed, got, hydrated };
  }

  it("a session a CLI peer started opens in the app under its parent, whole", async () => {
    const { appId } = await ctx.testDb.seedApp({ path: "/tmp/lineage-cli-to-app", name: "lineage-cli-to-app" });
    await seed(appId, "cli-lead", { minutesAgo: 30 });
    await seed(appId, "cli-worker", {
      minutesAgo: 10,
      parent: "cli-lead",
      origin: { via: "peer", surface: "cli", by: { sessionId: "cli-lead", name: "Lead", surface: "cli" } },
    });
    const { listed, got, hydrated } = await openLikeTheApp(appId, "cli-worker");
    expect(listed.map((r) => [r.id, r.depth])).toEqual([
      ["cli-lead", 0],
      ["cli-worker", 1],
    ]);
    expect(got.session.parentSessionId).toBe("cli-lead");
    expect(got.parent).toEqual({ id: "cli-lead", title: "cli-lead" });
    expect(hydrated).toBe(1);
  });

  it("a fork the app made opens anywhere as its source's child", async () => {
    const { appId } = await ctx.testDb.seedApp({ path: "/tmp/lineage-app-to-cli", name: "lineage-app-to-cli" });
    await seed(appId, "app-chat");
    const fork = await call<{ id: string }>("sessions:fork", "app-chat");
    const { listed, got, hydrated } = await openLikeTheApp(appId, fork.id);
    expect(listed.find((r) => r.id === fork.id)).toMatchObject({ depth: 1 });
    expect(got.parent).toEqual({ id: "app-chat", title: "app-chat" });
    expect(hydrated).toBe(1);
  });
});
