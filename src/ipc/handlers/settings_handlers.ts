import { ipcMain } from "electron";
import { broadcastToAllWindows } from "../utils/broadcast_all_windows";
import type { UserSettings } from "../../lib/schemas";
import { writeSettings } from "../../main/settings";
import { readSettings, isSecretEncryptionAvailable } from "../../main/settings";
import { trackAnalyticsTurnedOn } from "../../main/lib/analytics";
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
    async (event, settings: Partial<UserSettings>) => {
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
      // A model picked in a window is that window's chat's from now on, as well
      // as what a new chat starts with, whatever wrote it (15.11.1, QA ai-44
      // check 6): its row, so the chip, the turn and the reply label agree.
      if (settings.selectedModel != null) await stampFrontChat(event, settings);
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
}

/** Store a model written from a window on the chat that window has in front. */
async function stampFrontChat(
  event: Electron.IpcMainInvokeEvent,
  settings: Partial<UserSettings>,
): Promise<void> {
  try {
    const { frontSessionOf } = await import("@/main/front-session");
    const sessionId = frontSessionOf(event.sender.id);
    const m = settings.selectedModel;
    if (!sessionId || !m?.provider || !m.name) return;
    const { stampSessionModel } = await import("./workspace_session_handlers");
    const row = await stampSessionModel(sessionId, {
      provider: m.provider,
      name: m.name,
      ...(m.customModelId != null ? { customModelId: m.customModelId } : {}),
      // An effort named with it is that chat's; none: its level carries over by
      // the same rule as the app's default.
      ...(settings.effort !== undefined ? { effort: settings.effort, deepThinking: !!settings.deepThinking } : {}),
    });
    if (!event.sender.isDestroyed()) {
      event.sender.send("session:model", { sessionId, model: row.model });
    }
  } catch (e) {
    // The app's default is written either way; the chat keeps its stored model.
    console.warn("[settings] could not store the model on the chat in front:", e);
  }
}
