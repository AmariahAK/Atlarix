/**
 * IPC surface for the interactive PTY terminal (v10).
 * Channels: pty:spawn / pty:input / pty:resize / pty:kill (invoke)
 *           pty:scrollback:save / load (invoke; persists across restarts)
 * Events:   pty:data / pty:exit / pty:cwd (broadcast from pty-session-manager)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ipcMain } from "electron";
import log from "electron-log";
import {
  spawnPty,
  writePty,
  resizePty,
  killPty,
  type SpawnPtyResult,
} from "@/lib/pty/pty-session-manager";
import { getUserDataPath } from "@/paths/paths";

const logger = log.scope("pty-handlers");

// ── Scrollback persistence (v10.1) ───────────────────────────────────────
// Serialized xterm buffers per terminal instance; restored on app restart.

const SCROLLBACK_DIR = "terminal-scrollback";
const SCROLLBACK_MAX_BYTES = 200_000;

function scrollbackPath(instanceId: string): string | null {
  // Instance ids are renderer/store generated (`user-<ts>-<rand>`); reject
  // anything that could escape the scrollback dir.
  if (!/^[A-Za-z0-9_-]+$/.test(instanceId)) return null;
  return path.join(getUserDataPath(), SCROLLBACK_DIR, `${instanceId}.txt`);
}

export async function deletePtyScrollback(instanceId: string): Promise<void> {
  const file = scrollbackPath(instanceId);
  if (!file) return;
  try {
    await fs.unlink(file);
  } catch {
    // never saved — fine
  }
}

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

  ipcMain.handle(
    "pty:scrollback:save",
    async (_event, params: { instanceId: string; data: string }) => {
      const file = params?.instanceId ? scrollbackPath(params.instanceId) : null;
      if (!file || typeof params.data !== "string") return { ok: false };
      try {
        const data =
          params.data.length > SCROLLBACK_MAX_BYTES
            ? params.data.slice(-SCROLLBACK_MAX_BYTES)
            : params.data;
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, data, "utf8");
        return { ok: true };
      } catch (err) {
        logger.warn(`scrollback save failed for ${params.instanceId}:`, err);
        return { ok: false };
      }
    },
  );

  ipcMain.handle(
    "pty:scrollback:load",
    async (_event, params: { instanceId: string }) => {
      const file = params?.instanceId ? scrollbackPath(params.instanceId) : null;
      if (!file) return { data: null };
      try {
        const data = await fs.readFile(file, "utf8");
        return { data };
      } catch {
        return { data: null };
      }
    },
  );

  logger.log("pty handlers registered");
}
