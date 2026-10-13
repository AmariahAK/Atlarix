import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { listMobileDevices, resolveDevice, iosGap } from "@/lib/mobile/devices";
import { runDeviceCli, findDeviceCli } from "@/lib/mobile/device-tools";

/** A booted simulator, or nothing to test. */
function hasBootedSimulator(): boolean {
  // Opt-in: just probing runs xcrun, and on a Mac whose Xcode hasn't finished
  // its first launch that starts `xcodebuild -runFirstLaunch`, which asks the
  // user for their password to install components (it did, overnight, on the
  // owner's screen during a full test run). ATLARIX_LIVE_IOS=1 to run these.
  if (process.env.ATLARIX_LIVE_IOS !== "1") return false;
  if (process.platform !== "darwin") return false;
  try {
    const out = execFileSync(
      "/usr/bin/xcrun",
      ["simctl", "list", "devices", "booted"],
      {
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    return /\(Booted\)/.test(out);
  } catch {
    return false;
  }
}

/**
 * These run against a REAL simulator and skip when there isn't one, so CI and
 * every machine without Xcode stay green. They are kept rather than deleted
 * because they are the only tests that found anything: the mocked suite passed
 * while `simctl io … screenshot -` silently wrote a file named `-` and the log
 * predicate matched nothing at all.
 *
 * To run them: `xcrun simctl boot <name>` first, then ATLARIX_LIVE_IOS=1.
 */
describe.skipIf(!hasBootedSimulator())("LIVE iOS simulator", () => {
  it("finds xcrun", () => {
    expect(findDeviceCli("xcrun")).toBe("/usr/bin/xcrun");
  });

  it("lists the booted simulator", async () => {
    const d = await listMobileDevices();
    console.log("[live] devices:", JSON.stringify(d));
    expect(d.length).toBeGreaterThan(0);
    expect(d[0]!.platform).toBe("ios");
  }, 30_000);

  it("resolves it implicitly as the only device", async () => {
    const r = await resolveDevice();
    console.log("[live] resolve:", JSON.stringify(r));
    expect(r.ok).toBe(true);
  }, 30_000);

  it("takes a REAL screenshot via the file path", async () => {
    const { captureSimulatorScreenshot } = await import(
      "@/lib/mobile/device-tools"
    );
    const d = await listMobileDevices();
    const r = await captureSimulatorScreenshot(d[0]!.id);
    console.log(
      "[live] screenshot ok=",
      r.ok,
      "bytes=",
      r.ok ? r.buffer.length : 0,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.buffer.length).toBeGreaterThan(1000);
      // PNG magic — proves it is a real image, not an error string.
      expect(r.buffer.subarray(0, 4).toString("hex")).toBe("89504e47");
    }
  }, 60_000);

  it("the log predicate MATCHES something (the silent-zero bug)", async () => {
    const { iosLogPredicate, IOS_LOG_WINDOW } = await import(
      "@/lib/mobile/device-tools"
    );
    const d = await listMobileDevices();
    const r = await runDeviceCli(
      "xcrun",
      [
        "simctl",
        "spawn",
        d[0]!.id,
        "log",
        "show",
        "--last",
        IOS_LOG_WINDOW,
        "--style",
        "compact",
        ...iosLogPredicate("warn"),
      ],
      { timeoutMs: 40_000 },
    );
    console.log("[live] warn-level chars=", r.ok ? r.stdout.length : r.error);
    expect(r.ok).toBe(true);
    // The old predicate returned exactly 0 here.
    if (r.ok) expect(r.stdout.length).toBeGreaterThan(0);
  }, 60_000);

  it("a process filter collapses the volume", async () => {
    const d = await listMobileDevices();
    const r = await runDeviceCli(
      "xcrun",
      [
        "simctl",
        "spawn",
        d[0]!.id,
        "log",
        "show",
        "--last",
        "30s",
        "--style",
        "compact",
        "--predicate",
        'process CONTAINS "SpringBoard" AND (messageType == "Error" OR messageType == "Fault")',
      ],
      { timeoutMs: 40_000 },
    );
    console.log("[live] filtered chars=", r.ok ? r.stdout.length : r.error);
    expect(r.ok).toBe(true);
  }, 60_000);

  it("reports the hierarchy/input gaps as limitations", async () => {
    const d = await listMobileDevices();
    console.log("[live] hierarchy gap:", iosGap(d[0]!, "hierarchy"));
    expect(iosGap(d[0]!, "hierarchy")).toMatch(/do not retry/i);
    expect(iosGap(d[0]!, "input")).toMatch(/do not retry/i);
  }, 30_000);

  it("reads logs without hanging", async () => {
    const d = await listMobileDevices();
    const r = await runDeviceCli(
      "xcrun",
      [
        "simctl",
        "spawn",
        d[0]!.id,
        "log",
        "show",
        "--last",
        "2m",
        "--style",
        "compact",
      ],
      { timeoutMs: 30_000 },
    );
    console.log(
      "[live] logs ok=",
      r.ok,
      "chars=",
      r.ok ? r.stdout.length : r.error,
    );
    expect(r.ok).toBe(true);
  }, 60_000);
});
