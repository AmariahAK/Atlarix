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
  hasPendingBackgroundCommandResults,
  getBackgroundJobOutput,
} from "@/lib/agent/background-commands";
import {
  setSubagentNotifier,
  hasPendingSubagentResults,
} from "@/lib/agents/subagent-results";
import { broadcastToRenderer } from "../utils/browser_view_manager";

const logger = log.scope("background_ipc");

export function registerBackgroundHandlers(): void {
  // Registry → renderer: indicator refresh + auto-wake signal. Background
  // COMMANDS and sub-agent TASKS share the one `chat:background-job-update`
  // channel, discriminated by `source`, so the renderer's single wake closure
  // (and its bgWakeInFlightRef guard) handles both without duplication.
  setBackgroundJobNotifier((chatId, ev) => {
    broadcastToRenderer("chat:background-job-update", {
      chatId,
      source: "command",
      ...ev,
    });
  });
  setSubagentNotifier((chatId, ev) => {
    broadcastToRenderer("chat:background-job-update", {
      chatId,
      source: "subagent",
      ...ev,
    });
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

  ipcMain.handle("chat:background-has-pending-results", (_e, chatId: number) =>
    hasPendingBackgroundCommandResults(Number(chatId)),
  );

  ipcMain.handle("chat:subagent-has-pending-results", (_e, chatId: number) =>
    hasPendingSubagentResults(Number(chatId)),
  );

  ipcMain.handle(
    "chat:background-job-output",
    (_e, arg: { chatId: number; jobId: string }) =>
      getBackgroundJobOutput(Number(arg?.chatId), String(arg?.jobId ?? "")),
  );

  logger.log("[background] handlers registered");
}
