import { ipcMain } from "electron";
import type { UserSettings } from "../../lib/schemas";
import { writeSettings } from "../../main/settings";
import { readSettings } from "../../main/settings";
import { capture as analyticsCapture } from "../../main/lib/analytics";

export function registerSettingsHandlers() {
  // Intentionally do NOT use handle because it could log sensitive data from the return value.
  ipcMain.handle("get-user-settings", async () => {
    const settings = readSettings();
    return settings;
  });

  // Intentionally do NOT use handle because it could log sensitive data from the args.
  ipcMain.handle(
    "set-user-settings",
    async (_, settings: Partial<UserSettings>) => {
      const prev = readSettings();
      writeSettings(settings);
      const next = readSettings();
      if (next.selectedChatMode !== prev.selectedChatMode) {
        if (next.selectedChatMode === "build") {
          analyticsCapture("build_mode_activated", {});
        } else if (next.selectedChatMode === "ask") {
          analyticsCapture("ask_mode_activated", {});
        }
      }
      if (
        next.selectedModel?.provider !== prev.selectedModel?.provider ||
        next.selectedModel?.name !== prev.selectedModel?.name
      ) {
        analyticsCapture("ai_model_selected", {
          provider: next.selectedModel?.provider ?? "",
          model_name: next.selectedModel?.name ?? "",
        });
      }
      return readSettings();
    },
  );
}
