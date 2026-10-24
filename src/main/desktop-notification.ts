/**
 * The one place a desktop notification is created.
 *
 * Written this way because of a real crash: `SIGSEGV / SI_KERNEL / 0x0` inside
 * `electron::NotificationPresenter::RemoveNotification`, unhandled, in the
 * BROWSER process — so it took the whole app down with no JS handler in the way.
 * Fedora 44, Electron 38.2.2.
 *
 * **Every call site used to drop its reference immediately.** The pattern was
 *
 *     const n = new Notification({...});
 *     n.on("click", ...);
 *     n.show();          // `n` is unreachable from here
 *
 * which lets V8 collect the wrapper while the OS notification is still on
 * screen. Collection runs `api::Notification`'s destructor, which tears the
 * native notification down through the presenter — racing the notification
 * daemon doing the same thing when it expires or the user dismisses it. That is
 * the exact double-teardown shape of the two crashes Electron has already fixed
 * ([#40461](https://github.com/electron/electron/issues/40461) via `close()` in
 * portal environments, and [#43040](https://github.com/electron/electron/pull/43040)
 * on Windows) — both landed long before 38, and neither guards the GC path.
 *
 * Linux is where it bites: libnotify daemons expire notifications after a few
 * seconds, so the window is open on essentially every notification, and Linux is
 * the only platform whose presenter frees this way.
 *
 * So: hold a reference until the notification is genuinely finished, and never
 * call `close()` ourselves.
 */

import { execFile } from "node:child_process";
import log from "electron-log";

const logger = log.scope("notification");

/**
 * LINUX BODIES ARE MARKUP. Electron hands the body to the notification daemon
 * as it is, and daemons that advertise "body-markup" (GNOME Shell, KDE, dunst,
 * mako…) parse it as Pango markup. A body like `A & <b>x</b> < y` then fails to
 * parse, and dunst falls back to stripping tags: "A & x < y", so anything that
 * looks like a tag ("<Button>") vanished from the notification (15.11.1, Electron
 * 43.4.1 + dunst, read off the D-Bus Notify call and the screen). So on Linux
 * the body's & < > are escaped, but ONLY for a daemon that says it parses
 * markup: one that doesn't would show "&amp;" literally.
 */
export function escapeNotificationMarkup(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Whether a GetCapabilities reply (gdbus's or dbus-send's output) lists "body-markup". */
export function capabilitiesListMarkup(reply: string): boolean {
  return /['"]body-markup['"]/.test(reply);
}

let linuxMarkup: Promise<boolean> | null = null;

/** Asked once per run: gdbus (GLib, beside GTK) or dbus-send; neither or no daemon → no. */
function daemonParsesMarkup(): Promise<boolean> {
  const ask = (cmd: string, args: string[]) =>
    new Promise<string>((resolve, reject) =>
      execFile(cmd, args, { timeout: 1500 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
    );
  const path = ["/org/freedesktop/Notifications", "org.freedesktop.Notifications.GetCapabilities"];
  return (linuxMarkup ??= ask("gdbus", [
    "call",
    "--session",
    "--dest",
    "org.freedesktop.Notifications",
    "--object-path",
    path[0]!,
    "--method",
    path[1]!,
  ])
    .catch(() =>
      ask("dbus-send", ["--session", "--print-reply", "--dest=org.freedesktop.Notifications", path[0]!, path[1]!]),
    )
    .then(capabilitiesListMarkup, () => false));
}

/** The body as this platform's presenter should get it. */
export async function notificationBody(
  body: string,
  platform: NodeJS.Platform = process.platform,
  parsesMarkup: () => Promise<boolean> = daemonParsesMarkup,
): Promise<string> {
  // Cut first, so an entity is never cut in half.
  const text = String(body).slice(0, 140);
  return platform === "linux" && (await parsesMarkup()) ? escapeNotificationMarkup(text) : text;
}

/**
 * Live notifications, held ONLY to keep them out of GC's reach.
 *
 * Not a cache and not state — nothing reads it. Deleting an entry is what
 * permits collection, so entries must be removed on every terminal event or
 * this becomes a slow leak instead of a crash.
 */
const live = new Set<Electron.Notification>();

export type DesktopNotificationOptions = {
  title: string;
  body: string;
  silent?: boolean;
  /** Run when the user clicks it. Errors here are swallowed — a bad handler
   * must not take down the browser process along with it. */
  onClick?: () => void;
};

/**
 * Show an OS notification, or do nothing if the platform cannot.
 *
 * Callers keep their own policy about WHEN to notify (focused window, user
 * setting, Do-Not-Disturb); this owns only the lifetime.
 */
export async function showDesktopNotification(
  options: DesktopNotificationOptions,
): Promise<void> {
  try {
    const { Notification } = await import("electron");
    // A Linux box with no notification daemon has no presenter at all. The
    // Linux-only updater notification skipped this check entirely.
    if (!Notification.isSupported()) return;

    const notification = new Notification({
      title: options.title,
      body: await notificationBody(options.body),
      silent: options.silent ?? false,
    });

    live.add(notification);
    // Both terminal events, because a notification the user never touches ends
    // at "close" and one the OS refuses ends at "failed". Missing either leaks.
    const release = () => {
      live.delete(notification);
    };
    notification.once("close", release);
    notification.once("failed", release);

    if (options.onClick) {
      notification.on("click", () => {
        try {
          options.onClick?.();
        } catch (e) {
          logger.warn("notification click handler threw:", e);
        }
      });
    }

    notification.show();
  } catch (e) {
    // Notifying is never important enough to fail a caller over.
    logger.warn("desktop notification failed:", e);
  }
}

/** Test seam — how many notifications are currently held against GC. */
export function liveNotificationCount(): number {
  return live.size;
}
