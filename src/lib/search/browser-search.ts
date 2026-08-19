/**
 * Web search through Atlarix's own Chromium.
 *
 * WHY THIS TIER EXISTS
 * --------------------
 * Measured 2026-08-19, the client search chain returned NOTHING for ordinary
 * developer queries: DuckDuckGo's Instant Answer API gave 0 results (it is an
 * instant-ANSWER API, not a web search), four of five public SearxNG instances
 * answered HTTP 429, and `searx.be` served a "Verifying your browser…" challenge
 * that parsed to zero. So any Core user without a self-hosted SearxNG had a
 * `web_search` that silently found nothing.
 *
 * Every one of those failures is the same question — "is this a real browser?" —
 * and Atlarix ships a real one. This tier asks the engine the way a person would:
 * a genuine Chromium, with a persistent profile, loading the results page.
 *
 * WHAT IT IS NOT
 * --------------
 * This is not the agent driving the browser. The model never sees this window,
 * cannot address it, and it never becomes a user-visible tab. It is a search
 * BACKEND that happens to be implemented with a browser.
 *
 * FAILURE IS A TIER, NOT AN ERROR
 * -------------------------------
 * Nothing here may throw into a turn. A challenge page, a timeout, a missing
 * Electron, zero parseable results — all return `[]`, and `smartSearch` falls
 * through to SearxNG and then DDG exactly as before.
 */

import log from "electron-log";
import * as electron from "electron";
import { SEARCH_RESULTS_SCRIPT } from "@/lib/browser/search-results";

const logger = log.scope("browser-search");

/** Isolated from both the app session and the user's own browser tabs. */
const SEARCH_PARTITION = "persist:atlarix-search";
/** A results page that has not loaded by now is not going to be useful. */
const NAV_TIMEOUT_MS = 12_000;
/** Extraction runs against a rendered DOM; it should be near-instant. */
const EXTRACT_TIMEOUT_MS = 5_000;
/** Tear the window down after a quiet spell rather than holding a renderer open. */
const IDLE_DESTROY_MS = 60_000;

export interface BrowserSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Engines live in ONE table so adding another is data, not code.
 *
 * Brave is the default deliberately. It answered a plain `curl` with a full
 * results page where DuckDuckGo returned an anomaly page (HTTP 202) on both its
 * `html.` and `lite.` endpoints; it runs an independent index rather than
 * reselling another engine's; and it publishes an official Search API, which
 * means that if reading the page ever stops working there is a sanctioned path to
 * the SAME results rather than a rewrite. Google is reachable but its terms
 * prohibit automated queries, so it is never the default.
 */
export const SEARCH_ENGINES = {
  brave: (q: string) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
  duckduckgo: (q: string) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  google: (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
} as const;

export type SearchEngineId = keyof typeof SEARCH_ENGINES;
export const DEFAULT_SEARCH_ENGINE: SearchEngineId = "brave";

/**
 * Whether a browser-backed search is possible in this process.
 *
 * The headless build aliases `electron` to a stub whose `BrowserWindow` is a plain
 * OBJECT with `getAllWindows`/`getFocusedWindow` — not a constructor — so `new`
 * would throw. That stub's own comment records this exact class of failure
 * reaching a model as "This model failed (…)", which is precisely what must not
 * happen to a search tier.
 */
export function isBrowserSearchAvailable(): boolean {
  const BW = (electron as { BrowserWindow?: unknown }).BrowserWindow;
  return typeof BW === "function" && typeof electron.app?.isReady === "function";
}

type Win = Electron.BrowserWindow;

let sharedWindow: Win | null = null;
let idleTimer: NodeJS.Timeout | null = null;
/** Requests run one at a time through the single window. */
let queue: Promise<unknown> = Promise.resolve();

function scheduleIdleDestroy(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    destroyWindow();
  }, IDLE_DESTROY_MS);
  idleTimer.unref?.();
}

/**
 * A hidden window is still an OPEN window.
 *
 * `window-all-closed` — which quits the app on Windows and Linux — fires only when
 * every window has closed, and this one is invisible. Left alone, closing the last
 * real window would leave the app running until the idle timer happened to reap
 * this one: an app that does not quit when you close it.
 *
 * So the search window follows the app: the moment no other window remains, it
 * goes, and `window-all-closed` fires normally.
 */
function destroyIfLastWindow(): void {
  // `closed` has already removed the window in current Electron, but a deferred
  // check costs nothing and does not depend on that ordering staying true.
  setImmediate(() => {
    try {
      const others = electron.BrowserWindow.getAllWindows().filter(
        (w) => w !== sharedWindow && !w.isDestroyed(),
      );
      if (others.length === 0) destroyWindow();
    } catch {
      /* teardown must never throw */
    }
  });
}

let lastWindowWatchInstalled = false;

/** Watch every other window — those open now, and those opened later. */
function installLastWindowWatch(): void {
  if (lastWindowWatchInstalled) return;
  lastWindowWatchInstalled = true;
  try {
    const { BrowserWindow, app } = electron;
    const watch = (w: Win) => {
      if (w !== sharedWindow) w.once("closed", destroyIfLastWindow);
    };
    // Windows that already exist: the main window is created long before the
    // first search, so `browser-window-created` alone would never see it.
    for (const w of BrowserWindow.getAllWindows()) watch(w);
    app.on("browser-window-created", (_e, w) => watch(w));
  } catch {
    /* a watch we could not install is not a reason to fail a search */
  }
}

function destroyWindow(): void {
  const w = sharedWindow;
  sharedWindow = null;
  try {
    if (w && !w.isDestroyed()) w.destroy();
  } catch {
    /* teardown must never throw */
  }
}

function getWindow(): Win {
  if (sharedWindow && !sharedWindow.isDestroyed()) return sharedWindow;
  const { BrowserWindow, session } = electron;

  // Same hardening posture as the user-facing browser tabs (browser_view_manager):
  // isolated partition, sandboxed, no preload, no node, downloads and permissions
  // denied. This window renders a hostile third-party page and does nothing else.
  const ses = session.fromPartition(SEARCH_PARTITION, { cache: true });
  const hardened = ses as Electron.Session & { __atlarixSearchHardened?: boolean };
  if (!hardened.__atlarixSearchHardened) {
    hardened.__atlarixSearchHardened = true;
    ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    ses.on("will-download", (e) => e.preventDefault());
  }

  sharedWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      partition: SEARCH_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // A hidden window is throttled by default, which would stall the very
      // timers and layout the results page needs to finish rendering.
      backgroundThrottling: false,
      // Layout must happen even though nothing is on screen — `innerText`, which
      // the extractor prefers, is layout-dependent.
      offscreen: false,
    },
  });
  // http(s) only, and never a popup: the same scheme allowlist the browser tabs use.
  sharedWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  sharedWindow.webContents.on("will-navigate", (event, url) => {
    if (!/^https?:$/.test(new URL(url).protocol)) event.preventDefault();
  });
  installLastWindowWatch();
  return sharedWindow;
}

/** Load `url` and resolve once the DOM is ready, or reject on timeout. */
async function loadPage(win: Win, url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      // Stop the in-flight load so the next query starts from a quiet renderer.
      try {
        win.webContents.stop();
      } catch {
        /* ignore */
      }
      reject(new Error(`navigation timed out after ${NAV_TIMEOUT_MS}ms`));
    }, NAV_TIMEOUT_MS);
    timer.unref?.();

    const onDone = () => {
      cleanup();
      resolve();
    };
    const onFail = (_e: unknown, _code: number, desc: string) => {
      cleanup();
      reject(new Error(desc || "navigation failed"));
    };
    function cleanup() {
      clearTimeout(timer);
      win.webContents.off("did-finish-load", onDone);
      win.webContents.off("did-fail-load", onFail as never);
    }

    win.webContents.once("did-finish-load", onDone);
    win.webContents.once("did-fail-load", onFail as never);
    void win.loadURL(url).catch(onFail as never);
  });
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return await Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer!)) as T;
}

/**
 * Run one query through the hidden window. Returns `[]` for every failure mode —
 * unavailable, blocked, timed out, or simply nothing parseable — so the caller can
 * fall through without a try/catch.
 */
export async function browserSearch(
  query: string,
  opts: { engine?: SearchEngineId; limit?: number } = {},
): Promise<BrowserSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  if (!isBrowserSearchAvailable()) return [];

  const engine = opts.engine ?? DEFAULT_SEARCH_ENGINE;
  const url = (SEARCH_ENGINES[engine] ?? SEARCH_ENGINES[DEFAULT_SEARCH_ENGINE])(q);

  // Serialize: one window, one page at a time. Chaining onto the queue rather
  // than locking keeps ordering without a mutex, and a failed request must not
  // poison the chain for the next one.
  const run = queue.then(async () => {
    try {
      if (!electron.app.isReady()) await electron.app.whenReady();
      const win = getWindow();
      await loadPage(win, url);
      const raw = (await withTimeout(
        win.webContents.executeJavaScript(SEARCH_RESULTS_SCRIPT, true),
        EXTRACT_TIMEOUT_MS,
        "extraction",
      )) as BrowserSearchResult[] | null;

      const results = Array.isArray(raw) ? raw : [];
      if (results.length === 0) {
        // A challenge page, an empty page, or markup we no longer recognise —
        // all indistinguishable from here, and all mean "let the next tier try".
        logger.info(`[browser-search] ${engine}: no results for "${q}" — falling through`);
      } else {
        logger.info(`[browser-search] ${engine}: ${results.length} result(s) for "${q}"`);
      }
      return opts.limit ? results.slice(0, opts.limit) : results;
    } catch (e) {
      logger.warn(`[browser-search] ${engine} failed for "${q}": ${e}`);
      return [];
    } finally {
      scheduleIdleDestroy();
    }
  });

  // Keep the chain alive regardless of this request's outcome.
  queue = run.catch(() => undefined);
  return run;
}

/** Release the hidden window (app shutdown, or tests). */
export function shutdownBrowserSearch(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  destroyWindow();
}
