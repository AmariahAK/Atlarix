import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  setupEvalContext,
  getIpcHandler,
  type EvalContext,
} from "../infra/turn";

/**
 * v12 S22 hotfix regression — deleting a workspace through the REAL
 * `delete-app` handler on a fully-migrated DB.
 *
 * Pre-0062 this failed on EVERY database (fresh ones included): migration
 * 0022 created `diagrams` with an FK to `chats`, 0058 dropped `chats` without
 * rebuilding `diagrams`, and with foreign_keys ON SQLite could no longer even
 * PREPARE `DELETE FROM apps` (it must compile the diagrams cascade) —
 * "Failed to delete workspace from database: no such table: main.chats".
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: { "src/app.ts": "export const app = 1;\n" },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("workspace deletion (S22 hotfix)", () => {
  it("delete-app succeeds and removes the row (no dead-FK prepare failure)", async () => {
    const { db, schema } = ctx.testDb;

    const before = await db
      .select({ id: schema.apps.id })
      .from(schema.apps)
      .where(eq(schema.apps.id, ctx.appId));
    expect(before).toHaveLength(1);

    // delete-app lives in app_handlers, which the harness doesn't register by
    // default — register it (idempotent under the mocked ipcMain).
    const { registerAppHandlers } = await import("@/ipc/handlers/app_handlers");
    registerAppHandlers();
    const deleteApp = await getIpcHandler("delete-app");
    // Pre-0062: throws "Failed to delete workspace from database: no such
    // table: main.chats" right here.
    await deleteApp({} as never, { appId: ctx.appId });

    const after = await db
      .select({ id: schema.apps.id })
      .from(schema.apps)
      .where(eq(schema.apps.id, ctx.appId));
    expect(after).toHaveLength(0);
  }, 30_000);
});
