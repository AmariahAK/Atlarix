/**
 * Tier 3 of the computer-use read: OCR, for apps that expose no accessibility tree.
 *
 * # THE RULE THIS FILE EXISTS TO ENFORCE: OCR A WINDOW, NEVER THE DISPLAY
 *
 * Measured against Vision on 2026-09-04, same text at the same pixel size, only the
 * framing changed:
 *
 * | input | result |
 * |---|---|
 * | 3024×1890 full-screen capture, 24px labels | **1 word**, `"Epоnся"`, confidence **0.3** |
 * | 800×700 crop of the same pixels | **6/6 words**, confidence **1.0** |
 *
 * `minimumTextHeight` was NOT the limiter — 24/1890 is 0.0127, well above the 0.005
 * the helper sets. Vision downscales a large input internally, so on a full Retina
 * screen 12pt UI text drops below legibility before recognition starts. It returns
 * one nonsense observation rather than an empty list, **which is worse than nothing
 * because it looks like an answer** — a model would act on it.
 *
 * So this always asks the driver for a WINDOW region and never for the desktop, and
 * it adds the crop origin back so the coordinates it returns are screen
 * coordinates. `get_desktop_state` is the wrong input here, whatever it is called.
 *
 * # Coordinates
 *
 * The helper reports image pixels with `scale` alongside. Screen POINTS are what
 * everything else in the feature speaks — element bounds, the overlay, cua-driver's
 * own geometry — so the conversion happens here, once. Getting this wrong is a
 * half-position offset on Retina rather than an obvious failure, which is exactly
 * the kind of bug that survives a demo.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import log from "electron-log";
import { callDriver } from "./driver-session";
import { missingBinaryMessage, resolveComputerBinary } from "./resolve-binary";

const logger = log.scope("computer-use");

/** A recognised word, in SCREEN POINTS with a top-left origin. */
export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
}

export interface OcrResult {
  words: OcrWord[];
  /** The engine that produced this, for the tool's `note`. */
  engine: string;
  /** Backing scale of the capture, so a caller can reason about precision. */
  scale: number;
}

interface HelperWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
}
interface HelperReport {
  ok?: boolean;
  width?: number;
  height?: number;
  scale?: number;
  words?: HelperWord[];
  error?: string;
}

function runHelper(args: string[], timeoutMs = 45_000): Promise<HelperReport | { error: string }> {
  const bin = resolveComputerBinary("atlarix-cu");
  if (!bin) return Promise.resolve({ error: missingBinaryMessage("atlarix-cu") });
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const text = String(stdout || stderr || "");
      const start = text.search(/[{[]/);
      if (start < 0) {
        resolve({ error: err ? String(err.message) : "the OCR helper produced no JSON" });
        return;
      }
      try {
        const parsed = JSON.parse(text.slice(start)) as HelperReport;
        if (err && !parsed.error) parsed.error = String(err.message);
        resolve(parsed);
      } catch {
        resolve({ error: "the OCR helper produced unparseable output" });
      }
    });
  });
}

/**
 * Linux has no OS OCR engine, so that path is `tesseract` if the user has it.
 *
 * Kept in TypeScript rather than in `atlarix-cu` deliberately: it means the crate
 * needs only the two darwin triples plus windows, with no third `#![cfg]` body for
 * CI to type-check.
 *
 * TSV rather than plain text, because it carries per-word boxes and confidences —
 * plain output would give us a wall of text with no coordinates, which cannot drive
 * an action.
 */
function runTesseract(png: string): Promise<HelperReport | { error: string }> {
  return new Promise((resolve) => {
    execFile("tesseract", [png, "stdout", "tsv"], { timeout: 45_000 }, (err, stdout) => {
      if (err) {
        resolve({
          error:
            "Local OCR needs `tesseract`, which is not installed. Ask the user to install it " +
            "(`apt install tesseract-ocr` / `dnf install tesseract`). This is a platform " +
            "limitation, not a transient failure — do not retry.",
        });
        return;
      }
      const words: HelperWord[] = [];
      for (const line of String(stdout).split("\n").slice(1)) {
        // level page block par line word left top width height conf text
        const c = line.split("\t");
        if (c.length < 12 || c[0] !== "5") continue;
        const text = c[11]?.trim();
        if (!text) continue;
        words.push({
          text,
          x: Number(c[6]),
          y: Number(c[7]),
          w: Number(c[8]),
          h: Number(c[9]),
          conf: Math.max(0, Number(c[10])) / 100,
        });
      }
      resolve({ ok: true, words, scale: 1 });
    });
  });
}

/**
 * OCR one window.
 *
 * @param pid    the target process
 * @param window optional window id, when the app has several
 */
export async function ocrWindow(
  pid: number,
  window?: string,
): Promise<OcrResult | { error: string }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "atlarix-ocr-"));
  const shot = path.join(dir, "window.png");
  try {
    // A WINDOW-SCOPED capture. `--screenshot-out-file` keeps the image bytes out of
    // this process and out of the model's context entirely: the driver writes the
    // PNG, we hand the OCR helper a path, and only text comes back.
    let origin = { x: 0, y: 0 };
    let scale = 1;
    try {
      // FIELD NAMES READ FROM `cua-driver describe get_window_state`, not guessed —
      // an earlier draft of this file invented `window.bounds` / `window.scale` and
      // would have silently produced origin 0,0 and scale 1 on every call, i.e.
      // window-relative coordinates presented as screen coordinates.
      //
      // `include_accessibility_tree:false` skips the AX walk (documented as the
      // expensive part, up to 20 s). We only want the capture here — the tree is
      // tier 1's job, and paying for it twice would be pure latency.
      const state = (await callDriver(
        "get_window_state",
        {
          pid,
          ...(window ? { window_id: window } : {}),
          include_accessibility_tree: false,
        },
        { screenshotOutFile: shot },
      )) as {
        window_bounds?: { x?: number; y?: number; w?: number; h?: number };
        screenshot_scale?: number;
        degraded_reason?: string;
      };
      // The crop origin, so the words come back in SCREEN space. Without this every
      // coordinate is relative to a window nobody else measures from.
      const b = state?.window_bounds ?? {};
      origin = { x: Number(b.x ?? 0) || 0, y: Number(b.y ?? 0) || 0 };
      scale = Number(state?.screenshot_scale ?? 1) || 1;
    } catch (e) {
      return { error: `Could not capture the window to OCR: ${(e as Error).message}` };
    }

    const report =
      process.platform === "linux"
        ? await runTesseract(shot)
        : await runHelper(["ocr", "--in", shot, "--json"]);

    if ("error" in report && report.error) return { error: report.error };
    const words = (report as HelperReport).words ?? [];
    if (words.length === 0) {
      return {
        error:
          "OCR found no text in that window. If the window is mostly graphics that may be " +
          "correct; otherwise read it with the accessibility tree instead, which is cheaper " +
          "and exact.",
      };
    }

    // Image pixels → screen points, then + the window origin. One conversion, here.
    const conv = (n: number) => n / scale;
    logger.info(
      `[computer-use] OCR pid=${pid} words=${words.length} scale=${scale} ` +
        `origin=${origin.x},${origin.y}`,
    );
    return {
      engine: process.platform === "linux" ? "tesseract" : process.platform === "darwin" ? "macos-vision" : "windows-media-ocr",
      scale,
      words: words.map((w) => ({
        text: w.text,
        x: Math.round(origin.x + conv(w.x)),
        y: Math.round(origin.y + conv(w.y)),
        w: Math.round(conv(w.w)),
        h: Math.round(conv(w.h)),
        conf: w.conf,
      })),
    };
  } finally {
    // The capture may be several MB; never leave it behind.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Exported for the self-test probe: prove the OS engine works, headlessly. */
export async function ocrSelfTest(): Promise<{ ok: boolean; detail: string }> {
  if (process.platform === "linux") {
    return { ok: true, detail: "linux uses tesseract; no bundled engine to self-test" };
  }
  const report = await runHelper(["ocr", "--self-test"], 30_000);
  if ("error" in report && report.error) return { ok: false, detail: report.error };
  const got = (report as { got?: string }).got ?? "";
  return { ok: true, detail: `engine round-tripped ${JSON.stringify(got)}` };
}

/** Tests only. */
export function readFixtureForTests(p: string): Buffer {
  return readFileSync(p);
}
