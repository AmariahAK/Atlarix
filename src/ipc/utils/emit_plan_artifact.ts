import { BrowserWindow, type WebContents } from "electron";
import type { PlanArtifactStatus } from "@/db/schema";
import { safeSend } from "./safe_sender";

export type PlanArtifactPayload = {
  planId: string;
  sessionId: string;
  content: string;
  planStatus: PlanArtifactStatus;
};

export function emitPlanArtifactActivated(
  sender: WebContents,
  payload: PlanArtifactPayload,
): void {
  safeSend(sender, "plan:artifact-activated", payload);
}

export function emitPlanArtifactUpdated(
  sender: WebContents,
  payload: PlanArtifactPayload,
): void {
  safeSend(sender, "plan:artifact-updated", payload);
}

/**
 * Sender-free variant for tool handlers (no WebContents in scope).
 *
 * `ownerWindowId` is `_ownerWindowId`, injected by runToolExecute. Without it
 * this broadcast reached every window, and the plan panel's guard —
 * `if (prev.planId && prev.planId !== payload.planId) return prev` — only
 * rejects a payload when the panel ALREADY holds a different plan. A window with
 * an EMPTY plan panel therefore adopted another window's plan wholesale.
 *
 * Falls back to a broadcast when no owner is known (older call paths,
 * automations), which is the previous behaviour rather than dropping the event.
 */
export function broadcastPlanArtifactUpdated(
  payload: PlanArtifactPayload,
  ownerWindowId?: number,
): void {
  if (typeof ownerWindowId === "number") {
    const owner = BrowserWindow.fromId(ownerWindowId);
    if (owner && !owner.isDestroyed()) {
      safeSend(owner.webContents, "plan:artifact-updated", payload);
      return;
    }
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      safeSend(win.webContents, "plan:artifact-updated", payload);
    }
  }
}
