/**
 * A hidden, reusable Chromium page — the shared engine behind browser-backed
 * search and browser-backed `read_url`.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE
 * ---------------------------------
 * `lib/search/browser-search.ts` grew this machinery first, and every property
 * below was learned by getting it wrong. `read_url` needs exactly the same
 * machinery, and a second copy would be a second place to relearn them.
 *
 * THE THREE PROPERTIES THAT ARE NOT OPTIONAL
 * ------------------------------------------
 * 1. **One reused window per partition.** Destroying a window and immediately
 *    recreating one on the same `persist:` partition made the NEXT load fail with
 *    `ERR_FAILED (-2)`. Reuse is load-bearing, not an optimisation.
 * 2. **A hidden window is still an OPEN window.** `window-all-closed` — which
 *    quits the app on Windows and Linux — fires only once EVERY window has
 *    closed. An invisible window left behind means the app does not quit when the
 *    user closes it, so these windows follow the app: the moment no other window
 *    remains, they go.
 * 3. **Failure is a fall-through, never a throw.** Every caller is on the path of
 *    a tool call. A challenge page, a timeout, a missing Electron and a page that
 *    simply had nothing on it are indistinguishable from here, and all of them
 *    return `null` so the caller can try something else.
 *
 * Partitions are per-caller on purpose: search keeps engine cookies in
 * `persist:atlarix-search`, `read_url` visits arbitrary pages in
 * `persist:atlarix-reader`, and neither can read the other's jar.
 */

import log from "electron-log";
import * as electron from "electron";

const logger = log.scope("headless-page");

/** A page that has not loaded by now is not going to be useful. */
export const DEFAULT_NAV_TIMEOUT_MS = 12_000;
/** Tear the window down after a quiet spell rather than holding a renderer open. */
export const DEFAULT_IDLE_DESTROY_MS = 60_000;
/**
 * Extraction runs against an already-rendered DOM, so it should be near-instant.
 * It is still bounded: `executeJavaScript` against a hostile page can hang, and an
 * unbounded hang here would stall every later request on the same partition —
 * they are serialized behind this one.
 */
export const DEFAULT_EXTRACT_TIMEOUT_MS = 5_000;

type Win = Electron.BrowserWindow;

export interface HiddenPageOptions {
  /** `persist:`-prefixed partition. One reused window per distinct value. */
  partition: string;
  navTimeoutMs?: number;
  idleDestroyMs?: number;
  extractTimeoutMs?: number;
}

interface PageSlot {
  window: Win | null;
  idleTimer: NodeJS.Timeout | null;
  /** Requests run one at a time through this partition's single window. */
  queue: Promise<unknown>;
}

const slots = new Map<string, PageSlot>();

function getSlot(partition: string): PageSlot {
  let slot = slots.get(partition);
  if (!slot) {
    slot = { window: null, idleTimer: null, queue: Promise.resolve() };
    slots.set(partition, slot);
  }
  return slot;
}

/**
 * Whether a hidden page is possible in this process.
 *
 * The headless build aliases `electron` to a stub whose `BrowserWindow` is a plain
 * OBJECT with `getAllWindows`/`getFocusedWindow` — not a constructor — so `new`
 * would throw. That stub's own comment records this exact class of failure
 * reaching a model as "This model failed (…)", which is precisely what must not
 * happen to a tool's fallback path.
 */
export function isHiddenPageAvailable(): boolean {
  const BW = (electron as { BrowserWindow?: unknown }).BrowserWindow;
  return (
    typeof BW === "function" && typeof electron.app?.isReady === "function"
  );
}

/** Every window this module owns, across all partitions. */
function ourWindows(): Set<Win> {
  const set = new Set<Win>();
  for (const slot of slots.values()) {
    if (slot.window) set.add(slot.window);
  }
  return set;
}

function destroySlot(slot: PageSlot): void {
  const w = slot.window;
  slot.window = null;
  if (slot.idleTimer) {
    clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
  }
  try {
    if (w && !w.isDestroyed()) w.destroy();
  } catch {
    /* teardown must never throw */
  }
}

/** Release every hidden window (app shutdown, last-window teardown, or tests). */
export function shutdownHiddenPages(): void {
  for (const slot of slots.values()) destroySlot(slot);
}

/** See property 2 in the file header — this is what lets the app quit. */
function destroyIfLastWindow(): void {
  // `closed` has already removed the window in current Electron, but a deferred
  // check costs nothing and does not depend on that ordering staying true.
  setImmediate(() => {
    try {
      const ours = ourWindows();
      const others = electron.BrowserWindow.getAllWindows().filter(
        (w) => !ours.has(w) && !w.isDestroyed(),
      );
      if (others.length === 0) shutdownHiddenPages();
    } catch {
      /* teardown must never throw */
    }
  });
}

let lastWindowWatchInstalled = false;

/** Watch every window that is not ours — those open now, and those opened later. */
function installLastWindowWatch(): void {
  if (lastWindowWatchInstalled) return;
  lastWindowWatchInstalled = true;
  try {
    const { BrowserWindow, app } = electron;
    const watch = (w: Win) => {
      if (!ourWindows().has(w) && !w.isDestroyed())
        w.once("closed", destroyIfLastWindow);
    };
    // Windows that already exist: the main window is created long before the
    // first search or read, so `browser-window-created` alone would never see it.
    for (const w of BrowserWindow.getAllWindows()) watch(w);
    // `browser-window-created` fires DURING construction, before we have assigned
    // our own window into its slot — so a same-tick ownership check would see our
    // own window as someone else's. Defer one tick and the slot is populated.
    app.on("browser-window-created", (_e, w) => setImmediate(() => watch(w)));
  } catch {
    /* a watch we could not install is not a reason to fail a request */
  }
}

function scheduleIdleDestroy(slot: PageSlot, idleMs: number): void {
  if (slot.idleTimer) clearTimeout(slot.idleTimer);
  slot.idleTimer = setTimeout(() => {
    slot.idleTimer = null;
    destroySlot(slot);
  }, idleMs);
  slot.idleTimer.unref?.();
}

function getWindow(slot: PageSlot, partition: string): Win {
  if (slot.window && !slot.window.isDestroyed()) return slot.window;
  const { BrowserWindow, session } = electron;

  // Same hardening posture as the user-facing browser tabs (browser_view_manager):
  // isolated partition, sandboxed, no preload, no node, downloads and permissions
  // denied. This window renders a hostile third-party page and does nothing else.
  const ses = session.fromPartition(partition, { cache: true });
  const hardened = ses as Electron.Session & {
    __atlarixHiddenPageHardened?: boolean;
  };
  if (!hardened.__atlarixHiddenPageHardened) {
    hardened.__atlarixHiddenPageHardened = true;
    ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    ses.on("will-download", (e) => e.preventDefault());
  }

  slot.window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // A hidden window is throttled by default, which would stall the very
      // timers and layout the page needs to finish rendering.
      backgroundThrottling: false,
      // Layout must happen even though nothing is on screen — `innerText`, which
      // the extractors prefer, is layout-dependent.
      offscreen: false,
    },
  });
  // http(s) only, and never a popup: the same scheme allowlist the browser tabs use.
  slot.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  slot.window.webContents.on("will-navigate", (event, url) => {
    if (!/^https?:$/.test(new URL(url).protocol)) event.preventDefault();
  });
  installLastWindowWatch();
  return slot.window;
}

/** Load `url` and resolve once the DOM is ready, or reject on timeout. */
async function loadPage(
  win: Win,
  url: string,
  navTimeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      // Stop the in-flight load so the next request starts from a quiet renderer.
      try {
        win.webContents.stop();
      } catch {
        /* ignore */
      }
      reject(new Error(`navigation timed out after ${navTimeoutMs}ms`));
    }, navTimeoutMs);
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

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  return (await Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      );
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer!))) as T;
}

/**
 * Load `url` in this partition's hidden window and run `extract` against it.
 *
 * Returns `null` for every failure mode — unavailable, blocked, timed out, or an
 * extractor that threw — so callers fall through without a try/catch. Requests on
 * one partition are serialized; different partitions run independently.
 *
 * The caller is responsible for validating `url` (see `assertUrlAllowed`) BEFORE
 * calling: this function will load whatever it is given.
 */
export async function withHiddenPage<T>(
  url: string,
  opts: HiddenPageOptions,
  extract: (wc: Electron.WebContents) => Promise<T>,
): Promise<T | null> {
  if (!isHiddenPageAvailable()) return null;

  const slot = getSlot(opts.partition);
  const navTimeoutMs = opts.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
  const idleMs = opts.idleDestroyMs ?? DEFAULT_IDLE_DESTROY_MS;

  // Chain onto the queue rather than locking: it keeps ordering without a mutex,
  // and a failed request must not poison the chain for the next one.
  const task = slot.queue.then(async () => {
    try {
      if (!electron.app.isReady()) await electron.app.whenReady();
      const win = getWindow(slot, opts.partition);
      await loadPage(win, url, navTimeoutMs);
      return await withTimeout(
        extract(win.webContents),
        opts.extractTimeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS,
        "extraction",
      );
    } catch (e) {
      logger.warn(`[headless-page] ${opts.partition} failed for ${url}: ${e}`);
      return null;
    } finally {
      scheduleIdleDestroy(slot, idleMs);
    }
  });

  // Keep the chain alive regardless of this request's outcome.
  slot.queue = task.catch(() => undefined);
  return task;
}
