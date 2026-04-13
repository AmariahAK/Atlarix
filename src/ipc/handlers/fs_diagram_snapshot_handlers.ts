/**
 * IPC: filesystem diagram snapshots under `.atlarix/snapshots/` (timeline + revert).
 */

import { ipcMain } from "electron";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getAtlarixAppPath } from "@/paths/paths";
import {
  listDiagramSnapshotTimeline,
  revertSnapshot,
} from "@/lib/snapshot/snapshot-manager";

export function registerFsDiagramSnapshotHandlers() {
  ipcMain.handle(
    "snapshots:diagram-timeline",
    async (_, { workspaceId }: { workspaceId: number }) => {
      try {
        const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
        if (!app) {
          return { success: false, error: "Workspace not found", entries: [] };
        }
        const workspacePath = getAtlarixAppPath(app.path);
        const entries = await listDiagramSnapshotTimeline(workspacePath);
        return { success: true, entries };
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : "Failed to list snapshots",
          entries: [],
        };
      }
    },
  );

  ipcMain.handle(
    "snapshots:revert-diagram",
    async (_, { workspaceId, turnId }: { workspaceId: number; turnId: string }) => {
      try {
        const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
        if (!app) {
          return { success: false, error: "Workspace not found" };
        }
        const workspacePath = getAtlarixAppPath(app.path);
        return await revertSnapshot({ workspacePath, turnId, workspaceId });
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : "Revert failed",
        };
      }
    },
  );
}
