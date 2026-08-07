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

/**
 * Everything the browser panel owns, PER WINDOW.
 *
 * All of this used to be module-level, so every window shared one tab set, one
 * panel, one page-error buffer — window 1's browsing genuinely was window 2's.
 * `hostWindow()` compounded it by falling back to `getAllWindows().find(...)`,
 * i.e. the FIRST window, so the view could attach to a window that never asked
 * for it. `lastBounds` was the quiet one: two windows of different sizes shared
 * a single panel geometry, so the view laid out at the wrong width in whichever
 * window had not reported last.
 *
 * Deliberately NOT per window: the `persist:atlarix-browser` session (one cookie
 * jar, so a login the user performed themselves works everywhere — what
 * browser_tabs already promises the model) and `paintHost` (a compositor
 * surface, not state).
 */
export type BrowserScope = {
  /** The window this panel belongs to. */
  window: BrowserWindow;
  tabs: Map<number, WebContentsView>;
  activeTabId: number | null;
  visible: boolean;
  lastBounds: Rect | null;
  surfaceErrors: BrowserSurfaceError[];
  panelWaiters: Array<() => void>;
  /** True once a panel request went unanswered — the user wants it closed. */
  panelRequestDeclined: boolean;
};

/** Tab ids stay globally unique so an id can never mean two things at once. */
let nextTabId = 1;

const scopes = new Map<number, BrowserScope>();

/** The scope for a window, created on first use. */
export function browserScopeForWindow(win: BrowserWindow): BrowserScope {
  const existing = scopes.get(win.id);
  // Identity, not just liveness: the map is keyed by window id, and an id can
  // outlive the window it belonged to (a stale entry whose `closed` never fired,
  // or a reused id). Matching on `isDestroyed()` alone would hand a brand-new
  // window another window's tabs — the exact leak this whole change removes.
  if (existing && existing.window === win && !win.isDestroyed()) return existing;
  const scope: BrowserScope = {
    window: win,
    tabs: new Map(),
    activeTabId: null,
    visible: false,
    lastBounds: null,
    surfaceErrors: [],
    panelWaiters: [],
    panelRequestDeclined: false,
  };
  scopes.set(win.id, scope);
  win.once("closed", () => {
    // Tear the views down explicitly; a WebContentsView outliving its window
    // keeps a live renderer process around.
    for (const view of scope.tabs.values()) {
      try {
        if (!view.webContents.isDestroyed()) view.webContents.close();
      } catch {
        /* shutdown best-effort */
      }
    }
    scopes.delete(win.id);
  });
  return scope;
}

/**
 * Resolve the scope for a caller.
 *
 * `windowId` comes from `_ownerWindowId`, injected once in `runToolExecute` from
 * the requesting window's `sender`. When absent — automations, headless, or a
 * main-process caller with no window in hand — fall back to the focused window
 * and then to the only window, which is exactly the previous single-window
 * behaviour. Returns null only when there is genuinely no window.
 */
export function resolveBrowserScope(windowId?: number | null): BrowserScope | null {
  if (typeof windowId === "number") {
    const win = BrowserWindow.fromId(windowId);
    if (win && !win.isDestroyed()) return browserScopeForWindow(win);
  }
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return browserScopeForWindow(focused);
  const only = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  return only ? browserScopeForWindow(only) : null;
}

/** Every live scope — for session-wide handlers that must search all windows. */
function allScopes(): BrowserScope[] {
  return [...scopes.values()].filter((s) => !s.window.isDestroyed());
}

/**
 * Bounds to attach with before the renderer's ResizeObserver has reported real
 * ones (`browser:set-bounds`). Without this, the first agent navigation with
 * the panel never opened attaches the view with NO bounds — and a view whose
 * rect doesn't intersect the window gets a 0x0 layout viewport, so the document
 * lays out at zero width and every geometry answer is plausible but wrong.
 * Derived from the host window so it's a realistic reading width, never 0.
 */
function fallbackBounds(win: BrowserWindow): Rect {
  const { width, height } = win.getContentBounds();
  const w = Math.max(480, Math.round(width / 2));
  return { x: Math.max(0, width - w), y: 0, width: w, height: Math.max(360, height) };
}

/** Real bounds if THIS window's renderer has reported them, else a sane default. */
function boundsFor(scope: BrowserScope): Rect {
  return scope.lastBounds ?? fallbackBounds(scope.window);
}

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
        // The session is shared by every window, so find which scope this tab
        // belongs to — the failure is that window's, and only that window's
        // completion gate should see it.
        const owner = scopeForWebContentsId(details.webContentsId);
        if (!owner) return;
        // Keep document/script/data requests; drop static-asset noise so a
        // missing favicon/image/font can't trip the gate. (Electron resourceType
        // literals vary by version, so we EXCLUDE the noisy set rather than match
        // an allowlist of names that may not exist.)
        if (NOISY_PREVIEW_RESOURCE_TYPES.has(details.resourceType)) return;
        pushBrowserSurfaceError(owner, {
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

function broadcastState(scope: BrowserScope): void {
  if (scope.window.isDestroyed()) return;
  safeSend(
    scope.window.webContents,
    "browser:state-changed",
    getBrowserPanelState(scope),
  );
}

/**
 * Send an event to one window's renderer.
 *
 * NOTE for callers outside the browser panel: this delivers to the window that
 * owns the given browser scope, which is NOT necessarily the window whose work
 * produced the event. Background-job and automation updates should route by
 * WORKSPACE (`sendToWorkspaceWindowQuiet`) instead — see workspace-window-manager.
 */
export function broadcastToRenderer(
  scope: BrowserScope,
  channel: string,
  payload: unknown,
): void {
  if (!scope.window.isDestroyed()) {
    safeSend(scope.window.webContents, channel, payload);
  }
}

export function getBrowserPanelState(scope: BrowserScope): BrowserPanelState {
  return {
    tabs: [...scope.tabs.entries()].map(([id, view]) => ({
      id,
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
      loading: view.webContents.isLoading(),
      canGoBack: view.webContents.navigationHistory.canGoBack(),
      canGoForward: view.webContents.navigationHistory.canGoForward(),
    })),
    activeTabId: scope.activeTabId,
    visible: scope.visible,
  };
}

export function getActiveTabView(scope: BrowserScope): WebContentsView | null {
  if (scope.activeTabId == null) return null;
  return scope.tabs.get(scope.activeTabId) ?? null;
}

/** Look up a specific tab's view by id (agent `tab_id` targeting). */
export function getTabViewById(
  scope: BrowserScope,
  id: number,
): WebContentsView | null {
  return scope.tabs.get(id) ?? null;
}

export function getActiveTabId(scope: BrowserScope): number | null {
  return scope.activeTabId;
}

/** How many tabs are open — drives the agent's `tab_id` ambiguity check. */
export function getTabCount(scope: BrowserScope): number {
  return scope.tabs.size;
}

/**
 * The id of the tab a view belongs to (results echo which tab was acted on, so
 * a wrong-tab action is visible instead of silent).
 */
export function getTabIdForView(view: WebContentsView): number | null {
  // Derived rather than passed: a view belongs to exactly one window, so asking
  // every caller to also supply the scope would be threading they cannot get
  // wrong but can forget.
  for (const scope of allScopes()) {
    for (const [id, v] of scope.tabs) {
      if (v === view) return id;
    }
  }
  return null;
}

/** The scope that owns a view — for helpers that only receive the view. */
export function scopeForView(view: WebContentsView): BrowserScope | null {
  for (const scope of allScopes()) {
    for (const v of scope.tabs.values()) {
      if (v === view) return scope;
    }
  }
  return null;
}

/**
 * Cmd/Ctrl+W handler: close the active browser tab only when the browser panel
 * is actually visible with a tab. Returns true if a tab was closed (the caller
 * then swallows the key); false lets the OS default (window close) proceed.
 */
export function closeActiveBrowserTabIfVisible(scope: BrowserScope): boolean {
  if (!scope.visible || scope.activeTabId == null || scope.tabs.size === 0) {
    return false;
  }
  closeTab(scope, scope.activeTabId);
  return true;
}

function wireTabEvents(
  scope: BrowserScope,
  id: number,
  view: WebContentsView,
): void {
  const wc = view.webContents;
  for (const evt of [
    "did-navigate",
    "did-navigate-in-page",
    "page-title-updated",
    "did-start-loading",
    "did-stop-loading",
  ] as const) {
    wc.on(evt as never, () => broadcastState(scope));
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
      pushBrowserSurfaceError(scope, { ...rich, url: rich.url ?? sourceUrl, timestamp: nowTs(), tabId: id });
      return;
    }
    const isError = level === "error" || level === 2;
    const isWarn = level === "warning" || level === 3;
    if ((!isError && !isWarn) || !message) return;
    pushBrowserSurfaceError(scope, {
      type: "console-error",
      message: message.slice(0, 4000),
      url: sourceUrl,
      timestamp: nowTs(),
      level: isError ? "error" : "warning",
      tabId: id,
    });
  });
  wc.on("did-fail-load", (_e, code, desc, url) => {
    if (code === -3 /* aborted (redirects/SPAs) */) {
      broadcastState(scope);
      return;
    }
    logger.warn(`[browser] load failed (${code}) ${desc} ${url}`);
    pushBrowserSurfaceError(scope, {
      type: "load-failed",
      message: `${desc} (${code})`,
      url,
      timestamp: nowTs(),
      tabId: id,
    });
    broadcastState(scope);
  });
  wc.on("render-process-gone", (_e, details) => {
    pushBrowserSurfaceError(scope, {
      type: "render-gone",
      message: `Browser tab renderer gone: ${details?.reason ?? "unknown"}`,
      timestamp: nowTs(),
      tabId: id,
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

/**
 * Which window's browser owns this webContents, if any.
 *
 * The `persist:atlarix-browser` session is shared by every window, so a
 * session-level handler sees every window's tabs and must attribute the event to
 * the right one before recording it.
 */
function scopeForWebContentsId(id: number | undefined): BrowserScope | null {
  if (id == null) return null;
  for (const scope of allScopes()) {
    for (const v of scope.tabs.values()) {
      if (!v.webContents.isDestroyed() && v.webContents.id === id) return scope;
    }
  }
  return null;
}

export function createTab(scope: BrowserScope, url?: string): BrowserPanelState {
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
  scope.tabs.set(id, view);
  (view.webContents as Electron.WebContents & { __atlarixTabId?: number }).__atlarixTabId = id;
  wireTabEvents(scope, id, view);

  setActiveTab(scope, id);
  const target = url && isAllowedBrowserUrl(url) ? url : "https://www.google.com";
  void view.webContents.loadURL(target);
  broadcastState(scope);
  return getBrowserPanelState(scope);
}

export function closeTab(scope: BrowserScope, id: number): BrowserPanelState {
  const view = scope.tabs.get(id);
  if (view) {
    if (!scope.window.isDestroyed()) scope.window.contentView.removeChildView(view);
    view.webContents.close();
    scope.tabs.delete(id);
  }
  if (scope.activeTabId === id) {
    scope.activeTabId = scope.tabs.size > 0 ? [...scope.tabs.keys()].pop()! : null;
    if (scope.activeTabId != null) setActiveTab(scope, scope.activeTabId);
  }
  broadcastState(scope);
  return getBrowserPanelState(scope);
}

export function setActiveTab(scope: BrowserScope, id: number): void {
  const view = scope.tabs.get(id);
  if (!view || scope.window.isDestroyed()) return;
  // Detach all, then attach the active one (single visible surface).
  for (const [, v] of scope.tabs) {
    scope.window.contentView.removeChildView(v);
  }
  scope.activeTabId = id;
  if (scope.visible) {
    scope.window.contentView.addChildView(view);
    view.setBounds(boundsFor(scope));
  }
  broadcastState(scope);
}

export function navigate(
  scope: BrowserScope,
  id: number | null,
  url: string,
): boolean {
  const view = id == null ? getActiveTabView(scope) : (scope.tabs.get(id) ?? null);
  if (!view) return false;
  if (!isAllowedBrowserUrl(url)) return false;
  void view.webContents.loadURL(url);
  return true;
}

export function goBack(scope: BrowserScope): void {
  const view = getActiveTabView(scope);
  if (view?.webContents.navigationHistory.canGoBack()) {
    view.webContents.navigationHistory.goBack();
  }
}

export function goForward(scope: BrowserScope): void {
  const view = getActiveTabView(scope);
  if (view?.webContents.navigationHistory.canGoForward()) {
    view.webContents.navigationHistory.goForward();
  }
}

export function reload(scope: BrowserScope): void {
  getActiveTabView(scope)?.webContents.reload();
}

export function setBounds(scope: BrowserScope, rect: Rect): void {
  scope.lastBounds = rect;
  const view = getActiveTabView(scope);
  if (view && scope.visible) view.setBounds(rect);
  // Wake anything waiting for the panel to actually be on screen.
  const waiters = scope.panelWaiters;
  scope.panelWaiters = [];
  for (const w of waiters) w();
}

/**
 * The agent needs the browser on screen — ask the RENDERER to open the right
 * panel on its Browser tab, exactly like a plan artifact does, and wait briefly
 * for it to report bounds.
 *
 * Why not just `setVisible(true)`: that attaches the raw `WebContentsView` over
 * the window with no tab strip and no URL bar, because the React chrome isn't
 * mounted. With the right panel closed that renders as a bare browser slab
 * covering half the app — which is what a user actually sees, and it looks
 * broken. `setVisible` stays the RENDERER's call (panel mount/unmount); agent
 * code asks for the panel and lets the UI drive visibility.
 */
export async function requestBrowserPanel(
  scope: BrowserScope,
  timeoutMs = 1200,
): Promise<void> {
  if (scope.visible) return; // panel already mounted — nothing to ask for
  broadcastToRenderer(scope, "browser:request-panel", {});
  // If the user has closed the panel (or suppressed auto-open) the renderer
  // won't open it, and blocking the full timeout on every later call would tax
  // a deliberate choice. Ask once, then stop waiting — the browser tools work
  // fine with the panel shut, and `visible` flips the moment they reopen it.
  if (scope.panelRequestDeclined) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      scope.panelWaiters = scope.panelWaiters.filter((w) => w !== wake);
      scope.panelRequestDeclined = true;
      resolve();
    }, timeoutMs);
    const wake = () => {
      clearTimeout(timer);
      resolve();
    };
    scope.panelWaiters.push(wake);
  });
}

export function setVisible(scope: BrowserScope, nextVisible: boolean): void {
  scope.visible = nextVisible;
  // Reopening the panel clears the "user wants it closed" memory.
  if (nextVisible) scope.panelRequestDeclined = false;
  if (scope.window.isDestroyed()) return;
  const view = getActiveTabView(scope);
  if (!view) {
    if (nextVisible) createTab(scope);
    return;
  }
  if (nextVisible) {
    scope.window.contentView.addChildView(view);
    view.setBounds(boundsFor(scope));
  } else {
    scope.window.contentView.removeChildView(view);
  }
  broadcastState(scope);
}

/** Ensure a tab exists (agent navigation may run before the panel was opened). */
export function ensureTab(scope: BrowserScope): WebContentsView {
  const existing = getActiveTabView(scope);
  if (existing) return existing;
  createTab(scope);
  const created = getActiveTabView(scope);
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

export function getBrowserSurfaceErrors(
  scope: BrowserScope,
): BrowserSurfaceError[] {
  return [...scope.surfaceErrors];
}

/** Just the captured failed (4xx/5xx) network responses. */
export function getBrowserSurfaceNetworkFailures(
  scope: BrowserScope,
): BrowserSurfaceError[] {
  return scope.surfaceErrors.filter((e) => e.type === "network-failed");
}

export function clearBrowserSurfaceErrors(scope: BrowserScope): void {
  scope.surfaceErrors = [];
}

function pushBrowserSurfaceError(
  scope: BrowserScope,
  entry: BrowserSurfaceError,
): void {
  // Classify at RECORD time, not read time: the active tab can change between the
  // error arriving and the agent inspecting, and "was this mine when it happened"
  // is the question that matters.
  //
  // Errors buffer per WINDOW, so a second tab the user has open pushes into the same
  // list. Untagged, those read as the agent's own failures — they showed up in
  // browser_inspect and blocked the completion gate for pages the agent never
  // touched. `unrelated` marks them without hiding them, like a plan step's
  // `external` state.
  const stamped: BrowserSurfaceError = {
    ...entry,
    unrelated:
      entry.unrelated ??
      (entry.tabId != null && scope.activeTabId != null && entry.tabId !== scope.activeTabId),
  };
  scope.surfaceErrors.push(stamped);
  if (scope.surfaceErrors.length > BROWSER_ERROR_BUFFER_MAX) {
    scope.surfaceErrors = scope.surfaceErrors.slice(-BROWSER_ERROR_BUFFER_MAX);
  }
  if (!scope.window.isDestroyed()) {
    safeSend(scope.window.webContents, "browser:error", stamped);
  }
}

function nowTs(): number {
  return Date.now();
}


// ── Paintable capture (browser_inspect screenshots) ─────────────────────────
// capturePage() returns an EMPTY image for a WebContentsView that isn't attached
// to the window (no compositor surface). A screenshot must still work when the
// user has the Browser panel closed or is on another tab — so if the view isn't currently attached, temporarily attach
// it OFF-SCREEN, let it paint, capture, then detach. Best-effort; never throws.
/**
 * A hidden window used purely as a paint surface for tabs that aren't currently
 * on screen (background tabs, or any tab while the user has the Browser panel
 * closed). Created lazily and reused.
 *
 * This replaces parking the view at `{x:-20000}` inside the main window, which
 * NEVER worked: measured on Electron 38.2.2, a WebContentsView whose rect does
 * not intersect its window gets a 0x0 viewport and produces an EMPTY capture —
 * at any offset, ordering or settle time. That path only appeared to work
 * because a previously-visible tab still holds its last painted frame.
 */
let paintHost: BrowserWindow | null = null;

/** How long the borrowed host needs to paint a CURRENT frame (measured). */
const PAINT_SETTLE_MS = 250;

function getPaintHost(): BrowserWindow | null {
  if (paintHost && !paintHost.isDestroyed()) return paintHost;
  try {
    paintHost = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      // Never focusable/visible — it exists only to give detached views a
      // compositor surface.
      skipTaskbar: true,
    });
    return paintHost;
  } catch (e) {
    logger.warn(`[browser] could not create paint host: ${String(e)}`);
    return null;
  }
}

export function destroyPaintHost(): void {
  try {
    if (paintHost && !paintHost.isDestroyed()) paintHost.destroy();
  } catch {
    /* shutdown best-effort */
  }
  paintHost = null;
}

export async function capturePaintable(
  scope: BrowserScope,
  view: WebContentsView,
): Promise<import("electron").NativeImage | null> {
  if (scope.window.isDestroyed() || view.webContents.isDestroyed()) return null;
  if (scope.window.contentView.children.includes(view)) {
    try {
      return await view.webContents.capturePage();
    } catch {
      return null;
    }
  }
  // Not on screen: borrow the hidden host so the compositor produces a CURRENT
  // frame. Keep the size identical to the panel's so the page doesn't reflow
  // (and then reflow back) just because we took a picture.
  const host = getPaintHost();
  if (host) {
    const size = scope.lastBounds ?? { x: 0, y: 0, width: 1024, height: 768 };
    try {
      host.contentView.addChildView(view);
      view.setBounds({ x: 0, y: 0, width: size.width, height: size.height });
      // The hidden host DOES composite, but it needs long enough to produce a
      // fresh frame — measured: at 80ms `capturePage` still returns the frame
      // retained from when the tab was last on screen, which would put stale
      // pictures in the session recording. ~250ms yields a current one.
      await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
      const image = await view.webContents.capturePage();
      if (!image.isEmpty()) return image;
    } catch {
      /* fall through to the retained-frame attempt */
    } finally {
      try {
        host.contentView.removeChildView(view);
        if (scope.visible && scope.activeTabId != null) {
          setActiveTab(scope, scope.activeTabId);
        }
      } catch {
        /* ignore */
      }
    }
  }
  // Last resort: a tab that has been on screen before still holds its last
  // painted frame, which beats no frame at all in the session recording.
  try {
    const retained = await view.webContents.capturePage();
    return retained.isEmpty() ? null : retained;
  } catch {
    return null;
  }
}
