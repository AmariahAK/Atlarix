/**
 * Locating and running the two device CLIs, plus the parity facts the tools
 * have to state rather than discover by failing.
 *
 * WHY A MODULE AND NOT A `execSync("which adb")` AT EACH CALL SITE
 * ----------------------------------------------------------------
 * `resolve-shell.ts` shells out to `which bash` once, at shell-resolution time.
 * A tool call is a much hotter path: an agent driving an emulator makes tens of
 * them per turn, and paying a process spawn per call to answer a question whose
 * answer cannot change mid-session is waste that shows up as latency the user
 * feels. So detection is memoized for the life of the process.
 *
 * The cache is invalidatable (`resetDeviceToolCacheForTests`) because a test
 * that installs a fake `adb` on PATH otherwise inherits whatever the first test
 * in the file observed.
 */

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import log from "electron-log";

const logger = log.scope("mobile");

export type DeviceCli = "adb" | "xcrun";

/** Where an SDK install puts `adb` when it is not on PATH. */
function androidSdkCandidates(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    home && path.join(home, "Library", "Android", "sdk"),
    home && path.join(home, "Android", "Sdk"),
    home && path.join(home, "AppData", "Local", "Android", "Sdk"),
  ].filter((r): r is string => Boolean(r));
  const exe = process.platform === "win32" ? "adb.exe" : "adb";
  return roots.map((r) => path.join(r, "platform-tools", exe));
}

const cache = new Map<DeviceCli, string | null>();

/**
 * Absolute path to a device CLI, or null when it is not installed.
 *
 * `xcrun` is macOS-only by definition, and short-circuits everywhere else
 * rather than spawning a doomed lookup.
 */
export function findDeviceCli(cli: DeviceCli): string | null {
  const cached = cache.get(cli);
  if (cached !== undefined) return cached;

  let resolved: string | null = null;
  if (cli === "xcrun") {
    resolved =
      process.platform === "darwin" && fs.existsSync("/usr/bin/xcrun")
        ? "/usr/bin/xcrun"
        : null;
  } else {
    // PATH first — a developer who manages their own SDK expects theirs used.
    const lookup = process.platform === "win32" ? "where" : "which";
    try {
      const out = execFileSync(lookup, ["adb"], {
        encoding: "utf8",
        timeout: 3_000,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split(/\r?\n/)[0]
        ?.trim();
      if (out && fs.existsSync(out)) resolved = out;
    } catch {
      // Not on PATH — fall through to the SDK's default locations.
    }
    if (!resolved) {
      resolved = androidSdkCandidates().find((c) => fs.existsSync(c)) ?? null;
    }
  }

  cache.set(cli, resolved);
  logger.info(`[mobile] ${cli}: ${resolved ?? "not found"}`);
  return resolved;
}

export function resetDeviceToolCacheForTests(): void {
  cache.clear();
}

/** stdout as text, or a structured failure. Never throws. */
export async function runDeviceCli(
  cli: DeviceCli,
  args: string[],
  opts?: { timeoutMs?: number; binary?: boolean },
): Promise<
  | { ok: true; stdout: string; buffer: Buffer }
  | { ok: false; error: string }
> {
  const bin = findDeviceCli(cli);
  if (!bin) return { ok: false, error: missingCliMessage(cli) };
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        timeout: opts?.timeoutMs ?? 20_000,
        // A `uiautomator dump` of a dense screen, or a PNG, both exceed the
        // 1MB default and would otherwise fail as ERR_CHILD_PROCESS_STDIO_MAXBUFFER.
        maxBuffer: 64 * 1024 * 1024,
        encoding: opts?.binary ? "buffer" : "utf8",
      } as never,
      (err, stdout, stderr) => {
        const buffer = Buffer.isBuffer(stdout)
          ? stdout
          : Buffer.from(String(stdout ?? ""), "utf8");
        if (err) {
          const detail =
            String(stderr ?? "").trim() || err.message || "unknown failure";
          resolve({ ok: false, error: `${cli} ${args[0] ?? ""}: ${detail}` });
          return;
        }
        resolve({ ok: true, stdout: buffer.toString("utf8"), buffer });
      },
    );
  });
}

export function missingCliMessage(cli: DeviceCli): string {
  if (cli === "adb") {
    return (
      "`adb` was not found. Install Android platform-tools (Android Studio → SDK Manager, " +
      "or `brew install --cask android-platform-tools`), or set ANDROID_HOME. " +
      "There is nothing to work around here — tell the user."
    );
  }
  return process.platform === "darwin"
    ? "`xcrun` was not found. Install Xcode command line tools (`xcode-select --install`)."
    : "iOS Simulators are macOS-only. Tell the user rather than retrying.";
}

/**
 * THE PARITY GAP, stated in one place because both tools have to report it.
 *
 * `simctl` can screenshot, stream logs and launch an app, and that is all. It
 * has no UI-hierarchy dump and no input injection — those need Facebook's `idb`,
 * which is a separate install with its own companion daemon.
 *
 * This is why the iOS message names the missing capability instead of returning
 * a generic failure: an agent told "not supported" stops, whereas an agent told
 * "failed" retries, and retrying a capability the platform does not have is an
 * expensive way to learn nothing.
 */
export const IOS_UNSUPPORTED = {
  hierarchy:
    "iOS Simulator has no UI-hierarchy dump: `simctl` cannot list elements, so there are no refs to act on. " +
    "Use mode:\"screenshot\" to see the screen, and drive the simulator by hand or via `idb` (a separate install) through run_command. " +
    "This is a platform limitation, not a transient failure — do not retry.",
  input:
    "iOS Simulator has no input injection via `simctl` — tap/type/swipe are not available, so there is nothing to address a ref to. " +
    "Android emulators support the full loop. This is a platform limitation, not a transient failure — do not retry.",
} as const;

/**
 * Quote one argument for the DEVICE's shell.
 *
 * WHY THIS IS NOT PARANOIA. `runDeviceCli` uses `execFile` with an argv array,
 * so there is no LOCAL shell to inject into. But `adb shell <args…>` joins its
 * remaining arguments with spaces and runs the result through the device's
 * `/system/bin/sh -c` — so `input text "a; rm -rf /sdcard/x"` runs `input text a`
 * and then `rm`, on the emulator. `execFile` does nothing about that: the shell
 * is on the far side of adb.
 *
 * It matters because the string is not always the model's own words. An agent
 * types what it READ — from a page, a file, a fixture it was asked to replay —
 * so this is the path by which prompt-injected content would reach a device
 * shell. The agent could already run `adb` through `run_command`, so this is not
 * an escalation of what it may do; it is about content it merely handled.
 *
 * Single quotes, with the standard `'\''` dance for an embedded one. Quoting
 * also removes the need for adb's `%s` space substitution — and is better than
 * it, because `%s` mangles a literal percent in the user's text.
 */
export function quoteForDeviceShell(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Android package / iOS bundle identifiers, which is all `launch` may take. */
const PACKAGE_ID = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function isValidPackageId(id: string): boolean {
  // Validated rather than quoted: anything outside this shape is a model
  // mistake worth reporting, not a string to pass through carefully.
  return id.length <= 255 && PACKAGE_ID.test(id);
}

/**
 * Test seam for the tap-feedback lifecycle.
 *
 * `vi.mock` cannot intercept it: `ensureTapFeedback` calls `runDeviceCli` from
 * inside this same module, so the call is a lexical binding and never goes
 * through the module's exports. Rather than contort the production call into an
 * indirection nobody needs, this is an explicit, documented seam — the same
 * shape as `setGlobalAtlarixDirForTests` in the permissions ruleset.
 *
 * Only the tap-feedback functions route through it, because they are the only
 * ones whose RESTRAINT (read before write, once per device, restore the exact
 * previous value) is worth asserting without a device.
 */
type DeviceCliRunner = typeof runDeviceCli;
let runnerOverride: DeviceCliRunner | null = null;

export function setDeviceCliRunnerForTests(r: DeviceCliRunner | null): void {
  runnerOverride = r;
}

function run(...args: Parameters<DeviceCliRunner>): ReturnType<DeviceCliRunner> {
  return (runnerOverride ?? runDeviceCli)(...args);
}

/**
 * TAP FEEDBACK — making Atlarix's taps watchable on the emulator.
 *
 * The browser has `ai-cursor.ts`: an injected overlay with a pointer, a ring on
 * the target and a chip naming the action, so `hover`/`key`/`scroll` can be
 * watched instead of inferred. That approach does not transfer — an emulator is
 * a separate OS-level window and we can only send it input events, never draw
 * on it.
 *
 * Android has its own version: the `show_touches` developer setting draws a
 * circle at every contact point. So the equivalent of the AI cursor is one
 * `settings put`, and it applies to taps we send exactly as it does to the
 * user's own.
 *
 * THE CARE POINTS, because this WRITES A SETTING on someone's device:
 *   - Once per device per process, on the first ACT. Never on a read: looking at
 *     a screen must not change it.
 *   - The previous value is captured first and restored on quit, so a device
 *     that had it off goes back to off.
 *   - Entirely best-effort. Every failure is swallowed: a visual nicety must
 *     never be the reason a tap fails.
 *   - Android only. iOS has no equivalent, and the act path returns the
 *     platform-gap message before reaching here anyway.
 */
const tapFeedback = new Map<string, string>();

export function tapFeedbackEnabledFor(deviceId: string): boolean {
  return tapFeedback.has(deviceId);
}

/**
 * Turn on the touch indicator, returning a one-line note the FIRST time (so the
 * activity row can say it happened) and null every time after.
 */
export async function ensureTapFeedback(
  deviceId: string,
  deviceLabel: string,
): Promise<string | null> {
  if (tapFeedback.has(deviceId)) return null;
  try {
    const read = await run(
      "adb",
      ["-s", deviceId, "shell", "settings", "get", "system", "show_touches"],
      { timeoutMs: 8_000 },
    );
    // "null" is what `settings get` prints for an unset key — record it as such
    // so restore removes the key rather than writing a literal "null" back.
    const previous = read.ok ? read.stdout.trim() : "null";
    if (previous === "1") {
      // Already on (the user's own choice). Remember that, so restore leaves it.
      tapFeedback.set(deviceId, "1");
      return null;
    }
    const put = await run(
      "adb",
      ["-s", deviceId, "shell", "settings", "put", "system", "show_touches", "1"],
      { timeoutMs: 8_000 },
    );
    if (!put.ok) return null;
    tapFeedback.set(deviceId, previous);
    logger.info(`[mobile] tap feedback on for ${deviceId} (was ${previous})`);
    return `Tap feedback enabled on ${deviceLabel} — you can watch each tap land. Restored when Atlarix quits.`;
  } catch {
    return null;
  }
}

/**
 * Put `show_touches` back. Called from the before-quit chain; safe to call with
 * nothing to restore, and never throws.
 */
export async function restoreTapFeedback(): Promise<void> {
  const entries = [...tapFeedback.entries()];
  tapFeedback.clear();
  await Promise.all(
    entries.map(async ([deviceId, previous]) => {
      // "1" means it was already the user's setting — leave it alone.
      if (previous === "1") return;
      try {
        const args =
          previous === "null" || previous === ""
            ? ["-s", deviceId, "shell", "settings", "delete", "system", "show_touches"]
            : ["-s", deviceId, "shell", "settings", "put", "system", "show_touches", previous];
        await run("adb", args, { timeoutMs: 5_000 });
      } catch {
        // The device may already be gone — that is the common case on quit, and
        // a stopped emulator keeps no settings anyway.
      }
    }),
  );
}

/**
 * Capture a simulator screenshot.
 *
 * WHY THIS IS NOT `io <id> screenshot -`. It looks like the adb equivalent
 * (`exec-out screencap -p`, which really does stream to stdout) and it is not:
 * `simctl` treats `-` as a FILENAME. Verified against a live iPhone 17
 * simulator — it exits 0, prints "Wrote screenshot to: …/-", writes nothing to
 * stdout, and leaves a junk file called `-` in the working directory. So the
 * tool returned a zero-byte "success" and littered the workspace, and only a
 * live run could show that.
 *
 * A temp file, read, then unlinked.
 */
export async function captureSimulatorScreenshot(
  deviceId: string,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; error: string }> {
  const file = path.join(
    os.tmpdir(),
    `atlarix-sim-${deviceId.slice(0, 8)}-${Date.now()}.png`,
  );
  try {
    const r = await run(
      "xcrun",
      ["simctl", "io", deviceId, "screenshot", file],
      { timeoutMs: 30_000 },
    );
    if (!r.ok) return { ok: false, error: r.error };
    const buffer = fs.readFileSync(file);
    if (buffer.length === 0) {
      return { ok: false, error: "simctl wrote an empty screenshot file." };
    }
    return { ok: true, buffer };
  } catch (e) {
    return {
      ok: false,
      error: `Could not read the screenshot simctl wrote: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone, or never written — nothing to clean up.
    }
  }
}

/**
 * The iOS log predicate, per level.
 *
 * `messageType >= "Default"` — the obvious spelling, and what this shipped with
 * — matches NOTHING. Measured on a live simulator: 0 characters where the
 * unfiltered query returned 18.7 MB. It is not an error, it is a silent zero, so
 * every iOS log read reported "No recent entries" no matter what had happened.
 *
 * Apple's unified log has no "warn": the types are Default, Info, Debug, Error
 * and Fault. So "warn" maps to Error-or-Fault, which is the honest nearest
 * equivalent, and equality is used because the comparison operator does not work
 * on this field.
 */
export function iosLogPredicate(level: string): string[] {
  if (level === "all") return [];
  return ["--predicate", 'messageType == "Error" OR messageType == "Fault"'];
}

/**
 * How far back to read. 2 minutes of a simulator's system log is 3.2 MB even
 * filtered to errors (measured); 30 seconds is 1.7 MB and answers "what just
 * went wrong", which is the actual question. A `process` filter takes the same
 * query to 3.5 KB, which is why it is worth offering.
 */
export const IOS_LOG_WINDOW = "30s";
