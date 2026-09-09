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

import {
  WebContentsView,
  BrowserWindow,
  dialog,
  session,
  type Session,
} from "electron";

import log from "electron-log";
import { safeSend } from "./safe_sender";
import { CLS_OBSERVER_SCRIPT } from "@/lib/browser/visual-lint";
import {
  ERROR_HOOK_SCRIPT,
  tryParseErrorSentinel,
  type BrowserConsoleLevel,
  type BrowserSurfaceError,
} from "@/lib/browser/error-hook";
import {
  attachNetworkCapture,
  detachNetworkCapture,
  isTabDegraded,
  recordFallbackComplete,
  recordFallbackError,
  recordFallbackStart,
  recordInjectedBody,
  setDegradeListener,
} from "./browser_network_capture";
import {
  NETWORK_HOOK_SCRIPT,
  tryParseNetworkSentinel,
} from "@/lib/browser/network-hook";
import { WEBAUTHN_NOTICE_SCRIPT } from "@/lib/browser/webauthn-notice";
import {
  beginNavigationEpoch,
  clearNavigationEpoch,
  currentNavigationEpoch,
} from "@/lib/browser/navigation-epoch";

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

export type {
  BrowserConsoleLevel,
  BrowserSurfaceError,
} from "@/lib/browser/error-hook";
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
 * the browser tool already promises the model) and `paintHost` (a compositor
 * surface, not state).
 */
export type BrowserScope = {
  /** The window this panel belongs to. */
  window: BrowserWindow;
  tabs: Map<number, WebContentsView>;
  activeTabId: number | null;
  visible: boolean;
  lastBounds: Rect | null;
  /**
   * Console-side entries: every console level, plus load/crash events.
   * Separate from `networkEntries` because a chatty page logging at `info`/`log`
   * would otherwise evict recorded request failures within seconds — they shared
   * one 50-entry buffer before the Console tab.
   */
  consoleEntries: BrowserSurfaceError[];
  /** Request failures (4xx/5xx), kept on their own budget. */
  networkEntries: BrowserSurfaceError[];
  /** Pending coalesced `browser:console` payload; flushed on a short timer. */
  consoleFlushQueue: BrowserSurfaceError[];
  consoleFlushTimer: NodeJS.Timeout | null;
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
  if (existing && existing.window === win && !win.isDestroyed())
    return existing;
  const scope: BrowserScope = {
    window: win,
    tabs: new Map(),
    activeTabId: null,
    visible: false,
    lastBounds: null,
    consoleEntries: [],
    networkEntries: [],
    consoleFlushQueue: [],
    consoleFlushTimer: null,
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
export function resolveBrowserScope(
  windowId?: number | null,
): BrowserScope | null {
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
  return {
    x: Math.max(0, width - w),
    y: 0,
    width: w,
    height: Math.max(360, height),
  };
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
  if (
    !/\s/.test(trimmed) &&
    /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(trimmed)
  ) {
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
      logger.log(
        `[browser] permission "${permission}" denied (default policy)`,
      );
      callback(false);
    });
    ses.on("will-download", (event, item) => {
      logger.warn(`[browser] download blocked: ${item.getURL()}`);
      event.preventDefault();
    });
    // Passkeys: the site offered more than one discoverable credential and macOS
    // is asking which to use. NOT reachable through the permission handler above —
    // WebAuthn is not an Electron permission type, which is why a passkey request
    // used to hang with nothing to deny or allow.
    //
    // One credential is answered directly; more than one asks the USER, because
    // signing in as the wrong account is not recoverable the way cancelling is.
    // This previously declined outright — a dead end, and now a worse one: the
    // event also fires for ROAMING authenticators on Windows and Linux, so a
    // security key holding two credentials could never be used.
    //
    // THE CONTRACT: Electron holds the credential request open until `callback`
    // runs, and it must run EXACTLY ONCE. A missed call is an indefinite hang —
    // the same failure class as the approval card that hung a turn for ten
    // minutes — so it is invoked from `finally`, and a dialog that throws
    // declines rather than leaving the page waiting forever.
    ses.on("select-webauthn-account", async (_event, details, callback) => {
      const accounts = details.accounts ?? [];
      let chosen: string | null = null;
      try {
        if (accounts.length === 1) {
          chosen = accounts[0]!.credentialId;
        } else if (accounts.length > 1) {
          const labels = accounts.map(
            (a, i) => a.displayName || a.name || `Account ${i + 1}`,
          );
          const { response } = await dialog.showMessageBox({
            type: "question",
            title: "Choose an account",
            message: `Sign in to ${details.relyingPartyId}`,
            detail: "This site has more than one passkey saved here.",
            buttons: [...labels, "Cancel"],
            cancelId: labels.length,
            defaultId: 0,
            noLink: true,
          });
          chosen =
            response < labels.length ? accounts[response]!.credentialId : null;
        }
      } catch (e) {
        logger.warn(`[browser] passkey chooser failed, declining: ${e}`);
        chosen = null;
      } finally {
        callback(chosen);
      }
    });
    // ── webRequest: two jobs, deliberately kept apart ──────────────────────
    //
    // 1. FAILURES (every tab, always) → the per-window `network-failed` feed
    //    that `browser_test` and the runtime notice read. Static-asset noise is
    //    excluded so a missing favicon never reads as a broken app.
    // 2. FULL INVENTORY (degraded tabs only) → the fallback tier of the Network
    //    tab. When CDP is live it already has every request with better data, so
    //    recording here too would double every row.
    //
    // `onBeforeRequest` is the only BLOCKING hook of the three — every request in
    // every browser tab would wait on a main-process round trip. That is too much
    // to charge ordinary browsing for a path most sessions never take, so it is
    // installed lazily, the first time any tab actually degrades.
    setDegradeListener(() => installBlockingFallbackHook(ses));
    ses.webRequest.onCompleted((details) => {
      try {
        const tabId = tabIdForWebContentsId(details.webContentsId);
        if (tabId != null && isTabDegraded(tabId)) {
          recordFallbackComplete(tabId, {
            id: String(details.id),
            url: details.url,
            method: details.method ?? "GET",
            status: details.statusCode,
            statusText: details.statusLine,
            responseHeaders: details.responseHeaders,
            fromCache: details.fromCache,
            resourceType: details.resourceType,
          });
        }
        const status = details.statusCode ?? 0;
        if (status < 400) return;
        // The session is shared by every window, so find which scope this tab
        // belongs to — the failure is that window's, and only that window's.
        const owner = scopeForWebContentsId(details.webContentsId);
        if (!owner) return;
        // Keep document/script/data requests; drop static-asset noise so a
        // missing favicon/image/font isn't reported as an app failure. (Electron
        // resourceType literals vary by version, so we EXCLUDE the noisy set
        // rather than match an allowlist of names that may not exist.)
        if (NOISY_PREVIEW_RESOURCE_TYPES.has(details.resourceType)) return;
        pushBrowserSurfaceError(owner, {
          type: "network-failed",
          message: `HTTP ${status} ${details.method ?? "GET"} ${details.url}`,
          url: details.url,
          statusCode: status,
          timestamp: nowTs(),
          tabId: tabId ?? undefined,
        });
      } catch {
        /* request logging must never throw */
      }
    });
    // Transport-level failures (DNS, refused, aborted) never reach onCompleted,
    // so without this the fallback tier would leave them pending forever.
    ses.webRequest.onErrorOccurred((details) => {
      try {
        const tabId = tabIdForWebContentsId(details.webContentsId);
        if (tabId == null || !isTabDegraded(tabId)) return;
        recordFallbackError(tabId, {
          id: String(details.id),
          url: details.url,
          method: details.method ?? "GET",
          errorText: details.error,
        });
      } catch {
        /* request logging must never throw */
      }
    });
  }
  return ses;
}

/** Guards the lazy install below — the hook must be registered exactly once. */
let blockingFallbackHookInstalled = false;

/**
 * Install the blocking `onBeforeRequest` hook, which the fallback tier needs for
 * two things `onCompleted` cannot give it: when a request STARTED (so a duration
 * is a measurement rather than a zero) and its upload body.
 *
 * Called only once a tab has degraded. It stays installed for the rest of the
 * session — removing it again would race in-flight requests for no real gain,
 * since a session that degraded once is likely to again.
 */
function installBlockingFallbackHook(ses: Session): void {
  if (blockingFallbackHookInstalled) return;
  blockingFallbackHookInstalled = true;
  logger.info(
    "[browser] a tab degraded off CDP — installing webRequest fallback",
  );
  ses.webRequest.onBeforeRequest((details, callback) => {
    // A listener that never calls back stalls the request forever, so the
    // callback is outside everything that could throw.
    try {
      const tabId = tabIdForWebContentsId(details.webContentsId);
      if (tabId != null && isTabDegraded(tabId)) {
        recordFallbackStart(tabId, {
          id: String(details.id),
          url: details.url,
          method: details.method ?? "GET",
          resourceType: details.resourceType,
          requestBody: uploadDataToText(details.uploadData),
        });
      }
    } catch {
      /* request logging must never throw */
    }
    callback({});
  });
}

/**
 * `uploadData` is a list of raw chunks. Decode the inline ones; a file or blob
 * chunk has no `bytes`, and saying so beats rendering an empty body as if the
 * request had sent nothing.
 */
export function uploadDataToText(
  chunks: Electron.UploadData[] | undefined,
): string | undefined {
  if (!chunks || chunks.length === 0) return undefined;
  const parts: string[] = [];
  for (const chunk of chunks) {
    if (chunk.bytes && chunk.bytes.length > 0) {
      parts.push(chunk.bytes.toString("utf8"));
    } else if (chunk.file) {
      parts.push(`[file: ${chunk.file}]`);
    } else {
      parts.push("[binary upload]");
    }
  }
  const joined = parts.join("");
  if (!joined) return undefined;
  return joined.length > UPLOAD_BODY_MAX
    ? `${joined.slice(0, UPLOAD_BODY_MAX)}…[truncated]`
    : joined;
}

/** Request bodies are captured for inspection, not archival. */
const UPLOAD_BODY_MAX = 4000;

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

/**
 * Bodies come from CDP when it is live, so the page-side wrapper is installed
 * ONLY on a degraded tab. Injecting it always would wrap `fetch` in every page
 * the user browses to buy nothing.
 */
function injectNetworkHookIfDegraded(
  id: number,
  wc: Electron.WebContents,
): void {
  if (!isTabDegraded(id)) return;
  void wc.executeJavaScript(NETWORK_HOOK_SCRIPT, true).catch(() => {});
}

/**
 * Report passkey attempts that resolve to a PLATFORM authenticator, and say what
 * does work instead.
 *
 * Unconditional now, on every platform. It used to be gated on whether
 * `configureWebAuthn` had taken, which was only ever true on macOS; that
 * authenticator has been removed, because the `keychain-access-groups` entitlement
 * it needs is provisioned and the kernel SIGKILLed the signed build without a
 * profile. So the gate had exactly one outcome and the condition was noise.
 *
 * A platform authenticator is therefore unavailable everywhere — but a ROAMING one
 * is not, which is why the script itself stays silent for a request that explicitly
 * asks for `cross-platform`, and why the message names the phone and the security
 * key rather than telling the user to give up.
 */
function injectWebAuthnNotice(wc: Electron.WebContents): void {
  void wc.executeJavaScript(WEBAUTHN_NOTICE_SCRIPT, true).catch(() => {});
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
    // (see normalizeConsoleLevel below for the level mapping)
    let level: string | number | undefined;
    let message = "";
    let sourceUrl: string | undefined;
    if (typeof a[1] === "number") {
      level = a[1] as number;
      message = String(a[2] ?? "");
      sourceUrl = typeof a[4] === "string" ? (a[4] as string) : undefined;
    } else {
      const ev = (a[0] ?? {}) as {
        level?: string;
        message?: string;
        sourceId?: string;
      };
      level = ev.level;
      message = String(ev.message ?? "");
      sourceUrl = ev.sourceId;
    }
    // Injected network sentinel: a response body read inside the page, riding
    // the console because browser tabs have no preload. It is DATA, not output —
    // record it against the network log and return, so it never reaches the
    // console feed the user reads.
    const capturedBody = tryParseNetworkSentinel(message);
    if (capturedBody) {
      recordInjectedBody(id, capturedBody);
      return;
    }
    // Injected-hook sentinel: a structured error (with stack) from the page's
    // window.onerror / unhandledrejection / fetch wrap. Parse it and RETURN so
    // it isn't ALSO recorded as a plain console-error (no double-capture).
    const rich = tryParseErrorSentinel(message);
    if (rich) {
      pushBrowserSurfaceError(scope, {
        ...rich,
        url: rich.url ?? sourceUrl,
        timestamp: nowTs(),
        tabId: id,
      });
      return;
    }
    if (!message) return;
    pushBrowserSurfaceError(scope, {
      type: "console-error",
      message: message.slice(0, 4000),
      url: sourceUrl,
      timestamp: nowTs(),
      level: normalizeConsoleLevel(level),
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
    injectWebAuthnNotice(wc);
    injectNetworkHookIfDegraded(id, wc);
  });
  // `dom-ready` is the earliest injection point available without a preload,
  // which browser tabs deliberately do not get. Still after the page's own head
  // scripts, so the fallback tier misses early requests — CDP does not, because
  // it injects at document-start. Injecting at both events is idempotent (the
  // script guards on a window flag) and only widens the window slightly.
  wc.on("dom-ready", () => {
    // Earliest reachable point without a preload, which matters more here than
    // for the network hook: the shim must be in place BEFORE the page's own
    // script calls navigator.credentials, or the attempt goes unreported. Also
    // injected on did-finish-load so a slow/failed dom-ready still gets it; the
    // script guards on a window flag, so twice is free.
    injectWebAuthnNotice(wc);
    injectNetworkHookIfDegraded(id, wc);
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
  // A navigation SEPARATOR, not a clear.
  //
  // DevTools clears the console on navigate by default. We deliberately do not:
  // the agent may be comparing behaviour across two loads, and throwing the
  // earlier one away to save it from confusion costs more than it saves. A marker
  // row answers "is this stale?" without destroying anything.
  //
  // `did-navigate` only — `did-navigate-in-page` fires on every SPA route change
  // and would turn the feed into separators.
  wc.on("did-navigate", (_e, url) => {
    // Bump BEFORE pushing so the marker is the first entry of the NEW page
    // rather than the last of the old one — it reads as the header of the card
    // it introduces, which is where a person looks for it.
    const epoch = beginNavigationEpoch(id, url);
    pushBrowserSurfaceError(scope, {
      type: "navigated",
      message: `Navigated to ${url}`,
      url,
      timestamp: nowTs(),
      tabId: id,
      navSeq: epoch.seq,
      pageUrl: epoch.pageUrl,
    });
  });
  wc.on("destroyed", () => {});
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

/**
 * Our tab id for a webContents id — the network log is keyed by tab, and
 * session-level webRequest details only carry the webContents.
 */
function tabIdForWebContentsId(id: number | undefined): number | null {
  if (id == null) return null;
  for (const scope of allScopes()) {
    for (const [tabId, v] of scope.tabs) {
      if (!v.webContents.isDestroyed() && v.webContents.id === id) return tabId;
    }
  }
  return null;
}

export function createTab(
  scope: BrowserScope,
  url?: string,
): BrowserPanelState {
  const view = new WebContentsView({
    webPreferences: {
      session: browserSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // A tab the agent is driving with the panel closed is a hidden page, and
      // Chromium throttles hidden pages hard — timers clamped, rAF paused. An
      // SPA that finishes hydrating in a rAF callback would then never finish,
      // and the tool would read a half-built DOM and call it the page. This is
      // an agent surface, not a background tab we are being polite about.
      backgroundThrottling: false,
    },
  });
  const id = nextTabId++;
  scope.tabs.set(id, view);
  (
    view.webContents as Electron.WebContents & { __atlarixTabId?: number }
  ).__atlarixTabId = id;
  wireTabEvents(scope, id, view);

  setActiveTab(scope, id);
  const target =
    url && isAllowedBrowserUrl(url) ? url : "https://www.google.com";

  // Network capture, best-effort and never blocking the load.
  //
  // Ordering matters and was measured: `Network.enable` HANGS FOREVER on a tab
  // that has never navigated — attach resolves, the command never does, with no
  // error at all. So prime with about:blank, attach, then navigate. Requests
  // from `target` onward are captured; nothing is lost, because about:blank
  // issues none.
  void view.webContents
    .loadURL("about:blank")
    .catch(() => {})
    .then(() => attachNetworkCapture(id, view.webContents))
    .catch(() => false)
    .then(() => view.webContents.loadURL(target))
    .catch((e) => {
      logger.warn(`[browser] tab ${id} initial load failed: ${String(e)}`);
    });

  broadcastState(scope);
  return getBrowserPanelState(scope);
}

export function closeTab(scope: BrowserScope, id: number): BrowserPanelState {
  const view = scope.tabs.get(id);
  if (view) {
    // Detach BEFORE close: a debugger still attached to a destroyed webContents
    // is exactly the shape of the native crash we already have open in Sentry.
    detachNetworkCapture(id, view.webContents);
    if (!scope.window.isDestroyed())
      scope.window.contentView.removeChildView(view);
    view.webContents.close();
    scope.tabs.delete(id);
    // Tab ids never repeat, so a retained epoch would leak for the app's life.
    // Already-recorded entries carry their own stamp, so the cards survive.
    clearNavigationEpoch(id);
  }
  if (scope.activeTabId === id) {
    scope.activeTabId =
      scope.tabs.size > 0 ? [...scope.tabs.keys()].pop()! : null;
    if (scope.activeTabId != null) setActiveTab(scope, scope.activeTabId);
  }
  broadcastState(scope);
  return getBrowserPanelState(scope);
}

/**
 * Attach the active tab and give it a size, whether or not the panel is open.
 *
 * THE BUG THIS FIXES, and it is worth stating because the guard against it was
 * already written and simply never ran. `fallbackBounds` exists (see its
 * docblock) because "a view whose rect doesn't intersect the window gets a 0x0
 * layout viewport, so the document lays out at zero width and every geometry
 * answer is plausible but wrong". But bounds were only ever applied while
 * ATTACHING, and attaching only happened when `scope.visible` — so with the
 * right panel closed the view was never attached at all, which is the same
 * failure one step worse. The agent's browser tools reported an empty or
 * unusable page against a local dev server until the user opened the panel by
 * hand, and `requestBrowserPanel`'s claim that "the browser tools work fine with
 * the panel shut" was simply false.
 *
 * So: always attached, always sized, and `View.setVisible` decides whether it is
 * DRAWN. That separation is the whole point — a laid-out page the compositor
 * skips is what an agent needs, while a drawn one with no chrome around it is
 * the bare browser slab over half the app that made this conditional in the
 * first place.
 */
function attachActive(scope: BrowserScope, view: WebContentsView): void {
  scope.window.contentView.addChildView(view);
  view.setBounds(boundsFor(scope));
  view.setVisible(scope.visible);
}

export function setActiveTab(scope: BrowserScope, id: number): void {
  const view = scope.tabs.get(id);
  if (!view || scope.window.isDestroyed()) return;
  // Detach all, then attach the active one (single surface).
  for (const [, v] of scope.tabs) {
    scope.window.contentView.removeChildView(v);
  }
  scope.activeTabId = id;
  attachActive(scope, view);
  broadcastState(scope);
}

export function navigate(
  scope: BrowserScope,
  id: number | null,
  url: string,
): boolean {
  const view =
    id == null ? getActiveTabView(scope) : (scope.tabs.get(id) ?? null);
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
  // No `scope.visible` guard any more: the view is always attached, so a fresh
  // rect is always worth applying. It only ever arrives from a mounted panel
  // anyway, and gating it here meant the LAST reported rect was discarded on the
  // way to a closed panel and had to be re-derived on reopen.
  const view = getActiveTabView(scope);
  if (view) view.setBounds(rect);
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
 * Why not just `setVisible(true)`: that DRAWS the `WebContentsView` over the
 * window with no tab strip and no URL bar, because the React chrome isn't
 * mounted. With the right panel closed that renders as a bare browser slab
 * covering half the app — which is what a user actually sees, and it looks
 * broken. `setVisible` stays the RENDERER's call (panel mount/unmount); agent
 * code asks for the panel and lets the UI drive visibility.
 *
 * The tools genuinely do work with the panel shut — but only since the view
 * started being ATTACHED regardless of visibility (see `attachActive`). Before
 * that this docblock made the claim and the code did not support it: an
 * unattached view has no layout viewport, so the page laid out at zero width and
 * every answer about it was plausible and wrong. Opening the panel by hand was
 * the only fix, which is exactly how the bug was reported.
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
  // Hiding the panel no longer DETACHES the view — it stops drawing it. A
  // detached view has no layout viewport, and the agent's browser tools go on
  // working while the panel is shut; they were the casualty of the old
  // remove-on-hide. See `attachActive`.
  attachActive(scope, view);
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

/**
 * Console holds more than the old shared 50 because ordinary `log`/`info` output
 * is now captured; network keeps its own budget so a noisy page can't push a
 * recorded 500 out of the buffer.
 */
const BROWSER_CONSOLE_BUFFER_MAX = 500;
const BROWSER_NETWORK_BUFFER_MAX = 200;

/**
 * Per-tab console cap, enforced INSIDE the window-wide buffer above.
 *
 * The window cap alone lets one chatty tab evict every other tab's history —
 * the same bug console and network had while they shared a 50-entry buffer. The
 * window cap stays as a memory ceiling for the many-tabs case; this one keeps
 * any single tab from spending the whole budget.
 */
const BROWSER_CONSOLE_PER_TAB_MAX = 200;

/** Coalescing window for the `browser:console` batch channel. */
const CONSOLE_FLUSH_MS = 100;

/**
 * Everything captured, console and network together — the shape every existing
 * caller expects (`preview-verify`'s completion gate, `browser_test`). The split
 * below is a storage detail; this stays the union so those paths are unchanged.
 */
export function getBrowserSurfaceErrors(
  scope: BrowserScope,
): BrowserSurfaceError[] {
  return [...scope.consoleEntries, ...scope.networkEntries].sort(
    (a, b) => a.timestamp - b.timestamp,
  );
}

/** Console-side entries only (every level), for `browser_inspect(mode:"console")`. */
export function getBrowserConsoleEntries(
  scope: BrowserScope,
): BrowserSurfaceError[] {
  return [...scope.consoleEntries];
}

/** Just the captured failed (4xx/5xx) network responses. */
export function getBrowserSurfaceNetworkFailures(
  scope: BrowserScope,
): BrowserSurfaceError[] {
  return [...scope.networkEntries];
}

export function clearBrowserSurfaceErrors(scope: BrowserScope): void {
  scope.consoleEntries = [];
  scope.networkEntries = [];
  scope.consoleFlushQueue = [];
  if (scope.consoleFlushTimer) {
    clearTimeout(scope.consoleFlushTimer);
    scope.consoleFlushTimer = null;
  }
}

/** Send whatever is queued on the batch channel and reset the timer. */
function flushConsoleQueue(scope: BrowserScope): void {
  if (scope.consoleFlushTimer) {
    clearTimeout(scope.consoleFlushTimer);
    scope.consoleFlushTimer = null;
  }
  if (scope.consoleFlushQueue.length === 0) return;
  const batch = scope.consoleFlushQueue;
  scope.consoleFlushQueue = [];
  if (!scope.window.isDestroyed()) {
    safeSend(scope.window.webContents, "browser:console", batch);
  }
}

/**
 * The single record path for everything captured from a browser tab: console at
 * any level, load failures, renderer crashes, failed requests. Routes to the
 * console or network buffer, evicts per that buffer's own cap, and fans out to
 * both IPC channels.
 */
export function pushBrowserSurfaceError(
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
  // Stamp the page load at RECORD time too. Which page was loaded when an entry
  // arrived cannot be recovered later, and it is what lets a card be labelled
  // with the url that actually produced its contents rather than the tab's
  // latest one.
  const epoch =
    entry.tabId != null ? currentNavigationEpoch(entry.tabId) : null;
  const stamped: BrowserSurfaceError = {
    ...entry,
    navSeq: entry.navSeq ?? epoch?.seq,
    pageUrl: entry.pageUrl ?? epoch?.pageUrl,
    unrelated:
      entry.unrelated ??
      (entry.tabId != null &&
        scope.activeTabId != null &&
        entry.tabId !== scope.activeTabId),
  };
  if (stamped.type === "network-failed") {
    scope.networkEntries.push(stamped);
    if (scope.networkEntries.length > BROWSER_NETWORK_BUFFER_MAX) {
      scope.networkEntries = scope.networkEntries.slice(
        -BROWSER_NETWORK_BUFFER_MAX,
      );
    }
  } else {
    scope.consoleEntries.push(stamped);
    scope.consoleEntries = evictConsoleEntries(
      scope.consoleEntries,
      stamped.tabId,
    );
  }
  if (scope.window.isDestroyed()) return;

  // `browser:error` is UNCHANGED: per-entry, error/warning only. Every existing
  // consumer keeps working exactly as before — widening capture must not change
  // what they receive.
  const isNoisyLevel =
    stamped.type === "console-error" &&
    stamped.level != null &&
    stamped.level !== "error" &&
    stamped.level !== "warning";
  // A navigation marker is not an error and must never reach the Errors list,
  // which would render it as a failure with a red badge.
  if (!isNoisyLevel && stamped.type !== "navigated") {
    safeSend(scope.window.webContents, "browser:error", stamped);
  }

  // `browser:console` carries EVERY level, coalesced. One IPC send per console
  // call would be hundreds a second on a chatty page — the shape of flood that
  // has already cost this app a thermal regression once. Errors flush
  // immediately so a genuine failure still feels instant.
  scope.consoleFlushQueue.push(stamped);
  if (stamped.level === "error" || stamped.type !== "console-error") {
    flushConsoleQueue(scope);
    return;
  }
  if (!scope.consoleFlushTimer) {
    scope.consoleFlushTimer = setTimeout(
      () => flushConsoleQueue(scope),
      CONSOLE_FLUSH_MS,
    );
    // Never hold the process open for a console flush.
    scope.consoleFlushTimer.unref?.();
  }
}

/**
 * Evict from the console buffer, per tab first.
 *
 * The buffer stays ONE chronologically-ordered list — the panel reads it as a
 * stream and the cards filter by tab — so eviction drops the offending tab's
 * oldest entries in place rather than keeping a list per tab. Only the tab that
 * just pushed can be over its own cap, so that is the only one scanned.
 *
 * Exported for the test that pins the isolation: a tab spewing thousands of
 * lines must not cost a quiet tab a single row.
 */
export function evictConsoleEntries(
  entries: BrowserSurfaceError[],
  tabId: number | undefined,
): BrowserSurfaceError[] {
  let out = entries;
  if (tabId != null) {
    let overBy =
      out.filter((e) => e.tabId === tabId).length - BROWSER_CONSOLE_PER_TAB_MAX;
    if (overBy > 0) {
      out = out.filter((e) => {
        if (overBy > 0 && e.tabId === tabId) {
          overBy--;
          return false;
        }
        return true;
      });
    }
  }
  // The window ceiling still applies: enough tabs, each under its own cap, would
  // otherwise add up without bound.
  return out.length > BROWSER_CONSOLE_BUFFER_MAX
    ? out.slice(-BROWSER_CONSOLE_BUFFER_MAX)
    : out;
}

function nowTs(): number {
  return Date.now();
}

/**
 * Normalize a `console-message` level to our own vocabulary.
 *
 * Electron emits two shapes: the current event object carries a STRING level,
 * and the legacy positional signature carries an INTEGER documented as
 * "0 to 3 … in order it matches verbose, info, warning and error".
 *
 * The previous code read the integers as `2 = error` and `3 = warning` — the
 * inverse of that documented order. It was harmless in practice because
 * Electron 38 always takes the string branch, but it meant the legacy path would
 * have marked every warning as blocking and let every real error through the
 * completion gate. Fixed here rather than carried forward.
 *
 * Anything unrecognized falls back to `log`, which is deliberately NON-blocking:
 * a wrong guess must not be able to trap a turn.
 */
export function normalizeConsoleLevel(
  level: string | number | undefined,
): BrowserConsoleLevel {
  if (typeof level === "number") {
    // EXACT matches only. An open-ended `>= 3` would map any out-of-range
    // integer to the one blocking level, which is the opposite of the fail-open
    // rule below — garbage must not be able to trap a turn.
    if (level === 3) return "error";
    if (level === 2) return "warning";
    if (level === 1) return "info";
    if (level === 0) return "debug"; // verbose
    return "log";
  }
  switch ((level ?? "").toLowerCase()) {
    case "error":
      return "error";
    case "warning":
    case "warn":
      return "warning";
    case "info":
      return "info";
    case "debug":
    case "verbose":
      return "debug";
    default:
      return "log";
  }
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
