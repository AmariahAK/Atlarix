/**
 * v13.9.0 auto-updater helpers: version comparison, notify-only gating (don't
 * double-fire alongside electron-updater), and per-install capability.
 */
import { describe, it, expect } from "vitest";
import {
  isNewer,
  shouldRunNotifyOnlyCheck,
  canElectronUpdaterRun,
} from "@/main/update-helpers";

describe("isNewer", () => {
  it("compares the first three numeric parts", () => {
    expect(isNewer("13.9.0", "13.8.1")).toBe(true);
    expect(isNewer("13.8.1", "13.9.0")).toBe(false);
    expect(isNewer("14.0.0", "13.99.99")).toBe(true);
  });
  it("is false for equal versions", () => {
    expect(isNewer("13.9.0", "13.9.0")).toBe(false);
  });
  it("tolerates a leading v already stripped / missing parts", () => {
    expect(isNewer("13.9", "13.8.5")).toBe(true);
    expect(isNewer("13", "13.0.0")).toBe(false);
  });
});

describe("shouldRunNotifyOnlyCheck", () => {
  it("never runs in dev (unpackaged)", () => {
    expect(
      shouldRunNotifyOnlyCheck({ isPackaged: false, electronUpdaterActive: false }),
    ).toBe(false);
  });
  it("suppresses when electron-updater is active (no double banner)", () => {
    expect(
      shouldRunNotifyOnlyCheck({ isPackaged: true, electronUpdaterActive: true }),
    ).toBe(false);
  });
  it("runs as the bridge when electron-updater cannot (deb/rpm, mac-not-in-apps, feed fail)", () => {
    expect(
      shouldRunNotifyOnlyCheck({ isPackaged: true, electronUpdaterActive: false }),
    ).toBe(true);
  });
});

describe("canElectronUpdaterRun", () => {
  const base = {
    platform: "darwin" as NodeJS.Platform,
    isPackaged: true,
    isAppImage: false,
    isInApplicationsFolder: true,
  };

  it("ok on macOS in /Applications", () => {
    expect(canElectronUpdaterRun(base).ok).toBe(true);
  });
  it("unsupported on macOS outside /Applications, with a clear reason", () => {
    const r = canElectronUpdaterRun({ ...base, isInApplicationsFolder: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unsupported");
    expect(r.detail).toMatch(/Applications/);
  });
  it("ok on Windows", () => {
    expect(
      canElectronUpdaterRun({ ...base, platform: "win32", isInApplicationsFolder: false }).ok,
    ).toBe(true);
  });
  it("ok on Linux AppImage but not deb/rpm", () => {
    expect(
      canElectronUpdaterRun({ ...base, platform: "linux", isAppImage: true }).ok,
    ).toBe(true);
    const deb = canElectronUpdaterRun({
      ...base,
      platform: "linux",
      isAppImage: false,
    });
    expect(deb.ok).toBe(false);
    expect(deb.reason).toBe("unsupported");
  });
  it("not ok for an unpackaged dev build", () => {
    expect(canElectronUpdaterRun({ ...base, isPackaged: false }).ok).toBe(false);
  });
});
