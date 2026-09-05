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
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => "/tmp" },
}));
vi.mock("@/main/settings", () => ({ readSettings: () => ({}) }));

/** What the driver reports for the window we asked about. */
let windowState: unknown = {};
/** What the OCR helper found, in IMAGE PIXELS relative to the crop. */
let helperWords: Array<Record<string, number | string>> = [];
let capturedCall: { tool: string; input: Record<string, unknown> } | null = null;

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
      _bin: string,
      _args: string[],
      _opts: unknown,
      cb: (e: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, JSON.stringify({ ok: true, width: 800, height: 700, scale: 1, words: helperWords }), "");
    },
  };
});

const load = async () => await import("@/lib/computer/ocr");

beforeEach(() => {
  capturedCall = null;
  windowState = {};
  helperWords = [];
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
});
