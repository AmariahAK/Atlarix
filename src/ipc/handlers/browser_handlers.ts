/**
 * In-app browser IPC — what the renderer still reads from the agent's hidden
 * browser: the Errors/Console and Network tabs.
 *
 * The visible Browser panel, and the tab/navigation/bounds/visibility handlers
 * that drove it, were removed on 2026-09-23 (the tabs now live in a hidden host
 * window; see `browser_view_manager.ts`). Every handler resolves the scope from
 * `event.sender`, so a window only ever reads ITS OWN tabs.
 */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import {
  browserScopeForWindow,
  getBrowserPanelState,
  getBrowserSurfaceErrors,
  clearBrowserSurfaceErrors,
  getTabViewById,
} from "../utils/browser_view_manager";
import {
  fetchResponseBody,
  getNetworkEntries,
  isTabDegraded,
} from "../utils/browser_network_capture";

const logger = log.scope("browser_ipc");

/** The calling window's browser scope, or null if its window is already gone. */
function scopeOf(event: IpcMainInvokeEvent) {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return null;
  return browserScopeForWindow(win);
}

export function registerBrowserHandlers(): void {
  // Runtime errors captured from the browser tabs (Errors tab + agent).
  ipcMain.handle("browser:get-errors", (e) => {
    const scope = scopeOf(e);
    return scope ? getBrowserSurfaceErrors(scope) : [];
  });

  ipcMain.handle("browser:clear-errors", (e) => {
    const scope = scopeOf(e);
    if (scope) clearBrowserSurfaceErrors(scope);
  });

  // ── Network tab ───────────────────────────────────────────────────────────
  // PULL, not push. A page load is hundreds of requests; a push channel would be
  // the same flood shape that once cost this app a thermal regression, and the
  // panel only needs the data while someone is looking at it. Capture itself runs
  // regardless of whether the panel is open — this only reads.
  ipcMain.handle("browser:get-network", (e) => {
    const scope = scopeOf(e);
    if (!scope) return { tabs: [] };
    return {
      tabs: getBrowserPanelState(scope).tabs.map((tab) => ({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        degraded: isTabDegraded(tab.id),
        entries: getNetworkEntries(tab.id),
      })),
    };
  });

  /**
   * One response body, fetched on demand when a row is expanded.
   *
   * Never eager: CDP's buffer is bounded and holding every body would cost far
   * more than it is worth. Expect misses — the renderer must show "no longer
   * buffered" rather than an empty body.
   */
  ipcMain.handle(
    "browser:get-network-body",
    async (e, tabId: number, requestId: string) => {
      const scope = scopeOf(e);
      if (!scope) return { unavailable: "This window is gone." };
      const view = getTabViewById(scope, Number(tabId));
      if (!view || view.webContents.isDestroyed()) {
        return {
          unavailable: "That tab is closed, so its bodies are gone with it.",
        };
      }
      return await fetchResponseBody(view.webContents, String(requestId));
    },
  );

  logger.log("[browser] handlers registered");
}
