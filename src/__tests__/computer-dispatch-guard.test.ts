/**
 * Every way `computer_call` could reach the driver without passing a guard.
 *
 * `computer` addresses by ref and exposes a closed enum, so most of these were not
 * expressible at all. `computer_call` takes `{tool, input}` — an arbitrary object —
 * so each one has to be *decided*, and this file is where those decisions are held
 * still.
 *
 * REFUSALS ARE PAIRED WITH ALLOWS throughout. A guard test suite that only asserts
 * refusals passes identically against a function that refuses everything.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";

const realPlatform = process.platform;

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

let driverApps: Array<Record<string, unknown>> = [];
let driverWindows: Array<Record<string, unknown>> = [];
vi.mock("@/lib/computer/driver-session", () => ({
  callDriver: vi.fn(async (tool: string) => {
    if (tool === "list_apps") return { apps: driverApps };
    if (tool === "list_windows") return { windows: driverWindows };
    return {};
  }),
  ComputerUseError: class extends Error {},
  dumpDocsJson: vi.fn(async () => []),
}));

/** The pixel rung, so a test never depends on this machine's SkyLight symbols. */
let rung = "driver-spi";
vi.mock("@/lib/computer/input-rung", () => ({
  detectInputRung: vi.fn(async () => rung),
  // Rung 4 is a decision taken from rung 3, so the mock has to make it too — the
  // real one refuses exactly when the SPI path is gone.
  pixelDeliveryRefused: (r: string) => r === "public-fallback",
  refusePixelAction: (what: string) => `Pixel ${what} is unavailable on this machine.`,
}));

const load = async () => await import("@/lib/computer/dispatch-guard");

/** Register a read of `pid`, so the pixel policy's precondition is satisfied. */
async function noteRead(pid: number) {
  const refs = await import("@/lib/computer/refs");
  refs.noteWindowRead(pid);
}

/** Mint one ref for `pid` and return it. */
async function mintRef(pid: number, el: { role: string; label: string }) {
  const refs = await import("@/lib/computer/refs");
  const [minted] = refs.mintRefs({
    appKey: `app-${pid}`,
    pid,
    elements: [{ ...el, frame: { x: 0, y: 0, w: 10, h: 10 }, depth: 1, token: `tok-${pid}` }],
  });
  return minted!.ref;
}

beforeEach(async () => {
  vi.resetModules();
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  rung = "driver-spi";
  ownMetricPids = [4242];
  driverApps = [
    { name: "Slack", pid: 100, bundle_id: "com.tinyspeck.slackmacgap", running: true },
    { name: "Terminal", pid: 200, bundle_id: "com.apple.terminal", running: true },
    { name: "1Password", pid: 300, bundle_id: "com.1password.1password", running: true },
    { name: "Atlarix", pid: 4242, bundle_id: "com.electron.atlarix", running: true },
  ];
  driverWindows = [
    { window_id: "w-slack", pid: 100, app_name: "Slack" },
    { window_id: "w-atlarix", pid: 4242, app_name: "Atlarix" },
    { window_id: "w-term", pid: 200, app_name: "Terminal" },
  ];
  const refs = await import("@/lib/computer/refs");
  refs.resetRefsForTests();
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("the target holes", () => {
  it("refuses Atlarix by raw pid", async () => {
    const { prepareDispatch } = await load();
    const r = await prepareDispatch("get_window_state", { pid: 4242 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Atlarix's own window/i);
  });

  it("refuses Terminal by raw pid, with run_command named", async () => {
    const { prepareDispatch } = await load();
    const r = await prepareDispatch("type_text", { pid: 200, text: "rm -rf /" });
    expect(r.ok).toBe(false);
    // The TARGET check must be what fires — it runs before the typing check, and an
    // "or" here would let a reordering pass silently.
    if (!r.ok) {
      expect(r.error).toMatch(/terminal or shell/i);
      expect(r.error).toMatch(/run_command/);
    }
  });

  it("refuses a credential app", async () => {
    const { prepareDispatch } = await load();
    const r = await prepareDispatch("get_window_state", { pid: 300 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/credentials or system permissions/i);
  });

  /**
   * `window_id` is a target that names no application, and several tools accept it
   * INSTEAD of a pid. Unresolved, it is a complete route to our own window.
   */
  it("resolves window_id back to its owner, and refuses ours", async () => {
    const { prepareDispatch } = await load();
    const bad = await prepareDispatch("get_window_state", { window_id: "w-atlarix" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/Atlarix's own window/i);

    const term = await prepareDispatch("get_window_state", { window_id: "w-term" });
    expect(term.ok).toBe(false);

    const good = await prepareDispatch("get_window_state", { window_id: "w-slack" });
    expect(good.ok, "an ordinary window must still work").toBe(true);
  });

  it("refuses an unknown window id rather than passing it through", async () => {
    const { prepareDispatch } = await load();
    const r = await prepareDispatch("get_window_state", { window_id: "w-gone" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/No open window has id/);
  });

  /** `move_cursor` has NO top-level pid — its only address is the nested one. */
  it("resolves the nested target.pid", async () => {
    const { prepareDispatch } = await load();
    await noteRead(100);
    const bad = await prepareDispatch("move_cursor", {
      target: { kind: "window", pid: 4242, window_id: 1 },
      x: 5,
      y: 5,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/Atlarix's own window/i);

    // A REAL window id from the fixture, because the nested `window_id` is now
    // resolved too — a made-up one is refused, which is the point of step 6b.
    const good = await prepareDispatch("move_cursor", {
      target: { kind: "window", pid: 100, window_id: "w-slack" },
      x: 5,
      y: 5,
    });
    expect(good.ok).toBe(true);
  });

  it("rewrites a resolved bundle id to the pid the driver wants", async () => {
    const { prepareDispatch } = await load();
    const r = await prepareDispatch("get_window_state", { pid: 100 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.prepared.input.pid).toBe(100);
  });

  /**
   * `launch_app` names an app that is NOT running, so resolving it against the
   * running list would refuse every legitimate call. The name is still checkable.
   */
  it("checks launch_app by identity, not by resolution", async () => {
    const { prepareDispatch } = await load();
    const cold = await prepareDispatch("launch_app", { bundle_id: "com.apple.calculator" });
    expect(cold.ok, "an app that is not running must still be launchable").toBe(true);

    const self = await prepareDispatch("launch_app", { bundle_id: "com.electron.atlarix" });
    expect(self.ok).toBe(false);

    const term = await prepareDispatch("launch_app", { name: "Terminal" });
    expect(term.ok).toBe(false);
    if (!term.ok) expect(term.error).toMatch(/terminal or shell/i);
  });
});

describe("screen-absolute scope", () => {
  it("refuses both spellings before any target is looked at", async () => {
    const { prepareDispatch } = await load();
    for (const input of [
      { scope: "desktop", x: 10, y: 10 },
      { target: { kind: "desktop", display_id: "primary" }, x: 10, y: 10 },
    ]) {
      const r = await prepareDispatch("click", input);
      expect(r.ok, JSON.stringify(input)).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/Screen-absolute input/i);
    }
  });
});

describe("filesystem and process escape hatches", () => {
  /**
   * These reach the filesystem or another process from a tool whose parameters
   * contain no command — the terminal argument from `guards.ts`, arriving by a
   * different door.
   */
  const refused: Array<[string, Record<string, unknown>]> = [
    ["clipboard_write", { file_path: "/Users/me/.ssh/id_rsa" }],
    ["clipboard_write", { image_path: "/etc/passwd" }],
    ["launch_app", { bundle_id: "com.apple.calculator", additional_arguments: ["--evil"] }],
    ["launch_app", { bundle_id: "com.apple.calculator", webkit_inspector_port: 9222 }],
  ];
  for (const [tool, input] of refused) {
    it(`refuses ${tool} ${Object.keys(input).join("+")}`, async () => {
      const { prepareDispatch } = await load();
      const r = await prepareDispatch(tool, input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/Atlarix will not do this|supervised path/i);
    });
  }

  /**
   * THE ONE I GOT WRONG FIRST TIME. I refused `additional_arguments` and
   * `webkit_inspector_port` and let `urls` through, reasoning that opening a file in
   * an app is "close to `open`". The driver's description says what it is: "Optional
   * file paths or URLs to open with the app" — the same capability, and it composes
   * into a complete arbitrary file read via TextEdit → cmd+A → cmd+C →
   * clipboard_read, every step of which is otherwise allowed.
   */
  it("refuses launch_app urls, the arbitrary-file-read composition", async () => {
    const { prepareDispatch } = await load();
    const r = await prepareDispatch("launch_app", {
      bundle_id: "com.apple.TextEdit",
      urls: ["/Users/victim/.aws/credentials"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/read_file|supervised path/i);
  });

  it("still allows the ordinary form of each of those", async () => {
    const { prepareDispatch } = await load();
    expect((await prepareDispatch("clipboard_write", { text: "hello" })).ok).toBe(true);
    expect((await prepareDispatch("launch_app", { bundle_id: "com.apple.calculator" })).ok).toBe(
      true,
    );
  });

  it("refuses uploading local files to a page outright", async () => {
    const { prepareDispatch } = await load();
    const r = await prepareDispatch("browser_set_input_files", { files: ["/etc/passwd"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Do not retry/i);
  });

  it("strips the output paths it owns rather than refusing them", async () => {
    const { prepareDispatch } = await load();
    const r = await prepareDispatch("get_window_state", {
      pid: 100,
      screenshot_out_file: "/tmp/anywhere.png",
    });
    // Stripped, not refused: the model setting it is a mistake about ownership, and
    // we overwrite it regardless.
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.prepared.input).not.toHaveProperty("screenshot_out_file");
  });

  it("puts a download somewhere Atlarix chose", async () => {
    const { prepareDispatch } = await load();
    const r = await prepareDispatch("browser_download", {
      ref: undefined,
      destination_root: "/Users/me",
      confirm: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.prepared.input.destination_root).toContain("computer-downloads");
      expect(r.prepared.input.destination_root).not.toBe("/Users/me");
    }
  });
});

describe("typing", () => {
  it("refuses a secure field reached by ref", async () => {
    const { prepareDispatch } = await load();
    const ref = await mintRef(100, { role: "AXSecureTextField", label: "Password" });
    const r = await prepareDispatch("type_text", { ref, text: "hunter2" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/secure text field/i);
  });

  it("refuses a credential-looking field by name", async () => {
    const { prepareDispatch } = await load();
    const ref = await mintRef(100, { role: "AXTextField", label: "API key" });
    const r = await prepareDispatch("set_value", { ref, value: "sk-123" });
    expect(r.ok).toBe(false);
  });

  it("allows an ordinary field, and hands the driver the token", async () => {
    const { prepareDispatch } = await load();
    const ref = await mintRef(100, { role: "AXTextField", label: "Message" });
    const r = await prepareDispatch("type_text", { ref, text: "hello" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.prepared.input.element_token).toBe("tok-100");
      expect(r.prepared.input).not.toHaveProperty("ref");
      expect(r.prepared.input.pid).toBe(100);
    }
  });

  /**
   * The stated limitation. `guardTypeTarget` reads an element's ROLE; a coordinate
   * has no element, so pixel typing would be typing blind into what might be a
   * password box.
   */
  it("refuses typing at coordinates, and names the alternative", async () => {
    const { prepareDispatch } = await load();
    await noteRead(100);
    const r = await prepareDispatch("type_text", { pid: 100, x: 10, y: 10, text: "hi" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/needs a `ref`/);
      expect(r.error).toMatch(/computer.*action:"type"|pass a ref/is);
    }
  });

  it("does not demand a ref from clipboard_write, which types into nothing", async () => {
    const { prepareDispatch } = await load();
    expect((await prepareDispatch("clipboard_write", { text: "x" })).ok).toBe(true);
  });
});

describe("keys", () => {
  it("refuses cmd+Q through hotkey and allows cmd+C", async () => {
    const { prepareDispatch } = await load();
    await noteRead(100);
    const quit = await prepareDispatch("hotkey", { pid: 100, keys: ["cmd", "q"] });
    expect(quit.ok).toBe(false);
    const copy = await prepareDispatch("hotkey", { pid: 100, keys: ["cmd", "c"] });
    expect(copy.ok).toBe(true);
    if (copy.ok) expect(copy.prepared.input.keys).toEqual(["cmd", "c"]);
  });

  /** press_key carries a `modifiers` array, so it is a chord tool too. */
  it("refuses cmd+Q spelled as press_key with modifiers", async () => {
    const { prepareDispatch } = await load();
    await noteRead(100);
    const r = await prepareDispatch("press_key", { pid: 100, key: "q", modifiers: ["cmd"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not an allowed key combination/i);
  });

  it("translates our key names to the driver's on a bare press", async () => {
    const { prepareDispatch } = await load();
    await noteRead(100);
    const r = await prepareDispatch("press_key", { pid: 100, key: "enter" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.prepared.input.key).toBe("return");

    const sel = await prepareDispatch("press_key", { pid: 100, key: "select_all" });
    expect(sel.ok).toBe(true);
    if (sel.ok) {
      expect(sel.prepared.input.key).toBe("a");
      expect(sel.prepared.input.modifiers).toEqual(["cmd"]);
    }
  });

  it("rejects an unknown modifier on a modifier-click", async () => {
    const { prepareDispatch } = await load();
    await noteRead(100);
    const r = await prepareDispatch("click", { pid: 100, x: 1, y: 1, modifier: ["hyper"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not a modifier/i);
    // A real modifier-click is ordinary and must still work.
    const ok = await prepareDispatch("click", { pid: 100, x: 1, y: 1, modifier: ["cmd"] });
    expect(ok.ok).toBe(true);
  });
});

describe("pixels are paired with a read", () => {
  it("refuses a coordinate click on a window nothing has read", async () => {
    const { prepareDispatch } = await load();
    const r = await prepareDispatch("click", { pid: 100, x: 40, y: 60 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/without reading it first/i);
  });

  it("allows it once the window has been read", async () => {
    const { prepareDispatch } = await load();
    await noteRead(100);
    expect((await prepareDispatch("click", { pid: 100, x: 40, y: 60 })).ok).toBe(true);
  });

  it("never asks the question when a ref addresses the element", async () => {
    const { prepareDispatch } = await load();
    const ref = await mintRef(100, { role: "AXButton", label: "Send" });
    // No explicit noteRead: minting a ref IS the read.
    expect((await prepareDispatch("click", { ref })).ok).toBe(true);
  });

  it("refuses coordinates that name no application at all", async () => {
    const { prepareDispatch } = await load();
    // The driver would refuse this too, but only AFTER the read-pairing check had
    // silently not applied — "the next layer happens to catch it" is not a check.
    const r = await prepareDispatch("click", { x: 40, y: 60 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no application|whole-screen coordinate form/i);
  });

  /**
   * `drag` has NO `x`/`y` — its coordinates are from_x/from_y/to_x/to_y — and no
   * element_token either, so coordinates are its ONLY addressing form. A predicate
   * hardcoded to x/y was permanently false for the one act tool that can never
   * satisfy the policy by using a ref instead.
   */
  it("applies the policy to drag, whose coordinates are named differently", async () => {
    const { prepareDispatch } = await load();
    const blind = await prepareDispatch("drag", {
      pid: 100,
      from_x: 10,
      from_y: 20,
      to_x: 200,
      to_y: 30,
    });
    expect(blind.ok, "a blind drag must be refused like a blind click").toBe(false);
    if (!blind.ok) expect(blind.error).toMatch(/without reading it first/i);

    await noteRead(100);
    const seen = await prepareDispatch("drag", {
      pid: 100,
      from_x: 10,
      from_y: 20,
      to_x: 200,
      to_y: 30,
    });
    expect(seen.ok).toBe(true);
  });

  it("refuses on rung 4 regardless of the read", async () => {
    // Rung 4 is now a DECISION taken from rung 3 — `public-fallback` is what the
    // probe can actually report, and nothing ever produced the old "refuse".
    rung = "public-fallback";
    const { prepareDispatch } = await load();
    await noteRead(100);
    const r = await prepareDispatch("click", { pid: 100, x: 1, y: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unavailable on this machine/i);
  });
});

describe("nested window ids", () => {
  /**
   * The driver's `target` carries `window_id` alongside `pid`, and
   * `tool-catalogue.ts` advertises that shape as the supported addressing form. A
   * check written for top-level `window_id` alone never sees it — so a call could
   * name a vetted pid and OUR window in one object.
   */
  it("refuses our own window id nested inside target", async () => {
    const { prepareDispatch } = await load();
    const r = await prepareDispatch("press_key", {
      target: { kind: "window", pid: 100, window_id: "w-atlarix" },
      key: "return",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Atlarix's own window/i);
  });

  it("refuses a target whose two halves name different processes", async () => {
    const { prepareDispatch } = await load();
    // Slack's pid with Terminal's window: either a mistake or an attempt, and
    // forwarding it leaves the driver to decide which half wins.
    const r = await prepareDispatch("click", {
      target: { kind: "window", pid: 100, window_id: "w-term" },
      x: 1,
      y: 1,
    });
    expect(r.ok).toBe(false);
  });

  it("allows a target whose halves agree", async () => {
    const { prepareDispatch } = await load();
    await noteRead(100);
    const r = await prepareDispatch("click", {
      target: { kind: "window", pid: 100, window_id: "w-slack" },
      x: 1,
      y: 1,
    });
    expect(r.ok).toBe(true);
  });
});

describe("the two ref namespaces", () => {
  /**
   * THE COLLISION. Ours is `d3.7`, minted by computer_inspect and backed by a driver
   * element token we hold. The browser tools take `p<snapshot>:<index>`, minted by
   * get_browser_state and meaningful only to the driver. They look nothing alike and
   * arrive in the same field.
   *
   * The dispatcher translates OUR refs into `element_token`. Doing that to a page ref
   * refuses it as malformed — which would have broken every browser_click and
   * browser_type, i.e. the surface this tool mostly exists for.
   */
  it("passes a page ref through untouched", async () => {
    const { prepareDispatch } = await load();
    for (const tool of ["browser_click", "browser_type", "browser_pointer"]) {
      const r = await prepareDispatch(tool, { ref: "p1:4", text: "hi" });
      expect(r.ok, `${tool} refused a page ref`).toBe(true);
      if (!r.ok) continue;
      expect(r.prepared.input.ref).toBe("p1:4");
      expect(r.prepared.input).not.toHaveProperty("element_token");
    }
  });

  it("still translates our own ref on a desktop tool", async () => {
    const { prepareDispatch } = await load();
    const ref = await mintRef(100, { role: "AXButton", label: "Send" });
    const r = await prepareDispatch("click", { ref });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.prepared.input.element_token).toBe("tok-100");
  });

  it("refuses a desktop ref that does not resolve, rather than forwarding it", async () => {
    const { prepareDispatch } = await load();
    const r = await prepareDispatch("click", { ref: "d99.1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no longer held|not an element ref/i);
  });
});

describe("shape and plumbing", () => {
  it("strips the host-owned session rather than passing the model's", async () => {
    const { prepareDispatch } = await load();
    const r = await prepareDispatch("get_window_state", { pid: 100, session: "someone-elses" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.prepared.input).not.toHaveProperty("session");
  });

  it("rejects a non-object input without throwing", async () => {
    const { prepareDispatch } = await load();
    for (const bad of ["nonsense", 42, [1, 2]]) {
      const r = await prepareDispatch("list_apps", bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("clamps the tree walk to what a prompt can hold", async () => {
    const { prepareDispatch } = await load();
    // The driver's own default is ~2000 elements — its description names Electron
    // and Obsidian as producing 10k+ trees. `computer_inspect` caps at 400; this
    // path reaches the same tool and must not be the way round it.
    const big = await prepareDispatch("get_window_state", { pid: 100, max_elements: 5000 });
    expect(big.ok).toBe(true);
    if (big.ok) expect(big.prepared.input.max_elements).toBe(400);

    // A smaller ask is honoured rather than raised.
    const small = await prepareDispatch("get_window_state", { pid: 100, max_elements: 20 });
    expect(small.ok).toBe(true);
    if (small.ok) expect(small.prepared.input.max_elements).toBe(20);

    // And an omitted one still gets the ceiling, not the driver's default.
    const none = await prepareDispatch("get_window_state", { pid: 100 });
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.prepared.input.max_elements).toBe(400);
  });

  it("carries the lane and the self-filter flag through to the caller", async () => {
    const { prepareDispatch } = await load();
    const browser = await prepareDispatch("browser_navigate", { url: "https://example.com" });
    expect(browser.ok).toBe(true);
    if (browser.ok) expect(browser.prepared.spec.lane).toBe("browser");

    const list = await prepareDispatch("list_apps", {});
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.prepared.spec.selfFilterResult).toBe(true);
  });
});
