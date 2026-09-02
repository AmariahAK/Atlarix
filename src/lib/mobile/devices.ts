/**
 * Which device a call is about.
 *
 * The rule is the one `browser`'s `tab_id` already states, so the model is not
 * learning a second convention: with ONE device running you may omit the target;
 * with several, naming it is required. Guessing among several is the failure
 * that is expensive to notice — a tap lands on the wrong emulator and the agent
 * reads the unchanged screen of the right one and concludes its tap failed.
 */

import { runDeviceCli, IOS_UNSUPPORTED } from "./device-tools";

export type MobileDevice = {
  id: string;
  platform: "android" | "ios";
  /** Model or simulator name, for the activity label. */
  label: string;
};

/** `adb devices -l` → the booted Android devices/emulators. */
async function listAndroid(): Promise<MobileDevice[]> {
  const r = await runDeviceCli("adb", ["devices", "-l"], { timeoutMs: 8_000 });
  if (!r.ok) return [];
  const out: MobileDevice[] = [];
  for (const line of r.stdout.split(/\r?\n/).slice(1)) {
    const t = line.trim();
    if (!t) continue;
    const [id, state, ...rest] = t.split(/\s+/);
    // "offline" and "unauthorized" are NOT usable, and reporting them as
    // devices produces a target the very next call cannot drive.
    if (!id || state !== "device") continue;
    const model = rest.find((f) => f.startsWith("model:"))?.slice(6);
    out.push({
      id,
      platform: "android",
      label: model ? model.replace(/_/g, " ") : id,
    });
  }
  return out;
}

/** `simctl list devices booted` → the booted iOS Simulators. */
async function listIos(): Promise<MobileDevice[]> {
  const r = await runDeviceCli(
    "xcrun",
    ["simctl", "list", "devices", "booted", "-j"],
    { timeoutMs: 12_000 },
  );
  if (!r.ok) return [];
  try {
    const parsed = JSON.parse(r.stdout) as {
      devices?: Record<string, Array<{ udid?: string; name?: string; state?: string }>>;
    };
    const out: MobileDevice[] = [];
    for (const rows of Object.values(parsed.devices ?? {})) {
      for (const d of rows) {
        if (!d.udid || d.state !== "Booted") continue;
        out.push({ id: d.udid, platform: "ios", label: d.name || d.udid });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function listMobileDevices(): Promise<MobileDevice[]> {
  const [android, ios] = await Promise.all([listAndroid(), listIos()]);
  return [...android, ...ios];
}

export type ResolvedDevice =
  | { ok: true; device: MobileDevice }
  | { ok: false; error: string };

/**
 * Resolve the target device: the explicit `device` when given, else the only
 * running one.
 */
export async function resolveDevice(
  explicit?: string,
): Promise<ResolvedDevice> {
  const devices = await listMobileDevices();

  if (explicit) {
    const hit =
      devices.find((d) => d.id === explicit) ||
      // Accept the label too — the model sees labels in the list, and rejecting
      // the name it was just shown is a pointless round trip.
      devices.find((d) => d.label.toLowerCase() === explicit.toLowerCase());
    if (hit) return { ok: true, device: hit };
    return {
      ok: false,
      error:
        `No running device "${explicit}". ` +
        (devices.length
          ? `Running now: ${describeDevices(devices)}.`
          : "Nothing is running — start an Android emulator or an iOS Simulator first."),
    };
  }

  if (devices.length === 0) {
    return {
      ok: false,
      error:
        "No emulator or simulator is running. Start one (Android Studio's Device Manager, " +
        "or `xcrun simctl boot <name>` / Xcode), then retry. Tell the user if you cannot.",
    };
  }
  if (devices.length > 1) {
    return {
      ok: false,
      error:
        `${devices.length} devices are running, so \`device\` is required: ` +
        `${describeDevices(devices)}.`,
    };
  }
  return { ok: true, device: devices[0]! };
}

export function describeDevices(devices: MobileDevice[]): string {
  return devices.map((d) => `${d.id} (${d.platform}, ${d.label})`).join("; ");
}

/** The message for a capability iOS does not have. Empty for Android. */
export function iosGap(
  device: MobileDevice,
  kind: keyof typeof IOS_UNSUPPORTED,
): string | null {
  return device.platform === "ios" ? IOS_UNSUPPORTED[kind] : null;
}
