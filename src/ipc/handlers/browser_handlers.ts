/**
 * In-app browser IPC (v11) — renderer Browser panel ↔ WebContentsView manager.
 *
 * Every handler resolves the browser scope from `event.sender`, so a panel only
 * ever drives ITS OWN window's tabs. These handlers previously ignored the event
 * entirely and operated on module-level state shared by every window, which is
 * how one project's browsing showed up in another's panel.
 */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import {
  browserScopeForWindow,
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
  getTabViewById,
  type BrowserPanelState,
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

/** A panel state for a window that no longer exists — never throw at a renderer. */
const EMPTY_STATE: BrowserPanelState = {
  tabs: [],
  activeTabId: null,
  visible: false,
};

export function registerBrowserHandlers(): void {
  ipcMain.handle("browser:get-state", (e) => {
    const scope = scopeOf(e);
    return scope ? getBrowserPanelState(scope) : EMPTY_STATE;
  });

  ipcMain.handle("browser:create-tab", (e, url?: string) => {
    const scope = scopeOf(e);
    return scope ? createTab(scope, url) : EMPTY_STATE;
  });

  ipcMain.handle("browser:close-tab", (e, id: number) => {
    const scope = scopeOf(e);
    return scope ? closeTab(scope, Number(id)) : EMPTY_STATE;
  });

  ipcMain.handle("browser:set-active-tab", (e, id: number) => {
    const scope = scopeOf(e);
    if (!scope) return EMPTY_STATE;
    setActiveTab(scope, Number(id));
    return getBrowserPanelState(scope);
  });

  ipcMain.handle("browser:navigate", (e, rawInput: string) => {
    const scope = scopeOf(e);
    if (!scope) return { ok: false, error: "No browser tab available." };
    const url = normalizeBrowserInput(String(rawInput ?? ""));
    if (!url) {
      return { ok: false, error: "Only http(s) URLs are allowed." };
    }
    const ok = navigate(scope, null, url);
    return ok ? { ok: true } : { ok: false, error: "No browser tab available." };
  });

  ipcMain.handle("browser:back", (e) => {
    const scope = scopeOf(e);
    if (!scope) return EMPTY_STATE;
    goBack(scope);
    return getBrowserPanelState(scope);
  });

  ipcMain.handle("browser:forward", (e) => {
    const scope = scopeOf(e);
    if (!scope) return EMPTY_STATE;
    goForward(scope);
    return getBrowserPanelState(scope);
  });

  ipcMain.handle("browser:reload", (e) => {
    const scope = scopeOf(e);
    if (!scope) return EMPTY_STATE;
    reload(scope);
    return getBrowserPanelState(scope);
  });

  ipcMain.handle(
    "browser:set-bounds",
    (e, rect: { x: number; y: number; width: number; height: number }) => {
      const scope = scopeOf(e);
      if (!scope) return;
      if (
        rect &&
        [rect.x, rect.y, rect.width, rect.height].every(
          (n) => typeof n === "number" && Number.isFinite(n),
        )
      ) {
        // Per window: two windows of different sizes previously shared one
        // geometry, so the view laid out at the wrong width in one of them.
        setBounds(scope, {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    },
  );

  ipcMain.handle("browser:set-visible", (e, visible: boolean) => {
    const scope = scopeOf(e);
    if (!scope) return EMPTY_STATE;
    setVisible(scope, Boolean(visible));
    return getBrowserPanelState(scope);
  });

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
        return { unavailable: "That tab is closed, so its bodies are gone with it." };
      }
      return await fetchResponseBody(view.webContents, String(requestId));
    },
  );

  logger.log("[browser] handlers registered");
}
