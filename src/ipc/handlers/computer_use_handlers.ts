/**
 * Computer use in the app: the indicator (main/computer-indicator.ts), and in
 * Settings the macOS grants (Screen Recording,
 * Accessibility), read through the executor itself so the answer is about the
 * process that will act. The per-model switches need no channel: they are a
 * settings list, and each model row already says whether it is eligible.
 */
import { app, ipcMain } from "electron";
import { helperRequest } from "@/lib/computer/helper";
import type { ComputerUsePermissions } from "@/ipc/ipc_types";
import { initComputerIndicator } from "@/main/computer-indicator";

const REQUESTS = new Set(["screen", "accessibility"]);

export function registerComputerUseHandlers(): void {
  // The app's "controlling your screen" pill and stop shortcut.
  initComputerIndicator();

  // Reading never prompts; `request` shows that one system prompt first.
  ipcMain.handle("computer-use:permissions", async (_e, request?: string): Promise<ComputerUsePermissions> => {
    try {
      const r = await helperRequest("permissions", REQUESTS.has(String(request)) ? { request } : {});
      return { screen: r.screen, accessibility: r.accessibility } as ComputerUsePermissions;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // macOS applies a new Screen Recording grant only to a fresh process.
  ipcMain.handle("computer-use:relaunch", () => {
    app.relaunch();
    app.quit();
  });
}
