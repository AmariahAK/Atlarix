/**
 * Workspace Snapshot Handlers
 * =================================
 * IPC handlers for save/restore workspace state.
 */

import { ipcMain } from "electron";
import { db } from "../../db";
import { apps } from "../../db/schema";
import { eq } from "drizzle-orm";
import { resolveAppPath } from "../../paths/paths";
import {
  createSnapshot,
  listSnapshots,
  restoreSnapshot,
  getSnapshotForRestore,
} from "../../lib/workspace-snapshots";
import log from "electron-log";

const logger = log.scope("workspace-snapshot-handlers");

export function registerWorkspaceSnapshotHandlers() {
  ipcMain.handle(
    "workspace-snapshot:create",
    async (
      _,
      params: {
        appId: number;
        name: string;
        chatMessages?: Array<{ role: string; content: string }>;
      }
    ) => {
      try {
        const [app] = await db.select().from(apps).where(eq(apps.id, params.appId));
        if (!app) return { success: false, error: "Workspace not found" };

        const appPath = resolveAppPath(app.path);
        const { id } = await createSnapshot(
          params.appId,
          params.name,
          appPath,
          params.chatMessages
        );
        return { success: true, snapshotId: id };
      } catch (e) {
        logger.error("Create snapshot failed:", e);
        return {
          success: false,
          error: e instanceof Error ? e.message : "Failed to create snapshot",
        };
      }
    }
  );

  ipcMain.handle(
    "workspace-snapshot:list",
    async (_, appId: number) => {
      try {
        const snapshots = await listSnapshots(appId);
        return { success: true, snapshots };
      } catch (e) {
        logger.error("List snapshots failed:", e);
        return { success: false, snapshots: [], error: "Failed to list snapshots" };
      }
    }
  );

  ipcMain.handle(
    "workspace-snapshot:restore",
    async (
      _,
      params: { snapshotId: number; appId: number }
    ) => {
      try {
        const [app] = await db.select().from(apps).where(eq(apps.id, params.appId));
        if (!app) return { success: false, error: "Workspace not found" };

        const appPath = resolveAppPath(app.path);
        return await restoreSnapshot(params.snapshotId, appPath);
      } catch (e) {
        logger.error("Restore snapshot failed:", e);
        return {
          success: false,
          error: e instanceof Error ? e.message : "Failed to restore snapshot",
        };
      }
    }
  );

  ipcMain.handle(
    "workspace-snapshot:get-metadata",
    async (_, snapshotId: number) => {
      try {
        const metadata = await getSnapshotForRestore(snapshotId);
        return { success: true, metadata };
      } catch {
        return { success: false, metadata: null };
      }
    }
  );
}
