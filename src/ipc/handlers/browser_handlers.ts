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
  loadPreview,
  setPreviewBounds,
  setPreviewVisible,
  getPreviewErrors,
  clearPreviewErrors,
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

  // ── Preview surface (workstream 1) — the dev-server WebContentsView shown in
  // the Preview pane and drivable by the agent via browser tools target:"preview".
  ipcMain.handle("preview:load", (_e, rawUrl: string) => {
    const url = String(rawUrl ?? "").trim();
    return loadPreview(url)
      ? { ok: true }
      : { ok: false, error: "Only http(s) URLs can be loaded in the preview." };
  });

  ipcMain.handle(
    "preview:set-bounds",
    (_e, rect: { x: number; y: number; width: number; height: number }) => {
      if (
        rect &&
        [rect.x, rect.y, rect.width, rect.height].every(
          (n) => typeof n === "number" && Number.isFinite(n),
        )
      ) {
        setPreviewBounds({
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    },
  );

  ipcMain.handle("preview:set-visible", (_e, visible: boolean) => {
    setPreviewVisible(Boolean(visible));
  });

  ipcMain.handle("preview:get-errors", () => getPreviewErrors());

  ipcMain.handle("preview:clear-errors", () => {
    clearPreviewErrors();
  });

  logger.log("[browser] handlers registered");
}
