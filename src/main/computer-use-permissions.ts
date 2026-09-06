/**
 * macOS TCC preflight for computer use.
 *
 * There was no permission code in this repo at all before v14.43.0 — no
 * `systemPreferences`, no `desktopCapturer`, no `isTrustedAccessibilityClient`. So
 * this is greenfield, and the shape is worth stating.
 *
 * WHO ASKS. The driver never raises its own prompt: under `serve --embedded` its
 * `check_permissions` says so — *"these booleans reflect the HOST app's TCC grant
 * (the driver is a child in the host's responsibility chain). No separate driver
 * grant exists or is needed… the driver never raises its own prompt."* So the HOST
 * must ask, which is this file.
 *
 * WHY THE OS PROMPT IS THE REAL CONSENT GATE. There is deliberately no per-app
 * prompt inside Atlarix (owner's decision: any and all apps, with Atlarix itself
 * never a target). On macOS that is defensible precisely because nothing works
 * until the user grants Accessibility and Screen Recording to Atlarix by name, in
 * System Settings, revocably. On Windows and Linux there is no equivalent, and the
 * docs must say so rather than implying parity.
 *
 * WHAT NOT TO USE. `cua-driver permissions status` / `permissions grant` are the
 * daemon-PROXY path: status "answers via a running daemon, so the result carries
 * the CuaDriver identity (com.trycua.driver)" and reports `unknown` with no daemon;
 * grant "launches CuaDriver via LaunchServices so dialogs attribute to the app" —
 * i.e. to com.trycua.driver, the stranger-in-System-Settings outcome we rejected.
 * Never call those two. The `check_permissions` TOOL under `--embedded` is the one
 * that reports OUR grants, and it is the cross-check below.
 */
import { app, shell, systemPreferences } from "electron";
import log from "electron-log";

const logger = log.scope("computer-use");

export type GrantState = "granted" | "denied" | "not-determined" | "unsupported";

export interface ComputerUsePermissions {
  platform: NodeJS.Platform;
  accessibility: GrantState;
  screenRecording: GrantState;
  /** True once a grant has been observed changing, so the UI can offer a relaunch. */
  needsRelaunch: boolean;
}

/** Which System Settings pane to deep-link to for each grant. */
const PANES = {
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screenRecording:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
} as const;

export type PaneKey = keyof typeof PANES;

let relaunchOffered = false;
/** Last seen states, so we can notice a grant being turned on. */
let lastSeen: { accessibility?: GrantState; screenRecording?: GrantState } = {};

/**
 * Read both grants WITHOUT prompting.
 *
 * `isTrustedAccessibilityClient(false)` is the non-prompting form — passing `true`
 * shows the dialog, which must only happen from an explicit user action, never from
 * a status read. `DiagnosticsPanel` already sets that standard: nothing runs on
 * mount there, the button is the consent.
 */
export function readPermissions(): ComputerUsePermissions {
  if (process.platform !== "darwin") {
    // Windows and Linux have no TCC equivalent for this. Reporting "unsupported"
    // rather than "granted" keeps the UI honest: there is no OS gate here, which
    // is a fact about the platform and not a permission we hold.
    return {
      platform: process.platform,
      accessibility: "unsupported",
      screenRecording: "unsupported",
      needsRelaunch: false,
    };
  }

  const accessibility: GrantState = systemPreferences.isTrustedAccessibilityClient(false)
    ? "granted"
    : "denied";

  // There is no askForMediaAccess("screen"); getMediaAccessStatus is read-only.
  const raw = systemPreferences.getMediaAccessStatus("screen");
  const screenRecording: GrantState =
    raw === "granted"
      ? "granted"
      : raw === "denied" || raw === "restricted"
        ? "denied"
        : "not-determined";

  // macOS caches the ScreenCapture decision PER PROCESS, so a grant made while the
  // app is running does not take effect until it restarts. Notice the transition
  // and let the UI offer to do it — "granted, now restart" versus doing it for them
  // is the difference between working and "I granted it and nothing happened".
  const flippedOn =
    (lastSeen.accessibility && lastSeen.accessibility !== "granted" && accessibility === "granted") ||
    (lastSeen.screenRecording &&
      lastSeen.screenRecording !== "granted" &&
      screenRecording === "granted");
  if (flippedOn) relaunchOffered = true;
  lastSeen = { accessibility, screenRecording };

  return {
    platform: process.platform,
    accessibility,
    screenRecording,
    needsRelaunch: relaunchOffered,
  };
}

/**
 * Ask for one grant: prompt where macOS allows it, deep-link where it does not.
 *
 * # SCREEN RECORDING CANNOT BE PROMPTED FOR, AND PRETENDING OTHERWISE COST TWO DAYS
 *
 * This used to provoke it with a throwaway 1×1 `desktopCapturer.getSources()`.
 * Measured from the owner's own log, that call failed on EVERY attempt — fourteen
 * clicks across 2026-09-05 and 2026-09-06, all
 *
 *     provoking the screenRecording prompt failed: Failed to get sources.
 *
 * and it failed while `getMediaAccessStatus("screen")` reported **granted** and the
 * driver's own `check_permissions` reported `screen_recording: true`. So the grant
 * was real and the provocation was broken, which is the worst possible pairing: the
 * button did nothing, the row did not change, and the honest reading from the other
 * side of the screen was "I gave it permission and it still says no".
 *
 * Apple moved screen-capture consent to ScreenCaptureKit, and `desktopCapturer` no
 * longer raises the dialog. There is no Electron API that does. **The System
 * Settings pane IS the mechanism** — it always was, and the provocation attempt was
 * decoration on top of the thing that actually works.
 *
 * So Accessibility keeps its real prompting API, Screen Recording goes straight to
 * the pane, and nothing logs a failure for an operation we are no longer attempting.
 */
export async function requestPermission(which: PaneKey): Promise<ComputerUsePermissions> {
  if (process.platform !== "darwin") return readPermissions();

  if (which === "accessibility") {
    try {
      // `true` prompts AND opens the pane — the one grant macOS still lets an app
      // ask for directly.
      systemPreferences.isTrustedAccessibilityClient(true);
    } catch (e) {
      logger.warn(`[computer-use] the accessibility prompt failed:`, e);
    }
  }

  // Always deep-link. For Screen Recording it is the only route; for Accessibility
  // it is the fallback, because once a grant has been denied macOS will not ask a
  // second time and the pane is the only way forward.
  await openPrivacyPane(which);
  return readPermissions();
}

/**
 * Open a System Settings privacy pane.
 *
 * NOT through the `open-external-url` IPC. `validateOpenExternalUrl`
 * (`src/lib/external_url.ts`) permits only `mailto:`, `http://` and `https://` and
 * throws on anything else — so an `x-apple.systempreferences:` URL cannot go that
 * way. Widening that validator to admit a custom scheme would turn a narrow,
 * auditable allowlist into a general one, and the renderer would then be able to
 * ask the main process to open arbitrary URL schemes. Instead this takes a KEY, not
 * a URL: the renderer can name a pane, and cannot name a destination.
 */
export async function openPrivacyPane(which: PaneKey): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    await shell.openExternal(PANES[which]);
  } catch (e) {
    logger.warn(`[computer-use] could not open the ${which} pane:`, e);
  }
}

/** Relaunch, for the button the UI offers after a grant flips on. */
export function relaunchForPermissions(): void {
  logger.info("[computer-use] relaunching to pick up a new TCC grant");
  app.relaunch();
  app.quit();
}

/**
 * Compare what WE see against what the driver reports.
 *
 * This is the highest-signal diagnostic in the feature. Electron reports the grants
 * held by Atlarix; the driver's `check_permissions` reports what the driver runtime
 * sees, and under `serve --embedded` those must be THE SAME because the driver is a
 * child in our responsibility chain. If `attribution` is ever anything but `"host"`,
 * the chain is not what we think it is — grants would be attaching to a different
 * identity and would silently stop following Atlarix across updates.
 *
 * Logged at **warn** on disagreement rather than thrown: the feature still works in
 * the moment, and a hard failure here would take down a working app over a
 * diagnostic. The standing guard is that the line exists at all.
 */
export function crossCheckDriverAttribution(driverReport: unknown): void {
  const src = (driverReport as { source?: Record<string, unknown> } | null)?.source;
  if (!src) return;
  const attribution = String(src.attribution ?? "");
  if (attribution && attribution !== "host") {
    logger.warn(
      `[computer-use] cua-driver reports attribution="${attribution}", expected "host". ` +
        `TCC grants may not be following Atlarix's identity — see the Gate A note in ` +
        `docs/TODO.md before shipping.`,
    );
    return;
  }
  if (src.disclaim_env === true) {
    logger.warn(
      "[computer-use] cua-driver reports disclaim_env=true — it has disclaimed our " +
        "responsibility chain, so it is its own TCC subject. Grants will attach to " +
        "CuaDriver rather than Atlarix.",
    );
  }
}
