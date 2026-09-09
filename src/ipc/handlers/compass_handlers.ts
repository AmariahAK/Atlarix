import { ipcMain } from "electron";
import log from "electron-log";
import { isCompassBuildConfigured } from "../shared/compass_constants";
import {
  computeCoreSlotChange,
  effectiveCoreModelId,
  type CoreSlotChange,
} from "@/lib/routing/core-slot-change";
import { readSettings, writeSettings } from "@/main/settings";

const logger = log.scope("compass_ipc");

export function registerCompassHandlers(): void {
  ipcMain.handle("compass:is-build-configured", () => {
    return isCompassBuildConfigured();
  });

  /**
   * Has the model behind this user's Core slot changed since they last saw it?
   *
   * SEEDS THE BASELINE WHEN THERE ISN'T ONE, and returns null in the same breath.
   * That write is why this is not a pure read: without it a fresh install (or the
   * first launch after this shipped) would have no baseline now and still have none
   * later, so the NEXT lineup change would also pass unmentioned. Seeding silently is
   * the only behaviour that both stays quiet about a change the user never
   * experienced and arms the notice for the one after it.
   */
  ipcMain.handle(
    "compass:get-slot-change-notice",
    (): CoreSlotChange | null => {
      try {
        const settings = readSettings();
        const current = effectiveCoreModelId(settings.selectedModel);
        if (!current) return null;

        const change = computeCoreSlotChange(
          settings.lastSeenCoreModel,
          current,
        );
        if (!settings.lastSeenCoreModel?.trim()) {
          writeSettings({ lastSeenCoreModel: current });
          return null;
        }
        if (change) {
          logger.log(
            `[compass] Core model changed for this user: ${change.from} → ${change.to}`,
          );
        }
        return change;
      } catch (e) {
        // A notice is a nicety. Failing to compute one must never break a chat.
        logger.warn("[compass] slot-change check failed", e);
        return null;
      }
    },
  );

  /**
   * The user has seen it. Advancing the baseline is the dismissal — see
   * `core-slot-change.ts` on why there is no separate dismissed-ids store.
   *
   * NOTE this writes through `writeSettings` directly, which does NOT broadcast
   * `settings:changed` (only the `set-user-settings` handler does). That is fine and
   * deliberate: the renderer hides its own banner, so nothing else needs to hear.
   */
  ipcMain.handle("compass:ack-slot-change", () => {
    try {
      const settings = readSettings();
      const current = effectiveCoreModelId(settings.selectedModel);
      if (current) writeSettings({ lastSeenCoreModel: current });
      return { success: true };
    } catch (e) {
      logger.warn("[compass] slot-change ack failed", e);
      return { success: false };
    }
  });

  logger.log("[compass] handlers registered");
}
