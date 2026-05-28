import { ipcMain } from "electron";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { customCommands } from "@/db/schema";

const DEFAULT_GLOBAL = [
  {
    name: "review",
    promptTemplate:
      "Review the following for bugs, security issues, and style. Be concise and actionable.\n\n{{input}}",
    modeOverride: null as string | null,
  },
  {
    name: "explain",
    promptTemplate: "Explain clearly for a developer audience:\n\n{{input}}",
    modeOverride: null,
  },
  {
    name: "debug",
    promptTemplate:
      "Debug and propose a minimal fix (with reasoning) for the following issue or code:\n\n{{input}}",
    modeOverride: "debug",
  },
];

async function ensureDefaultGlobalCommands(): Promise<void> {
  for (const d of DEFAULT_GLOBAL) {
    const existing = await db
      .select({ id: customCommands.id })
      .from(customCommands)
      .where(and(eq(customCommands.name, d.name), isNull(customCommands.workspaceId)))
      .limit(1);
    if (existing.length > 0) continue;
    await db.insert(customCommands).values({
      name: d.name,
      promptTemplate: d.promptTemplate,
      modeOverride: d.modeOverride,
      workspaceId: null,
    });
  }
}

export function registerCommandsHandlers(): void {
  ipcMain.handle("commands:list", async (_e, workspaceId?: number | null) => {
    await ensureDefaultGlobalCommands();
    const wid = workspaceId ?? null;
    const scope =
      wid != null
        ? or(isNull(customCommands.workspaceId), eq(customCommands.workspaceId, wid))
        : isNull(customCommands.workspaceId);
    return db
      .select()
      .from(customCommands)
      .where(scope)
      .orderBy(desc(customCommands.id));
  });

  ipcMain.handle(
    "commands:create",
    async (
      _e,
      row: {
        name: string;
        promptTemplate: string;
        modeOverride?: string | null;
        workspaceId?: number | null;
      },
    ) => {
      if (!row.name?.trim() || !row.promptTemplate?.trim()) {
        return { ok: false as const, error: "Invalid command" };
      }
      const [inserted] = await db
        .insert(customCommands)
        .values({
          name: row.name.trim().toLowerCase(),
          promptTemplate: row.promptTemplate.trim(),
          modeOverride: row.modeOverride?.trim() || null,
          workspaceId: row.workspaceId ?? null,
        })
        .returning();
      return { ok: true as const, command: inserted };
    },
  );

  ipcMain.handle(
    "commands:update",
    async (
      _e,
      row: {
        id: number;
        name?: string;
        promptTemplate?: string;
        modeOverride?: string | null;
        workspaceId?: number | null;
      },
    ) => {
      if (!row.id) return { ok: false as const, error: "Missing id" };
      await db
        .update(customCommands)
        .set({
          updatedAt: new Date(),
          ...(row.name != null ? { name: row.name.trim().toLowerCase() } : {}),
          ...(row.promptTemplate != null ? { promptTemplate: row.promptTemplate.trim() } : {}),
          ...(row.modeOverride !== undefined ? { modeOverride: row.modeOverride?.trim() || null } : {}),
          ...(row.workspaceId !== undefined ? { workspaceId: row.workspaceId } : {}),
        })
        .where(eq(customCommands.id, row.id));
      return { ok: true as const };
    },
  );

  ipcMain.handle("commands:delete", async (_e, id: number) => {
    if (!id) return { ok: false as const, error: "Missing id" };
    await db.delete(customCommands).where(eq(customCommands.id, id));
    return { ok: true as const };
  });
}
