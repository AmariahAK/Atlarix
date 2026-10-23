/**
 * The "Controlling your screen" pill window itself: Electron only, no app
 * imports, so a real-Electron check can load exactly what ships
 * (computer-indicator.ts decides when it shows).
 */
import { BrowserWindow } from "electron";

export const PILL_WIDTH = 340;
export const PILL_HEIGHT = 44;

/**
 * Where the pill's Stop link points. Not "#stop": on a data: page that is a
 * new top-frame navigation to a data: URL, which Chromium blocks before any
 * navigation event fires, so nothing ever saw the click (A5, found by ai-44).
 * An https URL on the reserved .invalid domain is allowed to start, reaches
 * will-navigate, and is cancelled there; nothing is ever fetched.
 */
export const STOP_URL = "https://atlarix.invalid/stop";

export function pillPage(shortcutLabel: string): string {
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;font:13px -apple-system,system-ui,"Segoe UI",sans-serif;-webkit-user-select:none;user-select:none}
.pill{box-sizing:border-box;height:100%;display:flex;align-items:center;gap:10px;padding:0 6px 0 14px;border-radius:22px;background:#151a17;color:#e8efe9;border:1px solid #2f3d34}
.dot{color:#34d399;font-size:10px}
.text{flex:1}
.key{color:#8fa396;font-size:11px}
a{color:#151a17;background:#e8efe9;border-radius:16px;padding:6px 12px;text-decoration:none;font-weight:600}
</style><div class="pill"><span class="dot">●</span><span class="text">Controlling your screen</span><span class="key">${shortcutLabel}</span><a id="stop" href="${STOP_URL}">Stop</a></div>`;
}

/** The pill, hidden until shown; `onStop` runs when its Stop is clicked. */
export function createPill(onStop: () => void, shortcutLabel: string): BrowserWindow {
  const w = new BrowserWindow({
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  // Never in a screenshot: the model must see the screen, not our notice on it.
  w.setContentProtection(true);
  w.setAlwaysOnTop(true, "screen-saver");
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Stop is a link to STOP_URL, so the pill needs no preload, script or IPC
  // channel: every navigation is cancelled here, and that one is the stop.
  w.webContents.on("will-navigate", (e, url) => {
    e.preventDefault();
    if (url === STOP_URL) onStop();
  });
  void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pillPage(shortcutLabel))}`);
  return w;
}
