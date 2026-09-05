/**
 * The four seams `computer_call` has to go through, tested before anything is
 * registered.
 *
 * The dispatch table says WHICH tools are reachable; these are the checks that make
 * reaching them safe. Each one exists because the raw-dispatch path has no
 * equivalent of the thing the curated `computer` tool got for free:
 *
 *  - **keys** — `computer` exposes a closed enum, so `cmd+Q` is not expressible at
 *    all. `hotkey` takes a free-form array, so it has to be *decided*.
 *  - **apps** — `computer` addresses by ref, and a ref carries a pid we resolved.
 *    `computer_call` takes a raw pid, which carries no name for a guard to read.
 *  - **refs** — the owner allowed pixel actions "paired with a read", and only a
 *    ledger can tell a coordinate that came from a read apart from a guessed one.
 *  - **desk lock** — unchanged for the desktop; the browser tools needed their own
 *    lane rather than a shared one.
 *
 * EVERY REFUSAL HERE IS PAIRED WITH AN ALLOW. A test that only asserts refusals
 * passes just as happily against a function that refuses everything, and this
 * session has already shipped two green tests that asserted nothing.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

/** Our own pids, as `app.getAppMetrics()` would report them. */
let ownMetricPids: number[] = [4242];
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getName: () => "Atlarix",
    getAppPath: () => process.cwd(),
    getPath: () => os.tmpdir(),
    getAppMetrics: () => ownMetricPids.map((pid) => ({ pid })),
  },
}));

/** What the stubbed `list_apps` returns. */
let driverApps: Array<Record<string, unknown>> = [];
vi.mock("@/lib/computer/driver-session", () => ({
  callDriver: vi.fn(async (tool: string) => (tool === "list_apps" ? { apps: driverApps } : {})),
  ComputerUseError: class extends Error {},
}));

const loadApps = async () => await import("@/lib/computer/apps");
const loadKeys = async () => await import("@/lib/computer/keys");

beforeEach(() => {
  vi.resetModules();
  setPlatform("darwin");
  ownMetricPids = [4242];
  driverApps = [
    { name: "Slack", pid: 100, bundle_id: "com.tinyspeck.slackmacgap", running: true },
    { name: "Terminal", pid: 200, bundle_id: "com.apple.terminal", running: true },
    { name: "1Password", pid: 300, bundle_id: "com.1password.1password", running: true },
    { name: "Atlarix", pid: 4242, bundle_id: "com.electron.atlarix", running: true },
  ];
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

// ── keys: the chord allowlist ───────────────────────────────────────────────

describe("chord allowlist", () => {
  /**
   * THE REASON THIS IS AN ALLOWLIST. Every entry below is a real shortcut that
   * quits, closes, hides, locks, switches away from, or opens a shell on at least
   * one of the three platforms — and the list is not close to complete, which is
   * precisely why "block the destructive ones" is not a strategy.
   */
  const hostile: Array<[string, string[]]> = [
    ["quit", ["cmd", "q"]],
    ["force quit", ["cmd", "alt", "escape"]],
    ["lock screen", ["cmd", "ctrl", "q"]],
    ["log out", ["cmd", "shift", "q"]],
    ["close window", ["cmd", "w"]],
    ["hide", ["cmd", "h"]],
    ["minimise", ["cmd", "m"]],
    ["Spotlight — a launcher", ["cmd", "space"]],
    ["app switcher", ["cmd", "tab"]],
    ["alt+F4", ["alt", "f4"]],
    ["ctrl+alt+del", ["ctrl", "alt", "delete"]],
    ["Task Manager", ["ctrl", "shift", "escape"]],
    ["a terminal, on most Linux desktops", ["ctrl", "alt", "t"]],
    ["virtual console switch", ["ctrl", "alt", "f1"]],
    ["GNOME/KDE workspace switch", ["ctrl", "alt", "left"]],
    ["the Run box — a shell", ["win", "r"]],
    ["lock, on Windows", ["super", "l"]],
    ["full screen", ["fn", "f11"]],
  ];

  for (const [what, keys] of hostile) {
    it(`refuses ${keys.join("+")} (${what})`, async () => {
      const { guardChord } = await loadKeys();
      const v = guardChord(keys);
      expect(v.allowed, `${keys.join("+")} must be refused`).toBe(false);
      if (v.allowed) return;
      expect(v.reason).toMatch(/text editing and in-document navigation|not a modifier|not a key/i);
    });
  }

  // The paired ALLOWS. Without these the block above would pass against a
  // `guardChord` that refused everything, which is the same as not shipping the
  // feature.
  const allowed: Array<[string, string[], string[]]> = [
    ["copy", ["cmd", "c"], ["cmd", "c"]],
    ["paste", ["cmd", "v"], ["cmd", "v"]],
    ["select all", ["cmd", "a"], ["cmd", "a"]],
    ["save", ["cmd", "s"], ["cmd", "s"]],
    ["find", ["cmd", "f"], ["cmd", "f"]],
    ["redo", ["cmd", "shift", "z"], ["cmd", "shift", "z"]],
    ["find previous", ["shift", "cmd", "g"], ["cmd", "shift", "g"]],
    ["paste and match style", ["cmd", "shift", "v"], ["cmd", "shift", "v"]],
    ["line start", ["cmd", "left"], ["cmd", "left"]],
    ["select to line end", ["cmd", "shift", "right"], ["cmd", "shift", "right"]],
    ["word left", ["alt", "left"], ["alt", "left"]],
    ["select word right", ["alt", "shift", "right"], ["alt", "shift", "right"]],
    ["extend selection", ["shift", "down"], ["shift", "down"]],
    ["delete word", ["alt", "delete"], ["alt", "delete"]],
    ["send", ["cmd", "enter"], ["cmd", "return"]],
  ];

  for (const [what, keys, expected] of allowed) {
    it(`allows ${keys.join("+")} (${what})`, async () => {
      const { guardChord } = await loadKeys();
      const v = guardChord(keys);
      expect(v.allowed, `${keys.join("+")} must be allowed`).toBe(true);
      if (!v.allowed) return;
      expect(v.keys).toEqual(expected);
    });
  }

  it("canonicalises spelling and order rather than refusing them", async () => {
    const { guardChord } = await loadKeys();
    // `Command` and `⌘` are the driver's own accepted spellings; a model that uses
    // one should not be refused for it.
    for (const raw of [["Command", "C"], ["⌘", "c"], ["CMD", " c "]]) {
      const v = guardChord(raw);
      expect(v.allowed, JSON.stringify(raw)).toBe(true);
      if (v.allowed) expect(v.keys).toEqual(["cmd", "c"]);
    }
  });

  it("names the real mistake when the key comes first", async () => {
    const { guardChord } = await loadKeys();
    const v = guardChord(["z", "cmd", "shift"]);
    expect(v.allowed).toBe(false);
    // Not "shift is not a key" — that would send the model looking for a different
    // spelling of shift.
    if (!v.allowed) expect(v.reason).toMatch(/modifiers come first/i);
  });

  it("refuses a bare key and a repeated modifier", async () => {
    const { guardChord } = await loadKeys();
    expect(guardChord(["c"]).allowed).toBe(false);
    expect(guardChord([]).allowed).toBe(false);
    expect(guardChord(["cmd", "cmd", "c"]).allowed).toBe(false);
  });

  /**
   * THE PLATFORM SPLIT, and the reason `ctrl` is not simply banned.
   *
   * On Windows and Linux ctrl+arrow is word-wise movement — ordinary editing. On
   * macOS ctrl+arrow switches Spaces and ctrl+up opens Mission Control. The same
   * three keys, an editing convenience on two platforms and an OS-level action on
   * the third.
   */
  it("allows ctrl+arrow on Windows and refuses it on macOS", async () => {
    setPlatform("win32");
    vi.resetModules();
    const win = await loadKeys();
    expect(win.guardChord(["ctrl", "left"]).allowed).toBe(true);
    expect(win.guardChord(["ctrl", "c"]).allowed).toBe(true);
    // And cmd means nothing on Windows, so the editing chord does not silently
    // resolve through the wrong modifier.
    expect(win.guardChord(["cmd", "c"]).allowed).toBe(false);

    setPlatform("darwin");
    vi.resetModules();
    const mac = await loadKeys();
    expect(mac.guardChord(["ctrl", "left"]).allowed).toBe(false);
    expect(mac.guardChord(["ctrl", "up"]).allowed).toBe(false);
  });

  it("flattens press_key's modifiers into the same chord check", async () => {
    const { chordFromPressKey, guardChord } = await loadKeys();
    // `press_key` says "Press and release a single key" and carries a `modifiers`
    // array, so it IS a chord tool. A guard that reads `hotkey` alone is not a guard.
    expect(chordFromPressKey({ key: "q", modifiers: ["cmd"] })).toEqual(["cmd", "q"]);
    expect(guardChord(chordFromPressKey({ key: "q", modifiers: ["cmd"] })!).allowed).toBe(false);
    // No modifiers is not a chord at all — that path stays with the closed key set.
    expect(chordFromPressKey({ key: "tab" })).toBeNull();
    expect(chordFromPressKey({ key: "tab", modifiers: [] })).toBeNull();
  });
});

describe("key vocabulary translation", () => {
  /**
   * The closed set was written against `atlarix-cu`'s vocabulary (`post.rs`), and
   * `computer.ts` sends the name to CUA-DRIVER, whose published vocabulary is
   * "return, tab, escape, up/down/left/right, space, delete, home, end, pageup,
   * pagedown, f1-f12, plus any letter or digit" — with no `select_all` at all.
   */
  it("renames the keys the driver spells differently", async () => {
    const { toDriverKey } = await loadKeys();
    expect(toDriverKey("enter")).toEqual({ key: "return" });
    expect(toDriverKey("page_up")).toEqual({ key: "pageup" });
    expect(toDriverKey("page_down")).toEqual({ key: "pagedown" });
    expect(toDriverKey("backspace")).toEqual({ key: "delete" });
    // Unchanged ones must stay unchanged, or the translation is just noise.
    expect(toDriverKey("tab")).toEqual({ key: "tab" });
    expect(toDriverKey("escape")).toEqual({ key: "escape" });
    expect(toDriverKey("left")).toEqual({ key: "left" });
  });

  it("turns the four semantic keys into real chords, per platform", async () => {
    const mac = await loadKeys();
    expect(mac.toDriverKey("select_all")).toEqual({ key: "a", modifiers: ["cmd"] });
    expect(mac.toDriverKey("copy")).toEqual({ key: "c", modifiers: ["cmd"] });
    expect(mac.toDriverKey("paste")).toEqual({ key: "v", modifiers: ["cmd"] });
    expect(mac.toDriverKey("cut")).toEqual({ key: "x", modifiers: ["cmd"] });

    setPlatform("linux");
    vi.resetModules();
    const lin = await loadKeys();
    expect(lin.toDriverKey("copy")).toEqual({ key: "c", modifiers: ["ctrl"] });
  });

  it("keeps every name in the closed set translatable", async () => {
    const { KEYS, toDriverKey } = await loadKeys();
    for (const k of KEYS) {
      const t = toDriverKey(k);
      expect(t.key, `${k} produced an empty driver key`).toBeTruthy();
    }
  });
});

// ── apps: the raw-pid seam ──────────────────────────────────────────────────

describe("resolveTargetPid", () => {
  it("resolves an ordinary app", async () => {
    const { resolveTargetPid } = await loadApps();
    const r = await resolveTargetPid(100);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.app.name).toBe("Slack");
  });

  /**
   * ORDER MATTERS. `listApps()` filters Atlarix out (check 3), so looking our own
   * pid up in that list finds nothing — and "no running application has pid 4242"
   * is both the wrong answer and an invitation to retry. The self check has to run
   * before the listing.
   */
  it("refuses our own pid with the self refusal, not a not-found", async () => {
    const { resolveTargetPid } = await loadApps();
    const r = await resolveTargetPid(4242);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Atlarix's own window/i);
    expect(r.error).not.toMatch(/No running application has pid/);
  });

  it("refuses a renderer pid too, not only the main process", async () => {
    ownMetricPids = [4242, 4243, 4244];
    driverApps.push({ name: "Atlarix Helper", pid: 4243, running: true });
    const { resolveTargetPid } = await loadApps();
    const r = await resolveTargetPid(4243);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Atlarix's own window/i);
  });

  it("rejects a non-pid without reaching the driver", async () => {
    const { resolveTargetPid } = await loadApps();
    for (const bad of [0, -1, 1.5, "abc", null, undefined]) {
      const r = await resolveTargetPid(bad);
      expect(r.ok, String(bad)).toBe(false);
    }
  });

  it("explains that pids change, when the pid is simply gone", async () => {
    const { resolveTargetPid } = await loadApps();
    const r = await resolveTargetPid(999_999);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/pids? change|read .* again/i);
  });
});

describe("the two entry points share one tail", () => {
  /**
   * THE DRIFT THIS PREVENTS. `apps.ts` calls itself "THE SINGLE SEAM", and that is
   * true only while a name and a raw pid end in the same three checks. Two copies is
   * how one of them quietly stops refusing something — so the assertion is not "each
   * refuses" but "they refuse the SAME things".
   */
  const hostile = [
    { by: "Terminal", pid: 200, why: /terminal or shell/i },
    { by: "1Password", pid: 300, why: /credentials or system permissions/i },
    { by: "Atlarix", pid: 4242, why: /Atlarix's own window/i },
  ];

  for (const target of hostile) {
    it(`refuses ${target.by} by name AND by pid`, async () => {
      const { resolveTargetApp, resolveTargetPid } = await loadApps();
      const byName = await resolveTargetApp(target.by);
      const byPid = await resolveTargetPid(target.pid);
      expect(byName.ok, `${target.by} by name`).toBe(false);
      expect(byPid.ok, `${target.by} by pid`).toBe(false);
      if (byName.ok || byPid.ok) return;
      expect(byName.error).toMatch(target.why);
      expect(byPid.error).toMatch(target.why);
    });
  }

  it("and allows the same ordinary app through both", async () => {
    const { resolveTargetApp, resolveTargetPid } = await loadApps();
    expect((await resolveTargetApp("Slack")).ok).toBe(true);
    expect((await resolveTargetPid(100)).ok).toBe(true);
  });
});

// ── apps: the outbound filter ───────────────────────────────────────────────

describe("stripSelfFromResult", () => {
  /**
   * `list_apps` was the only listing the model could reach, so filtering it inside
   * `listApps()` was the whole of check 3. `computer_call` adds two more, and BOTH
   * were found by reading `describe` rather than by reasoning about the names:
   * `list_windows`'s `pid` is optional, and `get_accessibility_tree` takes no
   * parameters at all and needs no TCC grant.
   */
  it("removes us from an app listing", async () => {
    const { stripSelfFromResult } = await loadApps();
    const out = stripSelfFromResult("list_apps", {
      apps: [
        { name: "Slack", pid: 100 },
        { name: "Atlarix", pid: 4242, bundle_id: "com.electron.atlarix" },
      ],
    }) as { apps: Array<{ name: string }> };
    expect(out.apps.map((a) => a.name)).toEqual(["Slack"]);
  });

  it("removes our windows, which carry bounds someone could aim at", async () => {
    const { stripSelfFromResult } = await loadApps();
    const out = stripSelfFromResult("list_windows", {
      windows: [
        { window_id: "w1", pid: 100, app_name: "Slack", bounds: { x: 0, y: 0 } },
        { window_id: "w2", pid: 4242, app_name: "Atlarix", bounds: { x: 10, y: 20 } },
      ],
    }) as { windows: Array<{ window_id: string }> };
    expect(out.windows.map((w) => w.window_id)).toEqual(["w1"]);
  });

  it("matches on a name even when the pid is one we do not own", async () => {
    // A second copy of Atlarix, running from another path, has a pid
    // `getAppMetrics()` never reports. Identity is the backstop for exactly that.
    const { stripSelfFromResult } = await loadApps();
    const out = stripSelfFromResult("get_accessibility_tree", {
      apps: [{ name: "Atlarix", pid: 55_555 }],
      windows: [{ pid: 55_555, app_name: "Atlarix" }],
    }) as { apps: unknown[]; windows: unknown[] };
    expect(out.apps).toEqual([]);
    expect(out.windows).toEqual([]);
  });

  it("reaches records that are nested, not only top-level arrays", async () => {
    const { stripSelfFromResult } = await loadApps();
    const out = stripSelfFromResult("get_accessibility_tree", {
      desktop: { displays: [{ windows: [{ pid: 4242, app_name: "Atlarix" }, { pid: 100 }] }] },
    }) as { desktop: { displays: Array<{ windows: Array<{ pid: number }> }> } };
    expect(out.desktop.displays[0]!.windows.map((w) => w.pid)).toEqual([100]);
  });

  it("leaves everything else untouched", async () => {
    const { stripSelfFromResult } = await loadApps();
    // Not a listing tool: a window snapshot of a vetted app must come back whole,
    // and a filter that walked it would be pure cost on the biggest payload we have.
    const snap = { pid: 4242, elements: [{ role: "AXButton" }] };
    expect(stripSelfFromResult("get_window_state", snap)).toBe(snap);
    // And within a listing, an app that is not us survives intact.
    const kept = stripSelfFromResult("list_apps", { apps: [{ name: "Slack", pid: 100 }] }) as {
      apps: Array<{ name: string }>;
    };
    expect(kept.apps).toHaveLength(1);
  });
});

// ── refs: "did you look first" ──────────────────────────────────────────────

describe("hasRecentReadFor", () => {
  it("is false until something reads that window, and true after", async () => {
    const refs = await import("@/lib/computer/refs");
    refs.resetRefsForTests();
    expect(refs.hasRecentReadFor(100)).toBe(false);
    refs.mintRefs({
      appKey: "com.tinyspeck.slackmacgap",
      pid: 100,
      elements: [{ role: "AXButton", label: "Send", frame: { x: 0, y: 0, w: 1, h: 1 }, depth: 1, token: "t" }],
    });
    expect(refs.hasRecentReadFor(100)).toBe(true);
    // Reading one window says nothing about another.
    expect(refs.hasRecentReadFor(200)).toBe(false);
  });

  it("expires, but generously — it is not a staleness check", async () => {
    const refs = await import("@/lib/computer/refs");
    refs.resetRefsForTests();
    refs.noteWindowRead(100);
    const now = Date.now();
    // Whether an ELEMENT is still that element is the driver's job, and it has an
    // explicit stale error for it. This only answers "did this turn look".
    expect(refs.hasRecentReadFor(100, now + 4 * 60_000)).toBe(true);
    expect(refs.hasRecentReadFor(100, now + 6 * 60_000)).toBe(false);
  });

  it("ignores a nonsense pid rather than recording it", async () => {
    const refs = await import("@/lib/computer/refs");
    refs.resetRefsForTests();
    refs.noteWindowRead(0);
    refs.noteWindowRead(-3);
    expect(refs.hasRecentReadFor(0)).toBe(false);
    expect(refs.hasRecentReadFor(-3)).toBe(false);
  });
});

// ── desk lock: the browser lane ─────────────────────────────────────────────

describe("lock lanes", () => {
  // The admission gate resolves through a promise chain, not synchronously, so a
  // single microtask is not enough to observe a holder as admitted.
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  it("does not make browser work queue behind a desktop action", async () => {
    const lock = await import("@/lib/computer/desk-lock");
    lock.resetDeskLockForTests();

    let releaseDesk!: () => void;
    const deskHeld = new Promise<void>((r) => {
      releaseDesk = r;
    });
    const desk = lock.withDesk("a long click", () => deskHeld);
    await tick();

    // The whole point: the browser call completes while the desk is still held.
    const browser = await lock.withDesk("browser_click", async () => "done", { lane: "browser" });
    expect(browser).toBe("done");

    releaseDesk();
    await desk;
  });

  it("still serialises within a lane, and reports the right one when busy", async () => {
    const lock = await import("@/lib/computer/desk-lock");
    lock.resetDeskLockForTests();

    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const first = lock.withDesk("b1", async () => {
      order.push("b1");
      await held;
    }, { lane: "browser" });
    await tick();
    const second = lock.withDesk("b2", async () => {
      order.push("b2");
    }, { lane: "browser" });

    await tick();
    expect(order).toEqual(["b1"]);
    expect(lock.deskLockStateForTests("browser").inFlight).toBe(2);
    // And the desk lane is untouched by any of it.
    expect(lock.deskLockStateForTests("desk").inFlight).toBe(0);

    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["b1", "b2"]);
  });

  it("still accepts a bare AbortSignal, so existing callers are unchanged", async () => {
    const lock = await import("@/lib/computer/desk-lock");
    lock.resetDeskLockForTests();
    const ac = new AbortController();
    await expect(lock.withDesk("legacy", async () => "ok", ac.signal)).resolves.toBe("ok");
  });
});
