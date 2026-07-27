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
    hasProposal: Boolean(run.proposalDiff),
    proposalFiles: run.proposalFiles ? (JSON.parse(run.proposalFiles) as string[]) : [],
    proposalApplied: run.proposalAppliedAt != null,
    startedAt: run.startedAt.getTime(),
    finishedAt: run.finishedAt?.getTime() ?? null,
  };
}

export async function broadcastAutomationRunUpdate(runId: string): Promise<void> {
  const view = await getAutomationRunView(runId);
  if (!view) return;
  // Every window: the run view carries its own identity, and the previous
  // single-target send went to whichever window the browser was attached to.
  broadcastToAllWindows("automation:run-update", view);
}

export async function notifyRunFinished(runId: string): Promise<void> {
  const view = await getAutomationRunView(runId);
  if (!view || view.status === "nothing-to-report" || view.status === "running") {
    return;
  }

  // Focused app → the renderer's automation:run-update subscription shows a
  // sonner toast; an OS notification on top would be double noise.
  try {
    const { BrowserWindow, Notification } = await import("electron");
    const focused = BrowserWindow.getAllWindows().some((w) => w.isFocused());
    if (focused) return;
    if (!Notification.isSupported()) return;

    const body =
      view.status === "error"
        ? `Run failed: ${view.error ?? "unknown error"}`
        : (view.summary ?? "Finished with findings") +
          (view.hasProposal ? " — proposal ready to review" : "");
    const n = new Notification({ title: view.automationName, body, silent: false });
    n.on("click", () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        win.webContents.send("automations:focus-feed", { runId });
      }
    });
    n.show();
  } catch (e) {
    logger.warn("OS notification failed:", e);
  }
}
