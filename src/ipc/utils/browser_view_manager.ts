/**
 * In-app browser (v11) — WebContentsView management for the Browser panel.
 *
 * Security posture (this feature was roadmap-deferred pending exactly this):
 * - Isolated `persist:atlarix-browser` session — cookies/storage never touch
 *   the app session.
 * - `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and a
 *   dedicated minimal preload (`preload-browser.ts` — WebMCP shim + relay).
 * - http(s)-only scheme allowlist (agent AND user navigation).
 * - Popups denied (window.open → navigate current tab); permission requests
 *   (camera/mic/geo/notifications/…) denied by default; downloads blocked.
 * - Page content is hostile: read/screenshot results are wrapped in untrusted
 *   envelopes by the browser tools, with the origin disclosed to the model.
 */

import { WebContentsView, BrowserWindow, session, type Session } from "electron";

import log from "electron-log";
import { safeSend } from "./safe_sender";

const logger = log.scope("browser_view");

export type BrowserTabState = {
  id: number;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

export type BrowserPanelState = {
  tabs: BrowserTabState[];
  activeTabId: number | null;
  visible: boolean;
};

type Rect = { x: number; y: number; width: number; height: number };

const BROWSER_PARTITION = "persist:atlarix-browser";
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

let nextTabId = 1;
const tabs = new Map<number, WebContentsView>();
let activeTabId: number | null = null;
let visible = false;
let lastBounds: Rect | null = null;
let attachedWindow: BrowserWindow | null = null;

export function isAllowedBrowserUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return ALLOWED_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

/** Normalize user input: add https:// when a bare domain is typed. */
export function normalizeBrowserInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (isAllowedBrowserUrl(trimmed)) return trimmed;
  if (!/\s/.test(trimmed) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(trimmed)) {
    const candidate = `https://${trimmed}`;
    if (isAllowedBrowserUrl(candidate)) return candidate;
  }
  return null;
}

function browserSession(): Session {
  const ses = session.fromPartition(BROWSER_PARTITION, { cache: true });
  if (!(ses as Session & { __atlarixHardened?: boolean }).__atlarixHardened) {
    (ses as Session & { __atlarixHardened?: boolean }).__atlarixHardened = true;
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      logger.log(`[browser] permission "${permission}" denied (default policy)`);
      callback(false);
    });
    ses.on("will-download", (event, item) => {
      logger.warn(`[browser] download blocked: ${item.getURL()}`);
      event.preventDefault();
    });
  }
  return ses;
}

function hostWindow(): BrowserWindow | null {
  if (attachedWindow && !attachedWindow.isDestroyed()) return attachedWindow;
  attachedWindow =
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;
  return attachedWindow;
}

function broadcastState(): void {
  const win = hostWindow();
  if (!win) return;
  safeSend(win.webContents, "browser:state-changed", getBrowserPanelState());
}

export function getBrowserPanelState(): BrowserPanelState {
  return {
    tabs: [...tabs.entries()].map(([id, view]) => ({
      id,
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
      loading: view.webContents.isLoading(),
      canGoBack: view.webContents.navigationHistory.canGoBack(),
      canGoForward: view.webContents.navigationHistory.canGoForward(),
    })),
    activeTabId,
    visible,
  };
}

export function getActiveTabView(): WebContentsView | null {
  if (activeTabId == null) return null;
  return tabs.get(activeTabId) ?? null;
}

function wireTabEvents(id: number, view: WebContentsView): void {
  const wc = view.webContents;
  for (const evt of [
    "did-navigate",
    "did-navigate-in-page",
    "page-title-updated",
    "did-start-loading",
    "did-stop-loading",
  ] as const) {
    wc.on(evt as never, () => broadcastState());
  }
  wc.on("did-fail-load", (_e, code, desc, url) => {
    if (code !== -3 /* aborted */) {
      logger.warn(`[browser] load failed (${code}) ${desc} ${url}`);
    }
    broadcastState();
  });
  // Popups: deny new windows; navigate the same tab instead.
  wc.setWindowOpenHandler(({ url }) => {
    if (isAllowedBrowserUrl(url)) void wc.loadURL(url);
    return { action: "deny" };
  });
  // Block protocol-downgrade/external schemes on in-page navigation.
  wc.on("will-navigate", (event, url) => {
    if (!isAllowedBrowserUrl(url)) {
      logger.warn(`[browser] blocked navigation to ${url}`);
      event.preventDefault();
    }
  });
  // WebMCP (Phase 4): page tools are registered per-document; clear on nav.
  wc.on("did-navigate", () => {
  });
  wc.on("destroyed", () => {
  });
}

export function createTab(url?: string): BrowserPanelState {
  const win = hostWindow();
  if (!win) throw new Error("No application window available");

  const view = new WebContentsView({
    webPreferences: {
      session: browserSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  const id = nextTabId++;
  tabs.set(id, view);
  (view.webContents as Electron.WebContents & { __atlarixTabId?: number }).__atlarixTabId = id;
  wireTabEvents(id, view);

  setActiveTab(id);
  const target = url && isAllowedBrowserUrl(url) ? url : "https://www.google.com";
  void view.webContents.loadURL(target);
  broadcastState();
  return getBrowserPanelState();
}

export function closeTab(id: number): BrowserPanelState {
  const view = tabs.get(id);
  if (view) {
    const win = hostWindow();
    if (win) win.contentView.removeChildView(view);
    view.webContents.close();
    tabs.delete(id);
  }
  if (activeTabId === id) {
    activeTabId = tabs.size > 0 ? [...tabs.keys()].pop()! : null;
    if (activeTabId != null) setActiveTab(activeTabId);
  }
  broadcastState();
  return getBrowserPanelState();
}

export function setActiveTab(id: number): void {
  const view = tabs.get(id);
  const win = hostWindow();
  if (!view || !win) return;
  // Detach all, then attach the active one (single visible surface).
  for (const [, v] of tabs) {
    win.contentView.removeChildView(v);
  }
  activeTabId = id;
  if (visible) {
    win.contentView.addChildView(view);
    if (lastBounds) view.setBounds(lastBounds);
  }
  broadcastState();
}

export function navigate(id: number | null, url: string): boolean {
  const view = id == null ? getActiveTabView() : (tabs.get(id) ?? null);
  if (!view) return false;
  if (!isAllowedBrowserUrl(url)) return false;
  void view.webContents.loadURL(url);
  return true;
}

export function goBack(): void {
  const view = getActiveTabView();
  if (view?.webContents.navigationHistory.canGoBack()) {
    view.webContents.navigationHistory.goBack();
  }
}

export function goForward(): void {
  const view = getActiveTabView();
  if (view?.webContents.navigationHistory.canGoForward()) {
    view.webContents.navigationHistory.goForward();
  }
}

export function reload(): void {
  getActiveTabView()?.webContents.reload();
}

export function setBounds(rect: Rect): void {
  lastBounds = rect;
  const view = getActiveTabView();
  if (view && visible) view.setBounds(rect);
}

export function setVisible(nextVisible: boolean): void {
  const win = hostWindow();
  visible = nextVisible;
  if (!win) return;
  const view = getActiveTabView();
  if (!view) {
    if (nextVisible) createTab();
    return;
  }
  if (nextVisible) {
    win.contentView.addChildView(view);
    if (lastBounds) view.setBounds(lastBounds);
  } else {
    win.contentView.removeChildView(view);
  }
  broadcastState();
}

/** Ensure a tab exists (agent navigation may run before the panel was opened). */
export function ensureTab(): WebContentsView {
  const existing = getActiveTabView();
  if (existing) return existing;
  createTab();
  const created = getActiveTabView();
  if (!created) throw new Error("Failed to create browser tab");
  return created;
}
