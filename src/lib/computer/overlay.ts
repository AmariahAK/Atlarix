/**
 * Green outlines on the element the agent is about to touch.
 *
 * # Two layers, and this is the second
 *
 * cua-driver already draws a per-session CURSOR showing where it acts — on by
 * default, and available to us because we run `serve` (the overlay is documented as
 * "serve only — needs the daemon UI runloop"). That is layer 1 and it ships
 * regardless of anything here.
 *
 * It cannot outline an ELEMENT, though: `cursor-theme build` takes a `.lottie`
 * source, so a theme animates a pointer. The owner asked for outlines on the
 * elements being used, so we draw those ourselves. The two compose — the driver's
 * cursor says where, our outline says what.
 *
 * # Reusing the browser's visual language, deliberately
 *
 * `src/lib/browser/ai-cursor.ts` already defines what "the agent is about to touch
 * this" looks like inside the in-app browser: `#34d399`, a 2px ring at 6px radius,
 * a soft `0 0 0 4px rgba(52,211,153,.22)` halo. Using the same marks means the
 * desktop and the in-app browser read as one product rather than two features that
 * happen to ship together.
 *
 * # Best-effort, always
 *
 * Every call is guarded and nothing here can fail an action. That is the
 * tap-feedback doctrine from the mobile tools: a visual nicety must never be the
 * reason a tap fails. It is also why the overlay is created lazily and torn down on
 * quit — a transparent always-on-top window is not something to leave lying around.
 *
 * # What is NOT verified
 *
 * Whether a transparent click-through window actually renders above other apps on
 * every OS and compositor. macOS is the one this was written against. Windows
 * cannot cover a fullscreen-exclusive DirectX window. On Linux it is feature-
 * detected off entirely: without a compositor a transparent window paints BLACK
 * over the user's screen, which is far worse than no overlay, and on Wayland a
 * client cannot position windows globally at all.
 */
import { BrowserWindow, screen } from "electron";
import log from "electron-log";
import { readSettings } from "@/main/settings";

const logger = log.scope("computer-use");

/** Matches `ai-cursor.ts`, so the desktop and the in-app browser look alike. */
const ACCENT = "#34d399";
const HALO = "rgba(52,211,153,.22)";
/** How long an outline stays up before fading on its own. */
const DWELL_MS = 900;

let overlay: BrowserWindow | null = null;
let hideTimer: NodeJS.Timeout | null = null;

function overlayEnabled(): boolean {
  try {
    // Uncached read, so the Settings toggle takes effect immediately.
    const s = readSettings();
    if (s.computerUse === false) return false;
    return s.computerUseConfig?.overlay !== false;
  } catch {
    return true;
  }
}

/**
 * Can we even draw one here?
 *
 * Linux is the case that matters: a transparent window with no compositor paints
 * black over whatever is behind it, and on Wayland a client cannot place a window
 * in global screen coordinates. Both produce something worse than nothing, so
 * neither gets an overlay.
 */
function overlaySupported(): boolean {
  if (process.platform === "darwin" || process.platform === "win32") return true;
  if (process.env.XDG_SESSION_TYPE === "wayland") return false;
  // A compositing X11 session is the only Linux case where this is safe, and there
  // is no reliable way to detect one from here — so require an explicit opt-in
  // rather than risk painting black over someone's screen.
  return process.env.ATLARIX_COMPUTER_OVERLAY_X11 === "1";
}

function ensureOverlay(): BrowserWindow | null {
  if (overlay && !overlay.isDestroyed()) return overlay;
  if (!overlaySupported()) return null;
  try {
    const display = screen.getPrimaryDisplay();
    const { x, y, width, height } = display.bounds;
    const win = new BrowserWindow({
      x,
      y,
      width,
      height,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // Or it shows up in Alt-Tab and the Dock, which for a decoration is absurd.
      skipTaskbar: true,
      // NEVER focusable. Focus-stealing would defeat the entire premise of a
      // background computer-use feature — the user is supposed to keep typing.
      focusable: false,
      show: false,
      // macOS: a panel floats above normal windows without joining the window
      // cycle. Ignored elsewhere.
      type: process.platform === "darwin" ? "panel" : undefined,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    // Above everything, including full-screen apps.
    win.setAlwaysOnTop(true, "screen-saver");
    // Clicks pass straight through to the app underneath. Without `forward`, hover
    // effects in the app below stop working while the overlay is up.
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    void win.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          `<!doctype html><meta charset="utf-8">
           <style>
             html,body{margin:0;height:100%;background:transparent;overflow:hidden}
             #box{position:fixed;box-sizing:border-box;border:2px solid ${ACCENT};
                  border-radius:6px;box-shadow:0 0 0 4px ${HALO};opacity:0;
                  transition:opacity .18s ease;pointer-events:none}
             #chip{position:fixed;padding:2px 7px;border-radius:999px;
                   background:rgba(6,78,59,.92);color:#ecfdf5;font:600 11px/1.4
                   ui-sans-serif,system-ui,-apple-system,sans-serif;opacity:0;
                   transition:opacity .18s ease;pointer-events:none;white-space:nowrap}
           </style>
           <div id="box"></div><div id="chip"></div>`,
        ),
    );
    overlay = win;
    return win;
  } catch (e) {
    logger.warn("[computer-use] could not create the overlay window:", e);
    return null;
  }
}

/**
 * Outline one element, in SCREEN POINTS.
 *
 * The caller converts: element frames are window-relative, and OCR boxes are image
 * pixels needing the same `scale` division. Getting that wrong is a half-position
 * offset on Retina — plausible-looking, and invisible in a demo.
 */
export function showOutline(rect: {
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
}): void {
  if (!overlayEnabled()) return;
  const win = ensureOverlay();
  if (!win || win.isDestroyed()) return;
  try {
    const display = screen.getPrimaryDisplay().bounds;
    // Window-local CSS pixels: the overlay covers the display, so subtract its origin.
    const left = Math.round(rect.x - display.x);
    const top = Math.round(rect.y - display.y);
    const js = `
      (() => {
        const b = document.getElementById("box"), c = document.getElementById("chip");
        if (!b) return;
        b.style.left = ${JSON.stringify(`${left}px`)};
        b.style.top = ${JSON.stringify(`${top}px`)};
        b.style.width = ${JSON.stringify(`${Math.max(2, Math.round(rect.w))}px`)};
        b.style.height = ${JSON.stringify(`${Math.max(2, Math.round(rect.h))}px`)};
        b.style.opacity = "1";
        if (c) {
          c.textContent = ${JSON.stringify(rect.label ?? "")};
          c.style.left = ${JSON.stringify(`${left}px`)};
          c.style.top = ${JSON.stringify(`${Math.max(0, top - 22)}px`)};
          c.style.opacity = ${rect.label ? '"1"' : '"0"'};
        }
      })();`;
    if (!win.isVisible()) win.showInactive(); // NEVER show()/focus().
    void win.webContents.executeJavaScript(js, true).catch(() => {});
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => hideOutline(), DWELL_MS);
  } catch (e) {
    logger.warn("[computer-use] overlay draw failed (ignored):", e);
  }
}

export function hideOutline(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (!overlay || overlay.isDestroyed()) return;
  try {
    void overlay.webContents
      .executeJavaScript(
        `(() => { for (const id of ["box","chip"]) { const e = document.getElementById(id); if (e) e.style.opacity = "0"; } })();`,
        true,
      )
      .catch(() => {});
  } catch {
    /* best effort */
  }
}

/** Torn down from the `before-quit` chain, alongside the daemon. */
export function destroyOverlay(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  const win = overlay;
  overlay = null;
  try {
    if (win && !win.isDestroyed()) win.destroy();
  } catch {
    /* already gone */
  }
}

/** Tests only. */
export function overlayStateForTests(): { exists: boolean; supported: boolean } {
  return { exists: overlay !== null, supported: overlaySupported() };
}
