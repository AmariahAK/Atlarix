/**
 * While a model controls the screen (desktop app): a small pill at the top of
 * the main display saying so, with Stop, and a stop shortcut, Ctrl+Option+Esc
 * on macOS and Ctrl+Alt+Esc elsewhere (clear of Force Quit and Task Manager).
 *
 * The pill is hidden from screen capture (content protection, macOS and
 * Windows 10 2004+), so the model never sees it in its own screenshots. The
 * shortcut exists only while the pill shows. Both stop the turn exactly as the
 * Stop button does. Moving the mouse stops it too (the executor's check); that
 * one works on every surface.
 */
import { BrowserWindow, globalShortcut, screen } from "electron";
import log from "electron-log";
import { computerActivity } from "@/lib/tools/computer";

const logger = log.scope("computer-indicator");

export const STOP_ACCELERATOR = "Control+Alt+Escape";
/** Same quiet window after which the executor hands the screen back. */
const HIDE_AFTER_MS = 15_000;
const WIDTH = 340;
const HEIGHT = 44;

const shortcutLabel = process.platform === "darwin" ? "⌃⌥Esc" : "Ctrl+Alt+Esc";

const PAGE = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;font:13px -apple-system,system-ui,"Segoe UI",sans-serif;-webkit-user-select:none;user-select:none}
.pill{box-sizing:border-box;height:100%;display:flex;align-items:center;gap:10px;padding:0 6px 0 14px;border-radius:22px;background:#151a17;color:#e8efe9;border:1px solid #2f3d34}
.dot{color:#34d399;font-size:10px}
.text{flex:1}
.key{color:#8fa396;font-size:11px}
a{color:#151a17;background:#e8efe9;border-radius:16px;padding:6px 12px;text-decoration:none;font-weight:600}
</style><div class="pill"><span class="dot">●</span><span class="text">Controlling your screen</span><span class="key">${shortcutLabel}</span><a href="#stop">Stop</a></div>`;

let win: BrowserWindow | null = null;
let stopCurrent: (() => void) | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function stop(): void {
  const s = stopCurrent;
  hide();
  s?.();
}

function pill(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  const w = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
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
  // Stop is a link to "#stop": an in-page navigation, so the pill needs no
  // preload, no script and no IPC channel.
  w.webContents.on("did-navigate-in-page", (_e, url) => {
    if (url.endsWith("#stop")) stop();
  });
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  win = w;
  return w;
}

function show(): void {
  clearTimeout(hideTimer);
  const w = pill();
  const area = screen.getPrimaryDisplay().workArea;
  w.setBounds({ x: Math.round(area.x + (area.width - WIDTH) / 2), y: area.y + 8, width: WIDTH, height: HEIGHT });
  if (!w.isVisible()) w.showInactive();
  if (!globalShortcut.isRegistered(STOP_ACCELERATOR)) {
    if (!globalShortcut.register(STOP_ACCELERATOR, stop)) {
      logger.warn(`${STOP_ACCELERATOR} is taken by another app; Stop and moving the mouse still work`);
    }
  }
}

function hide(): void {
  clearTimeout(hideTimer);
  stopCurrent = undefined;
  if (globalShortcut.isRegistered(STOP_ACCELERATOR)) globalShortcut.unregister(STOP_ACCELERATOR);
  if (win && !win.isDestroyed()) {
    // Back to "#" so the next Stop click navigates again.
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
    win.hide();
  }
}

let started = false;

export function initComputerIndicator(): void {
  if (started) return;
  started = true;
  computerActivity.on("start", ({ stop: s }: { stop?: () => void }) => {
    if (s) stopCurrent = s;
    show();
  });
  computerActivity.on("end", () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_AFTER_MS);
  });
}
