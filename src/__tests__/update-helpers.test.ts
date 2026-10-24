/**
 * v13.9.0 auto-updater helpers: version comparison, notify-only gating (don't
 * double-fire alongside electron-updater), and per-install capability.
 */
import { describe, it, expect } from "vitest";
import {
  isNewer,
  shouldRunNotifyOnlyCheck,
  canElectronUpdaterRun,
  chooseUpdaterKind,
  readLinuxPackageType,
} from "@/main/update-helpers";
import path from "node:path";

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
      shouldRunNotifyOnlyCheck({
        isPackaged: false,
        electronUpdaterActive: false,
      }),
    ).toBe(false);
  });
  it("suppresses when electron-updater is active (no double banner)", () => {
    expect(
      shouldRunNotifyOnlyCheck({
        isPackaged: true,
        electronUpdaterActive: true,
      }),
    ).toBe(false);
  });
  it("runs as the bridge when electron-updater cannot (deb/rpm, mac-not-in-apps, feed fail)", () => {
    expect(
      shouldRunNotifyOnlyCheck({
        isPackaged: true,
        electronUpdaterActive: false,
      }),
    ).toBe(true);
  });
  // The bridge exists to point users at a GitHub download. For a Microsoft Store
  // install that is a downgrade, and the Store already handles updates.
  it("suppresses for a Microsoft Store (MSIX) install", () => {
    expect(
      shouldRunNotifyOnlyCheck({
        isPackaged: true,
        electronUpdaterActive: false,
        isWindowsStore: true,
      }),
    ).toBe(false);
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
      canElectronUpdaterRun({
        ...base,
        platform: "win32",
        isInApplicationsFolder: false,
      }).ok,
    ).toBe(true);
  });
  it("ok on Linux AppImage, deb and rpm; any other Linux install gets the bridge", () => {
    const linux = { ...base, platform: "linux" as NodeJS.Platform };
    expect(canElectronUpdaterRun({ ...linux, isAppImage: true }).ok).toBe(true);
    expect(
      canElectronUpdaterRun({ ...linux, linuxPackageType: "deb" }).ok,
    ).toBe(true);
    expect(
      canElectronUpdaterRun({ ...linux, linuxPackageType: "rpm" }).ok,
    ).toBe(true);
    const other = canElectronUpdaterRun({ ...linux, linuxPackageType: null });
    expect(other.ok).toBe(false);
    expect(other.reason).toBe("unsupported");
  });
  it("not ok for an unpackaged dev build", () => {
    expect(canElectronUpdaterRun({ ...base, isPackaged: false }).ok).toBe(
      false,
    );
  });
});

describe("readLinuxPackageType", () => {
  it("reads deb/rpm from resources/package-type, the file electron-updater reads", () => {
    const at = (content: string) => (file: string) => {
      expect(file).toBe(
        path.join("/usr/lib/atlarix/resources", "package-type"),
      );
      return content;
    };
    expect(
      readLinuxPackageType("/usr/lib/atlarix/resources", at("deb\n")),
    ).toBe("deb");
    expect(readLinuxPackageType("/usr/lib/atlarix/resources", at("rpm"))).toBe(
      "rpm",
    );
    expect(
      readLinuxPackageType("/usr/lib/atlarix/resources", at("pacman")),
    ).toBeNull();
    expect(
      readLinuxPackageType("/x", () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });
});

describe("chooseUpdaterKind", () => {
  const base = {
    platform: "darwin" as NodeJS.Platform,
    isPackaged: true,
    isAppImage: false,
    isInApplicationsFolder: true,
  };

  it("Windows (packaged) → squirrel (Squirrel.Windows, not electron-updater)", () => {
    expect(
      chooseUpdaterKind({
        ...base,
        platform: "win32",
        isInApplicationsFolder: false,
      }),
    ).toBe("squirrel");
  });
  it("macOS in /Applications → electron-updater", () => {
    expect(chooseUpdaterKind(base)).toBe("electron-updater");
  });
  it("Linux AppImage, deb, rpm → electron-updater; anything else → none", () => {
    const linux = { ...base, platform: "linux" as NodeJS.Platform };
    expect(chooseUpdaterKind({ ...linux, isAppImage: true })).toBe(
      "electron-updater",
    );
    expect(chooseUpdaterKind({ ...linux, linuxPackageType: "deb" })).toBe(
      "electron-updater",
    );
    expect(chooseUpdaterKind({ ...linux, linuxPackageType: "rpm" })).toBe(
      "electron-updater",
    );
    expect(chooseUpdaterKind({ ...linux, linuxPackageType: null })).toBe(
      "none",
    );
  });
  it("macOS outside /Applications → none (notify bridge handles it)", () => {
    expect(chooseUpdaterKind({ ...base, isInApplicationsFolder: false })).toBe(
      "none",
    );
  });
  it("unpackaged dev build → none on every platform", () => {
    expect(chooseUpdaterKind({ ...base, isPackaged: false })).toBe("none");
    expect(
      chooseUpdaterKind({ ...base, platform: "win32", isPackaged: false }),
    ).toBe("none");
  });

  // An MSIX install is packaged win32, so without an explicit check it would be
  // handed to Squirrel — which writes into C:\Program Files\WindowsApps, a
  // READ-ONLY location. The Store owns updates for these installs.
  it("Microsoft Store (MSIX) → none, beating the win32 → squirrel branch", () => {
    expect(
      chooseUpdaterKind({
        ...base,
        platform: "win32",
        isInApplicationsFolder: false,
        isWindowsStore: true,
      }),
    ).toBe("none");
  });
  it("isWindowsStore omitted or false leaves Windows on squirrel", () => {
    expect(
      chooseUpdaterKind({ ...base, platform: "win32", isWindowsStore: false }),
    ).toBe("squirrel");
    expect(chooseUpdaterKind({ ...base, platform: "win32" })).toBe("squirrel");
  });
});
