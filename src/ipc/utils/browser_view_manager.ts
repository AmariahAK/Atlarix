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
import { CLS_OBSERVER_SCRIPT } from "@/lib/browser/visual-lint";
import {
  ERROR_HOOK_SCRIPT,
  tryParseErrorSentinel,
  type BrowserSurfaceError,
} from "@/lib/browser/error-hook";

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

export type { BrowserSurfaceError } from "@/lib/browser/error-hook";
/** @deprecated back-compat alias — use BrowserSurfaceError. */
export type PreviewErrorEntry = BrowserSurfaceError;

type Rect = { x: number; y: number; width: number; height: number };

const BROWSER_PARTITION = "persist:atlarix-browser";
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
/** Preview network-failure capture ignores these (static-asset 404 noise). */
const NOISY_PREVIEW_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "image",
  "font",
  "stylesheet",
  "media",
  "cspReport",
  "ping",
  "webSocket",
]);

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
    // Capture failed (4xx/5xx) responses made by any BROWSER TAB so the agent's
    // app-verification completion gate can treat them as failures (a page that
    // renders but whose API calls 500 is still broken). Scoped to browser-tab
    // webContents and to app-level resource types so favicon/image 404 noise
    // can't trip the gate. webRequest is otherwise unused, so registering here
    // clobbers nothing.
    ses.webRequest.onCompleted((details) => {
      try {
        const status = details.statusCode ?? 0;
        if (status < 400) return;
        if (!isBrowserTabWebContents(details.webContentsId)) return;
        // Keep document/script/data requests; drop static-asset noise so a
        // missing favicon/image/font can't trip the gate. (Electron resourceType
        // literals vary by version, so we EXCLUDE the noisy set rather than match
        // an allowlist of names that may not exist.)
        if (NOISY_PREVIEW_RESOURCE_TYPES.has(details.resourceType)) return;
        pushBrowserSurfaceError({
          type: "network-failed",
          message: `HTTP ${status} ${details.method ?? "GET"} ${details.url}`,
          url: details.url,
          statusCode: status,
          timestamp: nowTs(),
        });
      } catch {
        /* request logging must never throw */
      }
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

/** Send an event to the renderer (host window). Used by sibling main-process
 *  modules (e.g. browser-reel, background jobs) that don't track the window. */
export function broadcastToRenderer(channel: string, payload: unknown): void {
  const win = hostWindow();
  if (win) safeSend(win.webContents, channel, payload);
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

/**
 * Cmd/Ctrl+W handler: close the active browser tab only when the browser panel
 * is actually visible with a tab. Returns true if a tab was closed (the caller
 * then swallows the key); false lets the OS default (window close) proceed.
 */
export function closeActiveBrowserTabIfVisible(): boolean {
  if (!visible || activeTabId == null || tabs.size === 0) return false;
  closeTab(activeTabId);
  return true;
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
  // ── Runtime error capture (the Errors tab + the agent's completion gate) ──
  // console.error / warn (and our injected [[ATLARIX_ERR]] sentinel carrying a
  // stack) surface here. Signature differs across Electron majors (positional
  // <35, event object >=35) — handle both.
  wc.on("console-message", (...a: unknown[]) => {
    let level: string | number | undefined;
    let message = "";
    let sourceUrl: string | undefined;
    if (typeof a[1] === "number") {
      level = a[1] as number;
      message = String(a[2] ?? "");
      sourceUrl = typeof a[4] === "string" ? (a[4] as string) : undefined;
    } else {
      const ev = (a[0] ?? {}) as { level?: string; message?: string; sourceId?: string };
      level = ev.level;
      message = String(ev.message ?? "");
      sourceUrl = ev.sourceId;
    }
    // Injected-hook sentinel: a structured error (with stack) from the page's
    // window.onerror / unhandledrejection / fetch wrap. Parse it and RETURN so
    // it isn't ALSO recorded as a plain console-error (no double-capture).
    const rich = tryParseErrorSentinel(message);
    if (rich) {
      pushBrowserSurfaceError({ ...rich, url: rich.url ?? sourceUrl, timestamp: nowTs() });
      return;
    }
    const isError = level === "error" || level === 2;
    const isWarn = level === "warning" || level === 3;
    if ((!isError && !isWarn) || !message) return;
    pushBrowserSurfaceError({
      type: "console-error",
      message: message.slice(0, 4000),
      url: sourceUrl,
      timestamp: nowTs(),
      level: isError ? "error" : "warning",
    });
  });
  wc.on("did-fail-load", (_e, code, desc, url) => {
    if (code === -3 /* aborted (redirects/SPAs) */) {
      broadcastState();
      return;
    }
    logger.warn(`[browser] load failed (${code}) ${desc} ${url}`);
    pushBrowserSurfaceError({
      type: "load-failed",
      message: `${desc} (${code})`,
      url,
      timestamp: nowTs(),
    });
    broadcastState();
  });
  wc.on("render-process-gone", (_e, details) => {
    pushBrowserSurfaceError({
      type: "render-gone",
      message: `Browser tab renderer gone: ${details?.reason ?? "unknown"}`,
      timestamp: nowTs(),
    });
  });
  // Install the injected instrumentation (uncaught errors / unhandled
  // rejections / failed fetch → stack traces) + the CLS observer as soon as the
  // document loads. Idempotent per page; best-effort (never blocks the load).
  wc.on("did-finish-load", () => {
    void wc.executeJavaScript(ERROR_HOOK_SCRIPT, true).catch(() => {});
    void wc.executeJavaScript(CLS_OBSERVER_SCRIPT, true).catch(() => {});
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

/** True if a webContents id belongs to one of our browser tabs. */
function isBrowserTabWebContents(id: number | undefined): boolean {
  if (id == null) return false;
  for (const v of tabs.values()) {
    if (!v.webContents.isDestroyed() && v.webContents.id === id) return true;
  }
  return false;
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

// ── Browser-tab runtime error capture ────────────────────────────────────────
// A WebContentsView exposes console/load/crash events natively (no DevTools, no
// CDP). We capture them per browser tab and surface them to BOTH the Errors tab
// (via the "browser:error" IPC) and the agent (getBrowserSurfaceErrors) so it
// can see and fix what actually broke at runtime. Uncaught exceptions / promise
// rejections additionally carry a STACK via an injected instrumentation hook
// (ERROR_HOOK_SCRIPT) relayed through the "[[ATLARIX_ERR]]" console sentinel.

const BROWSER_ERROR_BUFFER_MAX = 50;

let browserSurfaceErrors: BrowserSurfaceError[] = [];

export function getBrowserSurfaceErrors(): BrowserSurfaceError[] {
  return [...browserSurfaceErrors];
}

/** Just the captured failed (4xx/5xx) network responses. */
export function getBrowserSurfaceNetworkFailures(): BrowserSurfaceError[] {
  return browserSurfaceErrors.filter((e) => e.type === "network-failed");
}

export function clearBrowserSurfaceErrors(): void {
  browserSurfaceErrors = [];
}

function pushBrowserSurfaceError(entry: BrowserSurfaceError): void {
  browserSurfaceErrors.push(entry);
  if (browserSurfaceErrors.length > BROWSER_ERROR_BUFFER_MAX) {
    browserSurfaceErrors = browserSurfaceErrors.slice(-BROWSER_ERROR_BUFFER_MAX);
  }
  const win = hostWindow();
  if (win) safeSend(win.webContents, "browser:error", entry);
}

function nowTs(): number {
  return Date.now();
}


// ── Paintable capture (session reels) ────────────────────────────────────────
// capturePage() returns an EMPTY image for a WebContentsView that isn't attached
// to the window (no compositor surface). Session reels must record the
// agent-driven browser surface even when the user isn't looking at that
// right-panel tab — so if the view isn't currently attached, temporarily attach
// it OFF-SCREEN, let it paint, capture, then detach. Best-effort; never throws.
const OFFSCREEN_RECT: Rect = { x: -20000, y: 0, width: 1024, height: 768 };

export async function capturePaintable(
  view: WebContentsView,
): Promise<import("electron").NativeImage | null> {
  const win = hostWindow();
  if (!win || view.webContents.isDestroyed()) return null;
  const alreadyAttached = win.contentView.children.includes(view);
  if (alreadyAttached) {
    try {
      return await view.webContents.capturePage();
    } catch {
      return null;
    }
  }
  try {
    win.contentView.addChildView(view);
    view.setBounds(OFFSCREEN_RECT);
    // Give the compositor a beat to paint a frame before capturing.
    await new Promise((r) => setTimeout(r, 60));
    return await view.webContents.capturePage();
  } catch {
    return null;
  } finally {
    try {
      win.contentView.removeChildView(view);
      // Restore the active browser tab if the panel is meant to be visible to
      // the user (this off-screen capture must not steal the visible surface).
      if (visible && activeTabId != null) setActiveTab(activeTabId);
    } catch {
      /* ignore */
    }
  }
}
