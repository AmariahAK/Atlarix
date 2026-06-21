/**
 * Background-job IPC (v14) — renderer ↔ the in-memory background-command
 * registry. Powers the "jobs running" indicator + cancel, and the auto-wake:
 * the registry notifier broadcasts `chat:background-job-update` so the renderer
 * can refresh the indicator and (when the chat is idle) start a fresh turn so
 * the agent reacts to a finished job.
 */

import { ipcMain } from "electron";
import log from "electron-log";
import {
  listBackgroundJobs,
  killBackgroundJob,
  setBackgroundJobNotifier,
} from "@/lib/agent/background-commands";
import { broadcastToRenderer } from "../utils/browser_view_manager";

const logger = log.scope("background_ipc");

export function registerBackgroundHandlers(): void {
  // Registry → renderer: indicator refresh + auto-wake signal.
  setBackgroundJobNotifier((chatId, ev) => {
    broadcastToRenderer("chat:background-job-update", { chatId, ...ev });
  });

  ipcMain.handle("chat:background-jobs-list", (_e, chatId: number) =>
    listBackgroundJobs(Number(chatId)),
  );

  ipcMain.handle(
    "chat:background-job-cancel",
    (_e, arg: { chatId: number; jobId: string }) => ({
      ok: killBackgroundJob(Number(arg?.chatId), String(arg?.jobId ?? "")),
    }),
  );

  logger.log("[background] handlers registered");
}
