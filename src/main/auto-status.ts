/**
 * Atlarix Auto's per-turn facts, from the proxy's reply headers: whether the
 * reply was free or paid, what a paid one cost, how much of today's free share
 * is left, and which model answered (logged, never shown — Auto hides model
 * names). Main reads them off the
 * Core fetch (get_model_client) and tells every window; the composer shows them
 * while Auto is selected. Nothing is persisted — it is a live readout.
 */
import { BrowserWindow } from "electron";
import log from "electron-log";
import { safeSend } from "@/ipc/utils/safe_sender";
import { noteAutoBilling } from "@/lib/context/auto-context-window";

export type AutoStatus = {
  /** Vendor model id that answered the last Auto request, e.g. gpt-5.4-mini. */
  servedModel: string | null;
  /** Percent of today's free share left before that request, 0-100. */
  freeRemaining: number | null;
  /** How the proxy paid for it: `free` (shared pool) or `paid` (credit/Pro). */
  billing: "free" | "paid" | null;
  /** What a paid reply cost, in cents — non-streaming replies only. */
  costCents: number | null;
};

export function autoStatusFromHeaders(headers: Headers): AutoStatus | null {
  const servedModel = headers.get("x-atlarix-served-model");
  const raw = headers.get("x-atlarix-free-remaining");
  const freeRemaining = raw != null && raw !== "" ? Number(raw) : null;
  const billingRaw = headers.get("x-atlarix-billing");
  const billing = billingRaw === "free" || billingRaw === "paid" ? billingRaw : null;
  const costRaw = headers.get("x-atlarix-cost-cents");
  const cost = costRaw != null && costRaw !== "" ? Number(costRaw) : null;
  if (!servedModel && freeRemaining == null && !billing) return null;
  return {
    servedModel: servedModel || null,
    billing,
    costCents: cost != null && Number.isFinite(cost) ? cost : null,
    freeRemaining:
      freeRemaining != null && Number.isFinite(freeRemaining)
        ? Math.max(0, Math.min(100, freeRemaining))
        : null,
  };
}

export function broadcastAutoStatus(headers: Headers): void {
  const status = autoStatusFromHeaders(headers);
  if (!status) return;
  // Paid vs free decides Auto's context window (auto-context-window.ts).
  noteAutoBilling(status.billing);
  // The one place the answering model is recorded on this machine.
  log.scope("atlarix-auto").info(
    `Auto reply: billing=${status.billing ?? "?"} model=${status.servedModel ?? "?"}`,
  );
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) safeSend(win.webContents, "core:auto-status", status);
  }
}
