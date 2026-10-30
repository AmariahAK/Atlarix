/**
 * Atlarix Auto's per-turn facts, from the proxy's reply headers: whether the
 * reply was free or paid, what a paid one cost, how much of today's free share
 * is left, and which model answered (never shown in the chat, where Auto hides
 * model names; the Usage page's "Auto picks" counts them). Main reads them off
 * the Core fetch (get_model_client) and tells every window; the composer shows
 * them while Auto is selected. Only the answering model and who paid are kept,
 * as a daily count (usage_auto_picks).
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
  /** `auto` or `zenith` (`X-Atlarix-Tier`); null from a proxy that does not say. */
  tier: string | null;
  /** What a paid reply cost, in cents — non-streaming replies only. */
  costCents: number | null;
  /**
   * True when today's free share is spent and the slower $0 fallback model
   * answered; null from a proxy that does not say.
   */
  onFloor: boolean | null;
};

export function autoStatusFromHeaders(headers: Headers): AutoStatus | null {
  const servedModel = headers.get("x-atlarix-served-model");
  const raw = headers.get("x-atlarix-free-remaining");
  const freeRemaining = raw != null && raw !== "" ? Number(raw) : null;
  const billingRaw = headers.get("x-atlarix-billing");
  const billing = billingRaw === "free" || billingRaw === "paid" ? billingRaw : null;
  const costRaw = headers.get("x-atlarix-cost-cents");
  const cost = costRaw != null && costRaw !== "" ? Number(costRaw) : null;
  const floorRaw = headers.get("x-atlarix-free-floor");
  const tier = headers.get("x-atlarix-tier")?.trim().toLowerCase() || null;
  if (!servedModel && freeRemaining == null && !billing) return null;
  return {
    servedModel: servedModel || null,
    billing,
    tier,
    onFloor: floorRaw === "1" ? true : floorRaw === "0" ? false : null,
    costCents: cost != null && Number.isFinite(cost) ? cost : null,
    freeRemaining:
      freeRemaining != null && Number.isFinite(freeRemaining)
        ? Math.max(0, Math.min(100, freeRemaining))
        : null,
  };
}

let latest: AutoStatus | null = null;

/**
 * The last Auto reply's facts in this process. The app's windows also get them
 * by IPC; the CLI and the editor agent have no window, so recaps read this.
 */
export function latestAutoStatus(): AutoStatus | null {
  return latest;
}

export function broadcastAutoStatus(headers: Headers): void {
  const status = autoStatusFromHeaders(headers);
  if (!status) return;
  latest = status;
  // Paid vs free decides Auto's context window (auto-context-window.ts).
  void noteAutoBilling(status.billing);
  // The one place the answering model is recorded on this machine.
  log.scope("atlarix-auto").info(
    `Auto reply: billing=${status.billing ?? "?"} model=${status.servedModel ?? "?"}`,
  );
  // The Usage page's "Auto picks", on this computer.
  void import("@/lib/stats/usage-stats")
    .then((m) => m.recordAutoPickSafely({ servedModel: status.servedModel, billing: status.billing, tier: status.tier }))
    .catch(() => {});
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) safeSend(win.webContents, "core:auto-status", status);
  }
}
