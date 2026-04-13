import { ipcMain } from "electron";
import { eq, or, isNull, desc } from "drizzle-orm";
import { db } from "@/db";
import { atlarixHooks } from "@/db/schema";
import type { HookTrigger } from "@/lib/hooks/hooks-manager";

const TRIGGERS = new Set<string>([
  "before_file_write",
  "after_file_write",
  "before_run_command",
  "after_run_command",
]);

function validTrigger(t: string): t is HookTrigger {
  return TRIGGERS.has(t);
}

export function registerHooksHandlers(): void {
  ipcMain.handle("hooks:list", async (_e, workspaceId?: number | null) => {
    const wid = workspaceId ?? null;
    const scope =
      wid != null
        ? or(isNull(atlarixHooks.workspaceId), eq(atlarixHooks.workspaceId, wid))
        : isNull(atlarixHooks.workspaceId);
    return db
      .select()
      .from(atlarixHooks)
      .where(scope)
      .orderBy(desc(atlarixHooks.id));
  });

  ipcMain.handle(
    "hooks:create",
    async (
      _e,
      row: {
        name: string;
        trigger: string;
        command: string;
        argsJson?: string | null;
        workspaceId?: number | null;
      },
    ) => {
      if (!row.name?.trim() || !row.command?.trim() || !validTrigger(row.trigger)) {
        return { ok: false as const, error: "Invalid hook payload" };
      }
      const [inserted] = await db
        .insert(atlarixHooks)
        .values({
          name: row.name.trim(),
          trigger: row.trigger,
          command: row.command.trim(),
          argsJson: row.argsJson?.trim() || null,
          workspaceId: row.workspaceId ?? null,
          enabled: true,
        })
        .returning();
      return { ok: true as const, hook: inserted };
    },
  );

  ipcMain.handle(
    "hooks:update",
    async (
      _e,
      row: {
        id: number;
        name?: string;
        trigger?: string;
        command?: string;
        argsJson?: string | null;
        workspaceId?: number | null;
        enabled?: boolean;
      },
    ) => {
      if (!row.id || typeof row.id !== "number") {
        return { ok: false as const, error: "Missing id" };
      }
      if (row.trigger != null && !validTrigger(row.trigger)) {
        return { ok: false as const, error: "Invalid trigger" };
      }
      await db
        .update(atlarixHooks)
        .set({
          updatedAt: new Date(),
          ...(row.name != null ? { name: row.name.trim() } : {}),
          ...(row.trigger != null ? { trigger: row.trigger } : {}),
          ...(row.command != null ? { command: row.command.trim() } : {}),
          ...(row.argsJson !== undefined ? { argsJson: row.argsJson?.trim() || null } : {}),
          ...(row.workspaceId !== undefined ? { workspaceId: row.workspaceId } : {}),
          ...(row.enabled !== undefined ? { enabled: row.enabled } : {}),
        })
        .where(eq(atlarixHooks.id, row.id));
      return { ok: true as const };
    },
  );

  ipcMain.handle("hooks:delete", async (_e, id: number) => {
    if (!id) return { ok: false as const, error: "Missing id" };
    await db.delete(atlarixHooks).where(eq(atlarixHooks.id, id));
    return { ok: true as const };
  });

  ipcMain.handle("hooks:toggle", async (_e, id: number, enabled: boolean) => {
    if (!id) return { ok: false as const, error: "Missing id" };
    await db
      .update(atlarixHooks)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(atlarixHooks.id, id));
    return { ok: true as const };
  });
}
