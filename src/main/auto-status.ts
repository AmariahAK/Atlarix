/**
 * Atlarix Auto's per-turn facts, from the proxy's reply headers: which model
 * answered, and how much of today's free share is left. Main reads them off the
 * Core fetch (get_model_client) and tells every window; the composer shows them
 * while Auto is selected. Nothing is persisted — it is a live readout.
 */
import { BrowserWindow } from "electron";
import { safeSend } from "@/ipc/utils/safe_sender";

export type AutoStatus = {
  /** Vendor model id that answered the last Auto request, e.g. gpt-5.4-mini. */
  servedModel: string | null;
  /** Percent of today's free share left before that request, 0-100. */
  freeRemaining: number | null;
};

export function autoStatusFromHeaders(headers: Headers): AutoStatus | null {
  const servedModel = headers.get("x-atlarix-served-model");
  const raw = headers.get("x-atlarix-free-remaining");
  const freeRemaining = raw != null && raw !== "" ? Number(raw) : null;
  if (!servedModel && freeRemaining == null) return null;
  return {
    servedModel: servedModel || null,
    freeRemaining:
      freeRemaining != null && Number.isFinite(freeRemaining)
        ? Math.max(0, Math.min(100, freeRemaining))
        : null,
  };
}

export function broadcastAutoStatus(headers: Headers): void {
  const status = autoStatusFromHeaders(headers);
  if (!status) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) safeSend(win.webContents, "core:auto-status", status);
  }
}
