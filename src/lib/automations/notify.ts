/**
 * Automation result delivery: live feed broadcasts to the renderer, sonner
 * toast when the app is focused, OS Notification when it isn't. Nothing-to-
 * report runs are silent (auto-archived by execute-run).
 */

import log from "electron-log";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { automationRuns, automations } from "@/db/schema";
import { broadcastToAllWindows } from "@/ipc/utils/broadcast_all_windows";
import { showDesktopNotification } from "@/main/desktop-notification";
import type { AutomationRunView } from "./types";

const logger = log.scope("automations");

export async function getAutomationRunView(
  runId: string,
): Promise<AutomationRunView | null> {
  const run = await db.query.automationRuns.findFirst({
    where: eq(automationRuns.id, runId),
  });
  if (!run) return null;
  const automation = await db.query.automations.findFirst({
    where: eq(automations.id, run.automationId),
  });
  return {
    id: run.id,
    automationId: run.automationId,
    automationName: automation?.name ?? "(deleted automation)",
    sessionId: run.sessionId,
    status: run.status,
    summary: run.summary,
    error: run.error,
    unread: run.unread,
    archived: run.archived,
    triggerContext: run.triggerContext,
    startedAt: run.startedAt.getTime(),
    finishedAt: run.finishedAt?.getTime() ?? null,
  };
}

export async function broadcastAutomationRunUpdate(
  runId: string,
): Promise<void> {
  const view = await getAutomationRunView(runId);
  if (!view) return;
  // Every window: the run view carries its own identity, and the previous
  // single-target send went to whichever window the browser was attached to.
  broadcastToAllWindows("automation:run-update", view);
}

type RunFinishedListener = (runId: string) => void;
const runFinishedListeners = new Set<RunFinishedListener>();

/** Hear when a run with something to report finishes in this process (the app's agent delivery). */
export function onAutomationRunFinished(fn: RunFinishedListener): () => void {
  runFinishedListeners.add(fn);
  return () => runFinishedListeners.delete(fn);
}

export async function notifyRunFinished(runId: string): Promise<void> {
  const view = await getAutomationRunView(runId);
  if (
    !view ||
    view.status === "nothing-to-report" ||
    view.status === "running"
  ) {
    return;
  }
  for (const fn of runFinishedListeners) {
    try {
      fn(runId);
    } catch (e) {
      logger.warn("run-finished listener failed:", e);
    }
  }

  // Focused app → the renderer's automation:run-update subscription shows a
  // sonner toast; an OS notification on top would be double noise.
  try {
    const { BrowserWindow } = await import("electron");
    const focused = BrowserWindow.getAllWindows().some((w) => w.isFocused());
    if (focused) return;

    const body =
      view.status === "error"
        ? `Run failed: ${view.error ?? "unknown error"}`
        : (view.summary ?? "Finished with findings");
    // Lifetime is owned by showDesktopNotification — see the crash it exists for.
    await showDesktopNotification({
      title: view.automationName,
      body,
      onClick: () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
          win.webContents.send("automations:focus-feed", { runId });
        }
      },
    });
  } catch (e) {
    logger.warn("OS notification failed:", e);
  }
}
