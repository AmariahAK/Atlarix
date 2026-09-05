/**
 * The OCR coordinate conversion, pinned — because getting it wrong is a
 * HALF-POSITION OFFSET on a Retina display, not a visible failure. Every click
 * lands somewhere plausible but wrong, which is exactly the class of bug that
 * survives a demo and ships.
 *
 * Two conversions happen in `ocrWindow`, in this order:
 *   1. image pixels → screen points  (divide by the capture's backing scale)
 *   2. window-relative → screen      (add the window's origin)
 *
 * And the framing rule those numbers depend on: the capture is a WINDOW, never the
 * display. Measured 2026-09-04 — a 3024×1890 full-screen capture of 24px labels
 * gave 1 nonsense word at confidence 0.3, while an 800×700 crop of the same pixels
 * gave 6/6 at confidence 1.0. So the coordinates are always window-relative on the
 * way in, and this is where they become screen coordinates.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => "/tmp" },
}));
vi.mock("@/main/settings", () => ({ readSettings: () => ({}) }));

/** Grants, so the coordinate tests exercise arithmetic and not a preflight. */
let permissions = {
  platform: "darwin",
  accessibility: "granted",
  screenRecording: "granted",
  needsRelaunch: false,
};
vi.mock("@/main/computer-use-permissions", () => ({
  readPermissions: () => permissions,
}));

/**
 * `ocrWindow` now REQUIRES the capture to exist before handing its path to the
 * helper, because `get_window_state` succeeds with Screen Recording denied and
 * silently writes no image — the bug that reported `cannot read <path>: No such
 * file or directory` to the model instead of naming the permission. The driver is
 * mocked here and writes nothing, so stat has to be mocked alongside it.
 */
let captureSize = 4096;
vi.mock("node:fs", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    statSync: (p: string, ...rest: unknown[]) =>
      String(p).includes("atlarix-ocr")
        ? { size: captureSize }
        : (actual.statSync as (...a: unknown[]) => unknown)(p, ...rest),
  };
});

/** What the driver reports for the window we asked about. */
let windowState: unknown = {};
/** What the OCR helper found, in IMAGE PIXELS relative to the crop. */
let helperWords: Array<Record<string, number | string>> = [];
let capturedCall: { tool: string; input: Record<string, unknown> } | null = null;
/** Which binary the OCR path actually shelled out to — the platform branch, observed. */
let capturedExec: string | null = null;

vi.mock("@/lib/computer/driver-session", () => ({
  callDriver: vi.fn(async (tool: string, input: Record<string, unknown>) => {
    capturedCall = { tool, input };
    return windowState;
  }),
}));

vi.mock("@/lib/computer/resolve-binary", () => ({
  resolveComputerBinary: () => "/fake/atlarix-cu",
  missingBinaryMessage: () => "not installed",
}));

// Stand in for the helper process: emit the report `ocrWindow` would have parsed.
vi.mock("node:child_process", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    execFile: (
      bin: string,
      _args: string[],
      _opts: unknown,
      cb: (e: Error | null, stdout: string, stderr: string) => void,
    ) => {
      capturedExec = bin;
      cb(null, JSON.stringify({ ok: true, width: 800, height: 700, scale: 1, words: helperWords }), "");
    },
  };
});

const load = async () => await import("@/lib/computer/ocr");

/**
 * PIN THE PLATFORM, or this file tests different code depending on who runs it.
 *
 * `ocrWindow` branches on `process.platform`: Linux has no OS OCR engine and goes
 * to `tesseract`, every other platform to the bundled helper. Left unpinned, the
 * four coordinate tests below exercised the helper on a dev Mac and tesseract on
 * the Linux CI runner — and the `node:child_process` mock fed its JSON report into
 * tesseract's TSV parser, which found no words, which is indistinguishable from
 * "this window genuinely has no text". So the arithmetic this file exists to pin
 * was never exercised in CI at all, and the failure only surfaced once the whole
 * suite ran on Linux. Set it explicitly per test instead.
 */
const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

beforeEach(() => {
  capturedCall = null;
  capturedExec = null;
  windowState = {};
  helperWords = [];
  captureSize = 4096;
  permissions = {
    platform: "darwin",
    accessibility: "granted",
    screenRecording: "granted",
    needsRelaunch: false,
  };
  setPlatform("darwin");
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("ocrWindow coordinates", () => {
  it("adds the window origin so words come back in SCREEN space", async () => {
    const { ocrWindow } = await load();
    windowState = { window_bounds: { x: 300, y: 150 }, screenshot_scale: 1 };
    helperWords = [{ text: "Save", x: 20, y: 40, w: 60, h: 18, conf: 0.99 }];

    const res = await ocrWindow(1234);
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    // Without the origin, a caller would click 300,150 points away from the target.
    expect(res.words[0]).toMatchObject({ text: "Save", x: 320, y: 190, w: 60, h: 18 });
  });

  it("divides by the backing scale — the Retina half-position bug", async () => {
    const { ocrWindow } = await load();
    // A 2x capture: the helper's pixels are twice the screen points.
    windowState = { window_bounds: { x: 0, y: 0 }, screenshot_scale: 2 };
    helperWords = [{ text: "Export", x: 200, y: 400, w: 120, h: 36, conf: 1 }];

    const res = await ocrWindow(1234);
    if ("error" in res) throw new Error(res.error);
    // 200px @2x = 100pt. Skipping this division puts every click at DOUBLE the
    // intended offset, which looks like a plausible position and is not.
    expect(res.words[0]).toMatchObject({ x: 100, y: 200, w: 60, h: 18 });
    expect(res.scale).toBe(2);
  });

  it("composes both conversions in the right order", async () => {
    const { ocrWindow } = await load();
    windowState = { window_bounds: { x: 500, y: 250 }, screenshot_scale: 2 };
    helperWords = [{ text: "OK", x: 100, y: 60, w: 40, h: 20, conf: 1 }];

    const res = await ocrWindow(1234);
    if ("error" in res) throw new Error(res.error);
    // Scale FIRST, then translate: 100/2 + 500 = 550, not (100 + 500)/2 = 300.
    expect(res.words[0]).toMatchObject({ x: 550, y: 280 });
  });

  it("asks for ONE WINDOW, never the desktop", async () => {
    const { ocrWindow } = await load();
    windowState = { window_bounds: { x: 0, y: 0 }, screenshot_scale: 1 };
    helperWords = [{ text: "x", x: 1, y: 1, w: 5, h: 5, conf: 1 }];

    await ocrWindow(4242, "win-7");

    // The measurement above is the reason: a full-screen capture returns garbage
    // that looks like an answer. If this ever becomes get_desktop_state, OCR
    // silently degrades to one nonsense word.
    expect(capturedCall?.tool).toBe("get_window_state");
    expect(capturedCall?.tool).not.toBe("get_desktop_state");
    expect(capturedCall?.input).toMatchObject({
      pid: 4242,
      window_id: "win-7",
      // The cheap path: OCR wants the capture, not the 20-second AX walk.
      include_accessibility_tree: false,
    });
  });

  it("says so when OCR finds nothing, instead of returning an empty success", async () => {
    const { ocrWindow } = await load();
    windowState = { window_bounds: { x: 0, y: 0 }, screenshot_scale: 1 };
    helperWords = [];

    const res = await ocrWindow(1);
    expect("error" in res).toBe(true);
    if (!("error" in res)) return;
    // It must point at the cheaper, exact alternative rather than just failing.
    expect(res.error).toMatch(/accessibility tree/i);
  });

  it("defaults a missing scale to 1 rather than NaN-ing every coordinate", async () => {
    const { ocrWindow } = await load();
    windowState = { window_bounds: { x: 10, y: 10 } }; // no screenshot_scale reported
    helperWords = [{ text: "a", x: 30, y: 30, w: 10, h: 10, conf: 1 }];

    const res = await ocrWindow(1);
    if ("error" in res) throw new Error(res.error);
    expect(res.words[0]).toMatchObject({ x: 40, y: 40 });
    expect(Number.isFinite(res.words[0]!.x)).toBe(true);
  });

  it("routes by platform: the bundled helper everywhere, tesseract on Linux", async () => {
    // The crate has no Linux body — it builds for two darwin triples plus windows —
    // so tesseract is the ONLY OCR Linux has. Asserting the binary by name is what
    // stops this file silently testing the wrong path on a Linux runner again.
    const { ocrWindow } = await load();
    windowState = { window_bounds: { x: 0, y: 0 }, screenshot_scale: 1 };
    helperWords = [{ text: "Save", x: 20, y: 40, w: 60, h: 18, conf: 1 }];

    await ocrWindow(1234);
    expect(capturedExec).toBe("/fake/atlarix-cu");

    capturedExec = null;
    setPlatform("linux");
    await ocrWindow(1234);
    expect(capturedExec).toBe("tesseract");
  });

  it("names Screen Recording when the capture never lands — the WhatsApp failure", async () => {
    // OBSERVED 2026-09-05 on a packaged build: `get_window_state` returned real
    // bounds and scale (the window server needs no grant) and wrote no image, so
    // the missing path reached the OCR helper and the model was told
    // `cannot read …/window.png: No such file or directory (os error 2)`. It then
    // retried, tried another app, shelled out to `screencapture`, and hit the
    // terminal refusal — four turns routing around an ungranted dialog.
    const { ocrWindow } = await load();
    permissions.screenRecording = "denied";
    captureSize = 0; // the driver wrote nothing
    windowState = { window_bounds: { x: 0, y: 0 }, screenshot_scale: 1 };

    const res = await ocrWindow(1234);
    expect("error" in res).toBe(true);
    if (!("error" in res)) return;
    expect(res.error).toMatch(/Screen Recording/);
    expect(res.error).toMatch(/RESTART/);
    expect(res.error).not.toMatch(/No such file or directory/);
  });

  it("does NOT blame permissions when the grant is held but the capture is empty", async () => {
    // Same symptom, different cause. Telling the user to grant something they
    // already granted is its own dead end.
    const { ocrWindow } = await load();
    captureSize = 0;
    windowState = { window_bounds: { x: 0, y: 0 }, screenshot_scale: 1 };

    const res = await ocrWindow(1234);
    expect("error" in res).toBe(true);
    if (!("error" in res)) return;
    expect(res.error).toMatch(/minimised or on another Space/i);
    // It DOES mention Screen Recording — to say it is already granted, which
    // preempts the wrong fix. What it must not do is ask for a grant, so assert
    // on the category-2 tail rather than on the words.
    expect(res.error).toMatch(/Screen Recording is granted/);
    expect(res.error).not.toContain("Ask the user to do that and retry ONCE");
  });
});
