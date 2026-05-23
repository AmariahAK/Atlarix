import { ipcMain } from "electron";
import * as fs from "fs/promises";
import * as path from "path";
import log from "electron-log";

const logger = log.scope("plan-panel");

const PLAN_REL = path.join(".atlarix", "ATLARIX_PLAN.md");

export type PlanWorkspaceFileResult = {
  content: string | null;
  path: string;
  mtime: number | null;
};

export function registerPlanPanelHandlers(): void {
  ipcMain.handle(
    "plan:read-workspace-file",
    async (_event, params: { workspacePath?: string }): Promise<PlanWorkspaceFileResult> => {
      const workspacePath = params?.workspacePath?.trim();
      if (!workspacePath) {
        return { content: null, path: PLAN_REL, mtime: null };
      }
      const full = path.join(workspacePath, PLAN_REL);
      try {
        const stat = await fs.stat(full);
        const content = await fs.readFile(full, "utf8");
        return { content, path: PLAN_REL, mtime: stat.mtimeMs };
      } catch {
        return { content: null, path: PLAN_REL, mtime: null };
      }
    },
  );

  logger.log("plan panel handlers registered");
}
