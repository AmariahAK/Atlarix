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
import { createPill, PILL_HEIGHT, PILL_WIDTH } from "./computer-pill";

const logger = log.scope("computer-indicator");

export const STOP_ACCELERATOR = "Control+Alt+Escape";
/** Same quiet window after which the executor hands the screen back. */
const HIDE_AFTER_MS = 15_000;
const WIDTH = PILL_WIDTH;
const HEIGHT = PILL_HEIGHT;

const shortcutLabel = process.platform === "darwin" ? "⌃⌥Esc" : "Ctrl+Alt+Esc";

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
  win = createPill(stop, shortcutLabel);
  return win;
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
  if (win && !win.isDestroyed()) win.hide();
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
