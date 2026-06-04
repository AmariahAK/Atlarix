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

/** Sender-free variant for tool handlers (no WebContents in scope). */
export function broadcastPlanArtifactUpdated(payload: PlanArtifactPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      safeSend(win.webContents, "plan:artifact-updated", payload);
    }
  }
}
