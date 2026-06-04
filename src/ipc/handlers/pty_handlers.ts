/**
 * IPC surface for the interactive PTY terminal (v10).
 * Channels: pty:spawn / pty:input / pty:resize / pty:kill (invoke)
 * Events:   pty:data / pty:exit (broadcast from pty-session-manager)
 */

import { ipcMain } from "electron";
import log from "electron-log";
import {
  spawnPty,
  writePty,
  resizePty,
  killPty,
  type SpawnPtyResult,
} from "@/lib/pty/pty-session-manager";

const logger = log.scope("pty-handlers");

export function registerPtyHandlers(): void {
  ipcMain.handle(
    "pty:spawn",
    async (
      _event,
      params: {
        instanceId: string;
        cwd: string;
        cols?: number;
        rows?: number;
        scopeKey?: string;
      },
    ): Promise<SpawnPtyResult> => {
      if (!params?.instanceId || !params?.cwd) {
        return { ok: false, error: "instanceId and cwd are required" };
      }
      return spawnPty(params);
    },
  );

  ipcMain.on(
    "pty:input",
    (_event, params: { instanceId: string; data: string }) => {
      if (!params?.instanceId || typeof params.data !== "string") return;
      writePty(params.instanceId, params.data);
    },
  );

  ipcMain.on(
    "pty:resize",
    (_event, params: { instanceId: string; cols: number; rows: number }) => {
      if (!params?.instanceId) return;
      resizePty(params.instanceId, Number(params.cols), Number(params.rows));
    },
  );

  ipcMain.handle("pty:kill", async (_event, params: { instanceId: string }) => {
    if (params?.instanceId) killPty(params.instanceId);
    return { ok: true };
  });

  logger.log("pty handlers registered");
}
