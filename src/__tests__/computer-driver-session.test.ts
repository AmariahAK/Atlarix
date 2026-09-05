/**
 * The computer-use daemon layer, with the privacy-critical part pinned first.
 *
 * cua-driver sends telemetry BY DEFAULT and registers on the first run of ANY
 * subcommand — a persistent installation ID is generated and transmitted. Atlarix's
 * README says "no file contents are sent as telemetry" and sells the app as the
 * Private AI Workstation, so the opt-out must be on disk BEFORE the first spawn.
 * Running `telemetry disable` afterwards is too late: that command is itself an
 * invocation. That ordering is the thing these tests exist to hold.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// `electron` is not available in the node test env, and the module reads
// app.isPackaged / getPath. Mock it before importing anything that touches it.
const fakeUserData = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-cu-ud-"));
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: (k: string) => (k === "userData" ? fakeUserData : os.tmpdir()),
  },
}));

let fakeSettings: Record<string, unknown> = {};
vi.mock("@/main/settings", () => ({
  readSettings: () => fakeSettings,
}));

let homeSpy: ReturnType<typeof vi.spyOn>;
let fakeHome: string;

const load = async () => await import("@/lib/computer/driver-session");

beforeEach(() => {
  fakeSettings = {};
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-cu-home-"));
  homeSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
});

afterEach(async () => {
  homeSpy.mockRestore();
  fs.rmSync(fakeHome, { recursive: true, force: true });
  const m = await load();
  m.resetDriverSessionForTests();
});

describe("telemetry opt-out", () => {
  it("writes {telemetry_enabled:false} where the driver reads it", async () => {
    const { ensureTelemetryOptOut, telemetryOptOutPath, telemetryIsOptedOut } = await load();
    expect(telemetryIsOptedOut()).toBe(false);

    ensureTelemetryOptOut();

    const file = telemetryOptOutPath();
    expect(file).toBe(path.join(fakeHome, ".cua-driver", "config.json"));
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ telemetry_enabled: false });
    expect(telemetryIsOptedOut()).toBe(true);
  });

  it("preserves other keys the driver keeps in that file", async () => {
    const { ensureTelemetryOptOut, telemetryOptOutPath } = await load();
    const file = telemetryOptOutPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ cursor_theme: "cua.default", other: 1 }));

    ensureTelemetryOptOut();

    // Clobbering the driver's own settings to write ours would be a rude fix.
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      cursor_theme: "cua.default",
      other: 1,
      telemetry_enabled: false,
    });
  });

  it("repairs a file that has telemetry ENABLED", async () => {
    const { ensureTelemetryOptOut, telemetryIsOptedOut, telemetryOptOutPath } = await load();
    const file = telemetryOptOutPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ telemetry_enabled: true }));

    ensureTelemetryOptOut();
    expect(telemetryIsOptedOut()).toBe(true);
  });

  it("survives a corrupt config rather than throwing", async () => {
    const { ensureTelemetryOptOut, telemetryIsOptedOut, telemetryOptOutPath } = await load();
    const file = telemetryOptOutPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    expect(() => ensureTelemetryOptOut()).not.toThrow();
    expect(telemetryIsOptedOut()).toBe(true);
  });

  it("is idempotent — a second call performs no write", async () => {
    const { ensureTelemetryOptOut } = await load();
    ensureTelemetryOptOut();
    // Count the write rather than inspecting the file. An mtime comparison would
    // pass for the wrong reason when both writes land in the same millisecond, and
    // a sentinel appended to the file is not a fair test either — it makes the JSON
    // invalid, so the function is then RIGHT to rewrite it. (Found that out by
    // writing it the wrong way first.)
    const spy = vi.spyOn(fs, "writeFileSync");
    try {
      ensureTelemetryOptOut();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the enable gate", () => {
  it("defaults ON — the owner's decision is no prompt, available by default", async () => {
    const { computerUseEnabled } = await load();
    fakeSettings = {};
    expect(computerUseEnabled()).toBe(true);
    fakeSettings = { computerUse: true };
    expect(computerUseEnabled()).toBe(true);
  });

  it("is off only when explicitly false", async () => {
    const { computerUseEnabled } = await load();
    fakeSettings = { computerUse: false };
    expect(computerUseEnabled()).toBe(false);
  });

  it("refuses with the setting reason, and tells the model not to retry", async () => {
    const { ensureDaemon } = await load();
    fakeSettings = { computerUse: false };
    await expect(ensureDaemon()).rejects.toMatchObject({
      reason: "disabled-by-setting",
      message: expect.stringMatching(/do not retry before they confirm/i),
    });
  });
});

describe("the socket path", () => {
  it("fits inside SUN_LEN under userData", async () => {
    const { socketPath } = await load();
    const p = socketPath();
    if (process.platform !== "win32") {
      // The limit that actually bites: a long path fails at bind with
      // "path must be shorter than SUN_LEN", from inside a child process, which
      // reads like a driver bug rather than a path problem.
      expect(Buffer.byteLength(p)).toBeLessThan(104);
      expect(p.endsWith("cua.sock")).toBe(true);
    } else {
      expect(p.startsWith("\\\\.\\pipe\\atlarix-cua-")).toBe(true);
    }
  });
});

describe("missing binaries", () => {
  it("says there is nothing to work around, so the model stops", async () => {
    const { missingBinaryMessage } = await import("@/lib/computer/resolve-binary");
    const msg = missingBinaryMessage("cua-driver");
    expect(msg).toMatch(/not present in this build/i);
    expect(msg).toMatch(/do not retry/i);
  });

  it("points Linux OCR at tesseract instead of claiming a broken build", async () => {
    const { missingBinaryMessage } = await import("@/lib/computer/resolve-binary");
    const msg = missingBinaryMessage("atlarix-cu");
    if (process.platform === "linux") {
      expect(msg).toMatch(/tesseract/i);
      expect(msg).toMatch(/platform limitation/i);
    } else {
      expect(msg).toMatch(/not present in this build/i);
    }
  });
});

describe("the start budget", () => {
  it("refuses a third start rather than respawning forever", async () => {
    const m = await load();
    m.resetDriverSessionForTests();
    m.exhaustStartBudgetForTests();
    expect(m.driverSessionStateForTests().startCount).toBeGreaterThanOrEqual(2);

    // With the budget gone, `ensureDaemon` must refuse — we retry the DAEMON, never
    // the ACTION, and after one restart the problem is the helper, not the call.
    // (It only reaches that check when a binary resolves; on a machine without one
    // the not-installed refusal comes first, which is also correct.)
    await expect(m.ensureDaemon()).rejects.toMatchObject({
      reason: expect.stringMatching(/killed|not-installed/),
    });
  });
});
