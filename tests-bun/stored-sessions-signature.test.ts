/**
 * The stored-sessions signature (lib/sessions/stored-sessions-watch.ts) moves
 * for an auto-title another process writes, which keeps updated_at and can
 * keep the title's length: the old count/newest/total-length signature
 * missed exactly that (item 6, 2026-10-22).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sig-ud-"));
});

describe("the stored-sessions signature", () => {
  it("moves for a same-length re-title, a new session and a deletion", async () => {
    const { initializeDatabase, db } = await import("../src/db");
    initializeDatabase();
    const { chatSessions, apps } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    const { storedSessionsSignature } = await import("../src/lib/sessions/stored-sessions-watch");
    const [app] = await db.insert(apps).values({ name: "w", path: fs.mkdtempSync(path.join(os.tmpdir(), "sig-ws-")) } as never).returning();
    const now = new Date();
    await db.insert(chatSessions).values({ id: "s-1", workspaceId: (app as { id: number }).id, title: "Fix login", createdAt: now, updatedAt: now } as never);
    const a = await storedSessionsSignature();
    // An auto-title as titleSessionFromFirstMessage writes it: same length, updated_at kept.
    await db.update(chatSessions).set({ title: "Fix logon", titleSource: "auto" } as never).where(eq(chatSessions.id, "s-1"));
    const b = await storedSessionsSignature();
    expect(b).not.toBe(a);
    expect(await storedSessionsSignature()).toBe(b);
    await db.insert(chatSessions).values({ id: "s-2", workspaceId: (app as { id: number }).id, title: "Untitled", createdAt: now, updatedAt: now } as never);
    const c = await storedSessionsSignature();
    expect(c).not.toBe(b);
    await db.delete(chatSessions).where(eq(chatSessions.id, "s-2"));
    expect(await storedSessionsSignature()).toBe(b);
  });
});
