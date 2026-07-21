/**
 * In-app browser IPC (v11) — renderer Browser panel ↔ WebContentsView manager.
 */

import { ipcMain } from "electron";
import log from "electron-log";
import {
  createTab,
  closeTab,
  setActiveTab,
  navigate,
  goBack,
  goForward,
  reload,
  setBounds,
  setVisible,
  getBrowserPanelState,
  normalizeBrowserInput,
  getBrowserSurfaceErrors,
  clearBrowserSurfaceErrors,
} from "../utils/browser_view_manager";

const logger = log.scope("browser_ipc");

export function registerBrowserHandlers(): void {
  ipcMain.handle("browser:get-state", () => getBrowserPanelState());

  ipcMain.handle("browser:create-tab", (_e, url?: string) => createTab(url));

  ipcMain.handle("browser:close-tab", (_e, id: number) => closeTab(Number(id)));

  ipcMain.handle("browser:set-active-tab", (_e, id: number) => {
    setActiveTab(Number(id));
    return getBrowserPanelState();
  });

  ipcMain.handle("browser:navigate", (_e, rawInput: string) => {
    const url = normalizeBrowserInput(String(rawInput ?? ""));
    if (!url) {
      return { ok: false, error: "Only http(s) URLs are allowed." };
    }
    const ok = navigate(null, url);
    return ok ? { ok: true } : { ok: false, error: "No browser tab available." };
  });

  ipcMain.handle("browser:back", () => {
    goBack();
    return getBrowserPanelState();
  });

  ipcMain.handle("browser:forward", () => {
    goForward();
    return getBrowserPanelState();
  });

  ipcMain.handle("browser:reload", () => {
    reload();
    return getBrowserPanelState();
  });

  ipcMain.handle(
    "browser:set-bounds",
    (_e, rect: { x: number; y: number; width: number; height: number }) => {
      if (
        rect &&
        [rect.x, rect.y, rect.width, rect.height].every(
          (n) => typeof n === "number" && Number.isFinite(n),
        )
      ) {
        setBounds({
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    },
  );

  ipcMain.handle("browser:set-visible", (_e, visible: boolean) => {
    setVisible(Boolean(visible));
    return getBrowserPanelState();
  });

  // Runtime errors captured from the browser tabs (Errors tab + agent).
  ipcMain.handle("browser:get-errors", () => getBrowserSurfaceErrors());

  ipcMain.handle("browser:clear-errors", () => {
    clearBrowserSurfaceErrors();
  });

  logger.log("[browser] handlers registered");
}
