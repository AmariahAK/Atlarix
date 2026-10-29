import { ipcMain } from "electron";
import log from "electron-log";
import { asc, desc, eq, sql, sum } from "drizzle-orm";
import { db } from "@/db";
import { apps, editStats } from "@/db/schema";
import type { EditStatsSummary } from "../ipc_types";

const logger = log.scope("edit_stats_ipc");

/**
 * Aggregate the daily rollup for display.
 *
 * All FOUR shapes are SUM/GROUP BY over the same bounded table — this is why the
 * rollup was chosen over a row per edit: nothing here needs a scan of individual
 * writes, and the query cost stays flat as the install ages. The calendar in
 * particular is a `GROUP BY day` over a table that already stores one row per day.
 */
export function registerEditStatsHandlers(): void {
  ipcMain.handle("edit-stats:summary", async (): Promise<EditStatsSummary> => {
    const byWorkspaceRows = await db
      .select({
        workspaceId: editStats.workspaceId,
        name: apps.name,
        path: apps.path,
        linesAdded: sum(editStats.linesAdded).mapWith(Number),
        linesRemoved: sum(editStats.linesRemoved).mapWith(Number),
        edits: sum(editStats.edits).mapWith(Number),
      })
      .from(editStats)
      // INNER join, so a workspace deleted from the library takes its rows out of
      // the totals with it. The FK already cascades, so this only matters if a row
      // ever outlives its workspace — and a breakdown that cannot name the project
      // it belongs to is not something the card can render anyway.
      .innerJoin(apps, eq(apps.id, editStats.workspaceId))
      .groupBy(editStats.workspaceId, apps.name, apps.path)
      .orderBy(
        desc(sql`sum(${editStats.linesAdded} + ${editStats.linesRemoved})`),
      );

    const byModelRows = await db
      .select({
        provider: editStats.provider,
        modelId: editStats.modelId,
        linesAdded: sum(editStats.linesAdded).mapWith(Number),
        linesRemoved: sum(editStats.linesRemoved).mapWith(Number),
        edits: sum(editStats.edits).mapWith(Number),
      })
      .from(editStats)
      .innerJoin(apps, eq(apps.id, editStats.workspaceId))
      .groupBy(editStats.provider, editStats.modelId)
      .orderBy(
        desc(sql`sum(${editStats.linesAdded} + ${editStats.linesRemoved})`),
      );

    // The contribution calendar. One row per day across every workspace — the
    // faithful analogue of GitHub's graph, which spans all of your repositories.
    // Days with no activity produce NO row; the grid fills those in as level 0,
    // which keeps this result proportional to days worked rather than to days
    // elapsed.
    const byDayRows = await db
      .select({
        day: editStats.day,
        linesAdded: sum(editStats.linesAdded).mapWith(Number),
        linesRemoved: sum(editStats.linesRemoved).mapWith(Number),
        edits: sum(editStats.edits).mapWith(Number),
      })
      .from(editStats)
      .innerJoin(apps, eq(apps.id, editStats.workspaceId))
      .groupBy(editStats.day)
      // Ascending, so the first row is the start of history and the caller needs
      // no sort to find it.
      .orderBy(asc(editStats.day));

    const totals = byWorkspaceRows.reduce(
      (acc, row) => ({
        linesAdded: acc.linesAdded + (row.linesAdded ?? 0),
        linesRemoved: acc.linesRemoved + (row.linesRemoved ?? 0),
        edits: acc.edits + (row.edits ?? 0),
      }),
      { linesAdded: 0, linesRemoved: 0, edits: 0 },
    );

    return {
      totals,
      byWorkspace: byWorkspaceRows.map((row) => ({
        workspaceId: row.workspaceId,
        name: row.name,
        path: row.path,
        linesAdded: row.linesAdded ?? 0,
        linesRemoved: row.linesRemoved ?? 0,
        edits: row.edits ?? 0,
      })),
      byModel: byModelRows.map((row) => ({
        provider: row.provider,
        modelId: row.modelId,
        linesAdded: row.linesAdded ?? 0,
        linesRemoved: row.linesRemoved ?? 0,
        edits: row.edits ?? 0,
      })),
      byDay: byDayRows.map((row) => ({
        day: row.day,
        linesAdded: row.linesAdded ?? 0,
        linesRemoved: row.linesRemoved ?? 0,
        edits: row.edits ?? 0,
      })),
    };
  });

  /** Usage on this computer: activity, tokens by model, MCP & skills, Auto picks, BYOK estimate. */
  ipcMain.handle("usage:report", async (_e, raw: unknown) => {
    const { getUsageReport } = await import("@/lib/stats/usage-report");
    const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 200) : undefined);
    return getUsageReport({
      days: typeof f.days === "number" ? f.days : undefined,
      model: str(f.model),
      surface: str(f.surface),
      source: str(f.source),
    });
  });

  /** The account's Atlarix credits: spend per day, balance, Pro allowance. */
  ipcMain.handle("usage:credits", async () => {
    const { getUsageCredits } = await import("@/lib/billing/usage-credits");
    return getUsageCredits();
  });

  /** Save the share card the page drew (PNG data URL) where the user picks. */
  ipcMain.handle("usage:save-card", async (e, dataUrl: unknown) => {
    const png = typeof dataUrl === "string" ? /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl) : null;
    if (!png) return { saved: false };
    const { BrowserWindow, app, dialog } = await import("electron");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      defaultPath: path.join(app.getPath("downloads"), `atlarix-usage-${new Date().toISOString().slice(0, 10)}.png`),
      filters: [{ name: "PNG image", extensions: ["png"] }],
    };
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (canceled || !filePath) return { saved: false };
    await fs.writeFile(filePath, Buffer.from(png[1]!, "base64"));
    return { saved: true };
  });

  logger.log("[edit-stats] handlers registered");
}
