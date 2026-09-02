/**
 * Device targeting: the rule, and the messages it produces.
 *
 * The rule is deliberately the one `browser`'s `tab_id` already states — omit it
 * with one device, name it with several — so this is also a check that the two
 * tools do not teach two conventions.
 *
 * `runDeviceCli` is mocked because the alternative is an emulator, and the thing
 * under test is the DECISION, not `adb`. The device half is verified by hand
 * against a real emulator (see docs/TODO.md).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const calls: string[][] = [];
let adbDevicesOut = "";
let simctlOut = '{"devices":{}}';

vi.mock("@/lib/mobile/device-tools", () => ({
  runDeviceCli: vi.fn(async (cli: string, args: string[]) => {
    calls.push([cli, ...args]);
    if (cli === "adb" && args[0] === "devices") {
      return { ok: true, stdout: adbDevicesOut, buffer: Buffer.from("") };
    }
    if (cli === "xcrun") {
      return { ok: true, stdout: simctlOut, buffer: Buffer.from("") };
    }
    return { ok: true, stdout: "", buffer: Buffer.from("") };
  }),
  findDeviceCli: () => "/fake/adb",
  missingCliMessage: () => "missing",
  quoteForDeviceShell: (a: string) => `'${a}'`,
  isValidPackageId: () => true,
  ensureTapFeedback: async () => null,
  restoreTapFeedback: async () => {},
  IOS_UNSUPPORTED: {
    hierarchy: "iOS Simulator has no UI-hierarchy dump: no refs. Do not retry.",
    input: "iOS Simulator has no input injection via `simctl`. Do not retry.",
  },
}));

const { resolveDevice, listMobileDevices, iosGap } = await import(
  "@/lib/mobile/devices"
);

beforeEach(() => {
  calls.length = 0;
  adbDevicesOut = "";
  simctlOut = '{"devices":{}}';
});

const ANDROID_ONE =
  "List of devices attached\nemulator-5554\tdevice product:sdk_gphone64 model:Pixel_7 device:emu64\n";

describe("mobile device targeting", () => {
  it("uses the only running device without being told", () => {
    adbDevicesOut = ANDROID_ONE;
    return resolveDevice().then((r) => {
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.device.id).toBe("emulator-5554");
        // Underscores in the adb model field read badly in an activity label.
        expect(r.device.label).toBe("Pixel 7");
      }
    });
  });

  it("REQUIRES a target once several are running, and lists them", async () => {
    adbDevicesOut =
      ANDROID_ONE +
      "emulator-5556\tdevice product:sdk_gphone64 model:Pixel_Tablet device:emu64\n";
    const r = await resolveDevice();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Guessing is the expensive failure: the tap lands on one emulator and the
      // agent reads the other, concluding the tap did nothing.
      expect(r.error).toMatch(/2 devices are running/);
      expect(r.error).toContain("emulator-5554");
      expect(r.error).toContain("emulator-5556");
    }
  });

  it("ignores offline and unauthorized devices, which cannot be driven", async () => {
    adbDevicesOut =
      "List of devices attached\nemulator-5554\toffline\nR58M12\tunauthorized\n";
    expect(await listMobileDevices()).toEqual([]);
    // And so the message is the no-device one, not a "pick one of these" that
    // names a target the next call would fail on.
    const r = await resolveDevice();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/No emulator or simulator is running/);
  });

  it("accepts the label as well as the id", async () => {
    adbDevicesOut = ANDROID_ONE;
    const r = await resolveDevice("Pixel 7");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.device.id).toBe("emulator-5554");
  });

  it("names what IS running when an explicit target is wrong", async () => {
    adbDevicesOut = ANDROID_ONE;
    const r = await resolveDevice("emulator-9999");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("emulator-9999");
      expect(r.error).toContain("emulator-5554");
    }
  });

  it("lists booted iOS Simulators and skips shutdown ones", async () => {
    simctlOut = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-0": [
          { udid: "ABC-123", name: "iPhone 15", state: "Booted" },
          { udid: "DEF-456", name: "iPhone SE", state: "Shutdown" },
        ],
      },
    });
    const devices = await listMobileDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ id: "ABC-123", platform: "ios" });
  });

  it("survives simctl printing something that is not JSON", async () => {
    simctlOut = "xcrun: error: unable to find utility";
    expect(await listMobileDevices()).toEqual([]);
  });

  it("reports the iOS gap as a LIMITATION, not a failure", () => {
    const ios = { id: "ABC", platform: "ios" as const, label: "iPhone 15" };
    const android = { id: "emu", platform: "android" as const, label: "Pixel" };
    // The wording matters: an agent told "not supported" stops; an agent told
    // "failed" retries, and retrying a missing platform capability is an
    // expensive way to learn nothing.
    expect(iosGap(ios, "hierarchy")).toMatch(/Do not retry/i);
    expect(iosGap(ios, "input")).toMatch(/Do not retry/i);
    expect(iosGap(android, "input")).toBeNull();
  });
});
