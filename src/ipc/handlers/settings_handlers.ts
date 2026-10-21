import { ipcMain } from "electron";
import { broadcastToAllWindows } from "../utils/broadcast_all_windows";
import type { UserSettings } from "../../lib/schemas";
import { writeSettings } from "../../main/settings";
import { readSettings, isSecretEncryptionAvailable } from "../../main/settings";
import {
  trackAcquisitionSource,
  trackPeerPushPrompt,
  trackAnalyticsTurnedOn,
  getSignedInUserId,
} from "../../main/lib/analytics";
import { ACQUISITION_DETAIL_MAX } from "../../lib/community/acquisition";
import { effortAfterModelChange } from "../../lib/routing/model-reasoning-profile";
import { effortChoicesForModel } from "../../lib/routing/reasoning-detector";

export function registerSettingsHandlers() {
  // Intentionally do NOT use handle because it could log sensitive data from the return value.
  ipcMain.handle("get-user-settings", async () => {
    const settings = readSettings();
    return settings;
  });

  // A20/L-5: lets the renderer warn when provider keys / OAuth tokens are stored
  // WITHOUT OS encryption (no keystore) — a non-sensitive boolean only.
  ipcMain.handle("settings:secret-encryption-available", async () => {
    return isSecretEncryptionAvailable();
  });

  // Intentionally do NOT use handle because it could log sensitive data from the args.
  ipcMain.handle(
    "set-user-settings",
    async (_, settings: Partial<UserSettings>) => {
      const prev = readSettings();
      // A new model keeps the /effort level only when it lists it too; otherwise
      // it runs its own default (owner: never translated between models). Here,
      // where every window's model change is written, and in main, where the
      // catalog is.
      const modelChanged =
        settings.selectedModel != null &&
        (settings.selectedModel.provider !== prev.selectedModel?.provider ||
          settings.selectedModel.name !== prev.selectedModel?.name);
      writeSettings(
        modelChanged && settings.effort === undefined
          ? { ...settings, ...effortAfterModelChange(effortChoicesForModel(settings.selectedModel), prev) }
          : settings,
      );
      // Mode and model choices reach analytics on the next turn
      // (`turn_completed.changed`), from every surface, not from here.
      const next = readSettings();
      // Analytics just turned on: this process's start and today's active day.
      if (next.telemetryConsent === "opted_in" && prev.telemetryConsent !== "opted_in") trackAnalyticsTurnedOn();
      // EVERY WINDOW, not just the one that asked. `useSettings` loads once per
      // window into a jotai atom and nothing invalidated the others, so a second
      // window kept showing stale settings until it was reloaded — which is why
      // zoom already drifted between windows. Language makes that visible
      // (window A in French, window B still English), so the broadcast lands
      // here rather than being bolted onto the language feature alone.
      broadcastToAllWindows("settings:changed", next);
      return next;
    },
  );

  /**
   * "Where did you hear about Atlarix?" — persist the local don't-ask-again gate
   * AND send the PostHog person property in ONE place, so the two can't drift
   * apart (a stored answer that never reached PostHog would look like an
   * unanswered user forever).
   */
  ipcMain.handle(
    "community:record-acquisition-source",
    async (
      _,
      {
        source,
        detail,
        userId,
      }: { source: string; detail?: string; userId?: string },
    ) => {
      const clean = String(source ?? "").trim();
      if (!clean) return { ok: false as const };
      const trimmedDetail = String(detail ?? "")
        .trim()
        .slice(0, ACQUISITION_DETAIL_MAX);
      writeSettings({
        acquisitionSource: {
          // Main is authoritative, but fall back to the id the renderer is
          // actually signed in as. The stored id is compared against that one
          // to decide "already answered" — if the two ever disagreed, the user
          // would be re-asked on every launch forever.
          // `||`, not `??`: an empty string must fall through to the next
          // candidate, and `?? ` would treat "" as a valid id.
          userId:
            getSignedInUserId() || String(userId ?? "").trim() || "anonymous",
          source: clean,
          ...(trimmedDetail ? { detail: trimmedDetail } : {}),
          answeredAt: Date.now(),
        },
      });
      trackAcquisitionSource(clean, trimmedDetail || undefined);
      return { ok: true as const };
    },
  );

  /**
   * PeerPush prompt lifecycle. `clicked` records that the review page was
   * OPENED — never that a review was left, which we cannot observe.
   */
  ipcMain.handle(
    "community:peerpush-prompt",
    async (_, { action }: { action: "shown" | "clicked" | "dismissed" }) => {
      const prev = readSettings().peerPushPrompt ?? {};
      const now = Date.now();
      writeSettings({
        peerPushPrompt: {
          ...prev,
          ...(action === "shown" ? { askedAt: prev.askedAt ?? now } : {}),
          ...(action === "clicked" ? { clickedThroughAt: now } : {}),
          ...(action === "dismissed" ? { dismissedAt: now } : {}),
        },
      });
      trackPeerPushPrompt(action);
      return { ok: true as const };
    },
  );
}
