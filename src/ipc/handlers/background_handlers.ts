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
import {
  cancelSubagentTask,
  listRunningSubagentTasks,
  readSubagentOutput,
} from "@/lib/tools/spawn-task";
import { setScheduledWakeupNotifier } from "@/lib/agent/scheduled-wakeups";
import { broadcastToAllWindows } from "../utils/broadcast_all_windows";

const logger = log.scope("background_ipc");

export function registerBackgroundHandlers(): void {
  // Registry → renderer: indicator refresh + auto-wake signal. Background
  // COMMANDS and sub-agent TASKS share the one `chat:background-job-update`
  // channel, discriminated by `source`, so the renderer's single wake closure
  // (and its bgWakeInFlightRef guard) handles both without duplication.
  // Delivered to every window; each payload carries `chatId`, and a window only
  // acts on chats it owns. This used to go through the BROWSER panel's
  // `broadcastToRenderer`, which targets whichever window the browser view
  // happens to be attached to — so a background job started in window 1 could
  // announce itself in window 2, and window 1 would never hear about it.
  setBackgroundJobNotifier((chatId, ev) => {
    broadcastToAllWindows("chat:background-job-update", {
      chatId,
      source: "command",
      ...ev,
    });
  });
  setSubagentNotifier((chatId, ev) => {
    broadcastToAllWindows("chat:background-job-update", {
      chatId,
      source: "subagent",
      ...ev,
    });
  });
  // R1: a fired self-wake rides the SAME auto-wake channel (source:"scheduled").
  setScheduledWakeupNotifier((chatId, ev) => {
    broadcastToAllWindows("chat:background-job-update", {
      chatId,
      source: "scheduled",
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

  // v14.21: sub-agents get the same list/cancel/output surface as background
  // commands. The notifier above already broadcasts them over the shared
  // chat:background-job-update channel with source:"subagent" — these are what
  // let the renderer actually SHOW and control one.
  ipcMain.handle("chat:subagent-jobs-list", (_e, chatId: number) =>
    listRunningSubagentTasks(Number(chatId)),
  );

  ipcMain.handle(
    "chat:subagent-job-cancel",
    (_e, arg: { chatId: number; taskId: string }) =>
      cancelSubagentTask(Number(arg?.chatId), String(arg?.taskId ?? "")),
  );

  ipcMain.handle(
    "chat:subagent-job-output",
    (_e, arg: { chatId: number; taskId: string }) => {
      // Always a TAIL for the UI: a human watching a panel wants current state,
      // and the model's incremental cursor must not be consumed by the user
      // happening to open a disclosure triangle.
      const r = readSubagentOutput(String(arg?.taskId ?? ""), "tail", 8_000);
      return r.found ? r : null;
    },
  );

  logger.log("[background] handlers registered");
}
