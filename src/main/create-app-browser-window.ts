/**
 * Additional Atlarix BrowserWindow (one per workspace path when requested).
 */

import path from "node:path";
import { BrowserWindow } from "electron";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;

export function createAppBrowserWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: process.env.NODE_ENV === "development" ? 1280 : 960,
    minWidth: 800,
    height: 700,
    minHeight: 500,
    titleBarStyle: "hidden",
    titleBarOverlay: false,
    trafficLightPosition: { x: 10, y: 8 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      plugins: true,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/main_window/index.html"));
  }

  win.webContents.once("did-finish-load", () => {
    if (!win.isDestroyed()) {
      win.webContents.send("db-ready");
    }
  });

  return win;
}

export function deliverToWindow(
  win: BrowserWindow,
  channel: string,
  payload: unknown,
): void {
  const send = () => {
    if (win.isDestroyed()) return;
    win.webContents.send(channel, payload);
    if (win.isMinimized()) win.restore();
    win.focus();
  };
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}
