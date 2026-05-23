import { BrowserWindow } from "electron";
import { safeSend } from "./safe_sender";

export type PlanFileUpdatedPayload = {
  workspacePath: string;
  mtime: number | null;
};

export function emitPlanFileUpdated(workspacePath: string, mtime: number | null): void {
  if (!workspacePath?.trim()) return;
  const payload: PlanFileUpdatedPayload = { workspacePath, mtime };
  for (const win of BrowserWindow.getAllWindows()) {
    safeSend(win.webContents, "plan:file-updated", payload);
  }
}
