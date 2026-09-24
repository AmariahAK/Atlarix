/**
 * Session naming from the FIRST user message (v14.52.0), against the real DB.
 *
 * The model call and the window broadcast are the only fakes; the conditional
 * writes are the thing under test. What must hold:
 *   - the user's own words land at once as the placeholder;
 *   - a generated title replaces it only while the session is still ours —
 *     a rename typed while the model was thinking wins;
 *   - once per session: a second message, or a titled session, is left alone.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupEvalContext, type EvalContext } from "../infra/turn";

const generated = { next: null as string | null, onCall: null as null | (() => Promise<void>) };
vi.mock("@/lib/session-title/generate-title", () => ({
  generateSessionTitle: async () => {
    if (generated.onCall) await generated.onCall();
    return generated.next;
  },
}));
const broadcasts: Array<{ sessionId: string; title: string }> = [];
vi.mock("@/ipc/utils/broadcast_all_windows", () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => {
    if (channel === "sessions:title-updated") {
      broadcasts.push(payload as { sessionId: string; title: string });
    }
  },
}));

let ctx: EvalContext;
beforeAll(async () => {
  ctx = await setupEvalContext();
});
afterAll(async () => {
  await ctx.cleanup();
});
beforeEach(() => {
  generated.next = null;
  generated.onCall = null;
  broadcasts.length = 0;
});

let seq = 0;
async function seed(opts: {
  title?: string;
  titleSource?: "auto" | "user";
  userMessages?: string[];
}): Promise<string> {
  const { chatSessions, sessionMessages } = await import("@/db/schema");
  const id = `title-eval-${++seq}`;
  const now = new Date();
  await ctx.testDb.db.insert(chatSessions).values({
    id,
    workspaceId: 1,
    title: opts.title ?? "Untitled",
    titleSource: opts.titleSource ?? "auto",
    createdAt: now,
    updatedAt: now,
  });
  for (const [i, content] of (opts.userMessages ?? ["hi"]).entries()) {
    await ctx.testDb.db.insert(sessionMessages).values({
      id: `${id}-u${i}`,
      sessionId: id,
      role: "user",
      content,
    });
  }
  return id;
}

async function titleOf(id: string) {
  const { chatSessions } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await ctx.testDb.db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, id));
  return { title: row!.title, source: row!.titleSource };
}

const run = async (id: string, text: string) => {
  const { titleSessionFromFirstMessage } = await import(
    "@/ipc/handlers/workspace_session_handlers"
  );
  await titleSessionFromFirstMessage(id, text);
};

describe("naming from the first message", () => {
  it("shows the user's words at once, then the generated title", async () => {
    const id = await seed({ userMessages: ["can you fix the login redirect"] });
    generated.next = "Fix login redirect";
    await run(id, "can you fix the login redirect");
    expect(broadcasts.map((b) => b.title)).toEqual([
      "Fix the login redirect",
      "Fix login redirect",
    ]);
    expect(await titleOf(id)).toEqual({ title: "Fix login redirect", source: "auto" });
  });

  it("keeps the placeholder when no usable title comes back", async () => {
    const id = await seed({ userMessages: ["hey how are you?"] });
    generated.next = null;
    await run(id, "hey how are you?");
    expect(await titleOf(id)).toEqual({ title: "Greeting", source: "auto" });
  });

  it("a rename typed while the model was thinking wins", async () => {
    const id = await seed({ userMessages: ["refactor billing"] });
    generated.next = "Billing refactor";
    generated.onCall = async () => {
      const { chatSessions } = await import("@/db/schema");
      const { eq } = await import("drizzle-orm");
      await ctx.testDb.db
        .update(chatSessions)
        .set({ title: "My name", titleSource: "user" })
        .where(eq(chatSessions.id, id));
    };
    await run(id, "refactor billing");
    expect(await titleOf(id)).toEqual({ title: "My name", source: "user" });
  });

  it("only the FIRST message names a session", async () => {
    const id = await seed({ userMessages: ["first", "second"] });
    generated.next = "Should not land";
    await run(id, "second");
    expect(await titleOf(id)).toEqual({ title: "Untitled", source: "auto" });
    expect(broadcasts).toEqual([]);
  });

  it("never touches a title the user chose", async () => {
    const id = await seed({ title: "Mine", titleSource: "user" });
    generated.next = "Nope";
    await run(id, "hi");
    expect(await titleOf(id)).toEqual({ title: "Mine", source: "user" });
  });

  it("an attachment-only first message leaves the session for a later name", async () => {
    const id = await seed({ userMessages: ['<atlarix-text-attachment id="1" />'] });
    generated.next = "Nope";
    await run(id, '<atlarix-text-attachment id="1" />');
    expect(await titleOf(id)).toEqual({ title: "Untitled", source: "auto" });
  });
});
