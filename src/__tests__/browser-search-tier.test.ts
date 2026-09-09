/**
 * The browser tier must never break the search chain.
 *
 * `smartSearch` is on the path of every `web_search` call, so a tier that throws
 * does not degrade search — it fails the turn. The tier's entire contract is
 * therefore "results, or `[]`", and `[]` means the chain continues to SearxNG and
 * then DDG exactly as before.
 *
 * The case that motivates the guard: the headless build aliases `electron` to a
 * stub whose `BrowserWindow` is a plain OBJECT with `getAllWindows` /
 * `getFocusedWindow` — not a constructor — so `new BrowserWindow(...)` throws.
 * That stub's own comment records this class of failure surfacing to a model as
 * "This model failed (…)", which is exactly what a search tier must not do. And
 * headless genuinely reaches this code: `smartSearch` is in the headless bundle.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

/** The headless stub's shape: an object, deliberately not a constructor. */
const HEADLESS_ELECTRON = {
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  app: {},
  session: {},
};

async function loadTier(electronMock: unknown) {
  vi.resetModules();
  vi.doMock("electron", () => electronMock as Record<string, unknown>);
  return await import("@/lib/search/browser-search");
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.doUnmock("electron");
  vi.resetModules();
});

describe("browser search availability guard", () => {
  it("reports UNAVAILABLE against the headless stub, rather than throwing", async () => {
    const { isBrowserSearchAvailable } = await loadTier(HEADLESS_ELECTRON);
    expect(isBrowserSearchAvailable()).toBe(false);
  });

  it("returns [] instead of constructing a window that cannot be constructed", async () => {
    const { browserSearch } = await loadTier(HEADLESS_ELECTRON);
    await expect(
      browserSearch("electron 43 breaking changes"),
    ).resolves.toEqual([]);
  });

  it("reports AVAILABLE when Electron is real", async () => {
    const { isBrowserSearchAvailable } = await loadTier({
      BrowserWindow: class {},
      app: { isReady: () => true, whenReady: async () => undefined },
      session: { fromPartition: () => ({}) },
    });
    expect(isBrowserSearchAvailable()).toBe(true);
  });

  it("returns [] for an empty query without touching Electron at all", async () => {
    const bw = vi.fn();
    const { browserSearch } = await loadTier({
      BrowserWindow: bw,
      app: { isReady: () => true },
      session: { fromPartition: () => ({}) },
    });
    await expect(browserSearch("   ")).resolves.toEqual([]);
    expect(bw).not.toHaveBeenCalled();
  });
});

describe("engine table", () => {
  it("defaults to Brave and builds an encoded query URL", async () => {
    const { SEARCH_ENGINES, DEFAULT_SEARCH_ENGINE } =
      await loadTier(HEADLESS_ELECTRON);
    expect(DEFAULT_SEARCH_ENGINE).toBe("brave");
    const url = SEARCH_ENGINES.brave("electron 43 breaking changes");
    expect(url).toBe(
      "https://search.brave.com/search?q=electron%2043%20breaking%20changes",
    );
  });

  it("keeps engines as DATA, so adding one is not a code change", async () => {
    const { SEARCH_ENGINES } = await loadTier(HEADLESS_ELECTRON);
    // Google is present but never the default: its terms prohibit automated
    // queries, so it is only reachable when a user explicitly selects it.
    expect(Object.keys(SEARCH_ENGINES).sort()).toEqual([
      "brave",
      "duckduckgo",
      "google",
    ]);
    for (const build of Object.values(SEARCH_ENGINES)) {
      expect(build("a b")).toMatch(/^https:\/\/[^ ]+$/);
    }
  });
});

/**
 * A hidden window is still an OPEN window, and that is a quit bug.
 *
 * On Windows and Linux `window-all-closed` is what quits the app, and it fires
 * only once EVERY window has closed. The search window is invisible, so closing
 * the last real window would leave the app running until the 60s idle timer
 * happened to reap it — "I closed Atlarix and it kept running".
 */
describe("the hidden window follows the app's lifetime", () => {
  /** A minimal Electron whose windows are real event emitters. */
  function fakeElectron() {
    const live: FakeWin[] = [];
    class FakeWin extends EventEmitter {
      destroyed = false;
      webContents = {
        setWindowOpenHandler: () => {},
        on: () => {},
        off: () => {},
        once: () => {},
        executeJavaScript: async () => [],
        stop: () => {},
      };
      constructor() {
        super();
        live.push(this as unknown as FakeWin);
      }
      // No network in a unit test: rejecting immediately drives `loadPage` down
      // its failure path in microseconds instead of waiting out the 12s timeout.
      loadURL() {
        return Promise.reject(new Error("no network in a unit test"));
      }
      isDestroyed() {
        return this.destroyed;
      }
      destroy() {
        this.destroyed = true;
        this.emit("closed");
      }
      static getAllWindows() {
        return live.filter((w) => !w.destroyed);
      }
    }
    return {
      BrowserWindow: FakeWin,
      app: {
        isReady: () => true,
        whenReady: async () => undefined,
        on: () => {},
      },
      session: {
        fromPartition: () => ({
          setPermissionRequestHandler: () => {},
          on: () => {},
        }),
      },
      _windows: () => FakeWin.getAllWindows(),
      _newWindow: () => new FakeWin(),
    };
  }

  const flush = async () => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };

  it("destroys itself when the last real window closes, so the app can quit", async () => {
    const el = fakeElectron();
    const mainWindow = el._newWindow();
    const { browserSearch } = await loadTier(el);

    // A failed search still leaves the window warm for the next query.
    await expect(
      browserSearch("electron 43 breaking changes"),
    ).resolves.toEqual([]);
    expect(el._windows()).toHaveLength(2); // the app's window, and ours

    mainWindow.destroy(); // the user closes the app's last visible window
    await flush();

    expect(el._windows()).toHaveLength(0);
  });

  it("stays alive while any other window remains", async () => {
    const el = fakeElectron();
    const first = el._newWindow();
    el._newWindow(); // a second app window the user keeps open
    const { browserSearch } = await loadTier(el);

    await browserSearch("vite 8 esm require condition");
    expect(el._windows()).toHaveLength(3);

    first.destroy();
    await flush();

    // One app window is still open, so the search window is still useful.
    expect(el._windows()).toHaveLength(2);
  });
});

/**
 * `smartSearch` strips `site:` operators before searching, because the SearxNG and
 * DDG tiers handle them badly. A real engine implements `site:` properly, so
 * passing the stripped query to the browser tier would silently throw away the
 * caller's scoping — the search would succeed and answer a different question.
 */
describe("the browser tier receives the query the caller actually wrote", () => {
  it("keeps site: operators, which the tiers below strip", async () => {
    vi.resetModules();
    const seen: string[] = [];
    vi.doMock("@/lib/search/browser-search", () => ({
      isBrowserSearchAvailable: () => true,
      browserSearch: async (q: string) => {
        seen.push(q);
        return [
          {
            title: "A result title long enough",
            url: "https://x.dev/a",
            snippet: "s",
          },
        ];
      },
    }));

    const { smartSearch } = await import("@/lib/search/index");
    const out = await smartSearch(
      "site:github.com electron 43 breaking changes",
      5,
    );

    expect(seen).toEqual(["site:github.com electron 43 breaking changes"]);
    // And a hit short-circuits the chain, so no lower tier is contacted.
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe("browser");
    vi.doUnmock("@/lib/search/browser-search");
  });
});
