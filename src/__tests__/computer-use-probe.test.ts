/**
 * The `computer-use` self-test probe, and specifically WHAT IT IS ALLOWED TO FAIL
 * FOR.
 *
 * This exists because of a real CI failure on 2026-09-05. `build-windows` went red
 * with `Command failed: cua-driver.exe doctor --json`, and the build was fine — the
 * driver had reported `UIA health probe exceeded 2000ms; falling back to Win32-only
 * window tools`, which is CORRECT on a runner with no interactive desktop session,
 * and exited non-zero to say the environment is unhealthy. The probe used
 * `execFileSync`, which throws on any non-zero exit, so it turned a true statement
 * about the machine into a failed release build.
 *
 * The distinction the probe has to hold:
 *   - the SCHEMA of `doctor --json` is ours to assert — an upstream change there
 *     silently disables our permission preflight;
 *   - the HEALTH it reports is a fact about the machine, and CI can never be
 *     healthy by this measure. That belongs in the notes, which is the pattern the
 *     `sandbox` probe already uses for its skipped assertions.
 *
 * A fatal SIGNAL is a third thing and still fails loudly: that is the
 * provisioned-entitlement class that shipped a broken signed v14.35.0, where
 * `codesign -v` calls the bundle valid and the kernel refuses to exec it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const DOCTOR_JSON = JSON.stringify({
  ok: true,
  probes: [{ label: "binary" }, { label: "telemetry" }],
});

/** Per-invocation results, keyed by the first argument the probe passes. */
let results: Record<
  string,
  { status: number | null; signal: string | null; stdout: string }
>;

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => "/tmp" },
}));

vi.mock("@/lib/computer/resolve-binary", () => ({
  resolveComputerBinary: (name: string) =>
    name === "cua-driver" ? "/fake/cua-driver" : null,
  missingBinaryMessage: () => "not installed",
}));

vi.mock("@/lib/computer/driver-session", () => ({
  ensureTelemetryOptOut: vi.fn(),
  telemetryIsOptedOut: () => true,
  telemetryOptOutPath: () => "/fake/.cua-driver/config.json",
}));

vi.mock("node:child_process", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    spawnSync: (_bin: string, args: string[]) => {
      const r = results[args[0]!] ?? { status: 0, signal: null, stdout: "" };
      return { ...r, stderr: "", error: undefined };
    },
    execFileSync: (_bin: string, args: string[]) => {
      const r = results[args[0]!];
      if (!r) return "";
      if (r.status !== 0) throw new Error(`Command failed: ${args.join(" ")}`);
      return r.stdout;
    },
  };
});

import { DEFAULT_PROBES } from "@/main/self-test";

const probe = () => {
  const p = DEFAULT_PROBES.find((x) => x.name === "computer-use");
  if (!p) throw new Error('no probe named "computer-use" — was DEFAULT_PROBES renamed?');
  return p;
};

beforeEach(() => {
  results = {
    "--version": { status: 0, signal: null, stdout: "cua-driver 0.23.2\n" },
    "list-tools": {
      status: 0,
      signal: null,
      stdout: Array.from({ length: 56 }, (_, i) => `tool_${i}: does a thing`).join("\n"),
    },
    doctor: { status: 0, signal: null, stdout: DOCTOR_JSON },
    describe: {
      status: 0,
      signal: null,
      stdout:
        "elements element_index element_token window_bounds screenshot_scale running",
    },
  };
});

describe("computer-use probe", () => {
  it("passes on a healthy machine and reports the version and tool count", async () => {
    const detail = await probe().run();
    expect(String(detail)).toContain("cua-driver 0.23.2");
    expect(String(detail)).toContain("56 tools");
  });

  it("does NOT fail when doctor exits non-zero — that is the machine, not the build", async () => {
    // The exact Windows CI case: no interactive desktop session, so UIA cannot
    // start, and the driver says so honestly by exiting non-zero.
    results.doctor = { status: 1, signal: null, stdout: DOCTOR_JSON };

    const detail = await probe().run();
    expect(String(detail)).toMatch(/doctor: exit 1 \(environment, not the build\)/);
  });

  it("notes an unhealthy doctor that produced no report at all", async () => {
    results.doctor = { status: 1, signal: null, stdout: "" };
    const detail = await probe().run();
    expect(String(detail)).toMatch(/doctor: unhealthy here \(exit 1, no report\)/);
  });

  it("STILL fails when doctor exits 0 and prints no JSON — a real contract break", async () => {
    // A clean exit with no report means the schema moved under us, which would
    // silently disable the permission preflight. That must not be a note.
    results.doctor = { status: 0, signal: null, stdout: "all good!" };
    await expect(probe().run()).rejects.toThrow(/exited 0 but produced no JSON/);
  });

  it("STILL fails when doctor's probes array is gone", async () => {
    results.doctor = { status: 0, signal: null, stdout: JSON.stringify({ ok: true }) };
    await expect(probe().run()).rejects.toThrow(/schema moved/);
  });

  it("fails LOUDLY on a fatal signal, naming the provisioned-entitlement class", async () => {
    // v14.35.0: `codesign -v` reports such a bundle valid and the kernel SIGKILLs
    // it on exec, with no output and nothing in the system log. A signal is the
    // only observable, so the message has to say where to look.
    results["--version"] = { status: null, signal: "SIGKILL", stdout: "" };
    await expect(probe().run()).rejects.toThrow(/entitlement/i);
  });

  it("fails when the tool surface collapses, but tolerates an upstream bump", async () => {
    results["list-tools"] = { status: 0, signal: null, stdout: "only_one: x" };
    await expect(probe().run()).rejects.toThrow(/only 1 tools/);

    results["list-tools"] = {
      status: 0,
      signal: null,
      stdout: Array.from({ length: 120 }, (_, i) => `t${i}: x`).join("\n"),
    };
    // A floor, not equality — an upstream addition must not block a release.
    await expect(probe().run()).resolves.toBeTruthy();
  });

  it("fails when the driver contract lacks a field the runtime reads", async () => {
    // The point of this assertion: a missing field NEVER throws at runtime.
    // `ocrWindow` reads window_bounds/screenshot_scale with `?? 0` / `?? 1`
    // defaults, so its absence silently yields origin 0,0 and scale 1 — window
    // pixels presented as screen points, which looks like success and clicks in
    // the wrong place. We shipped exactly that once by guessing the field names.
    results.describe = {
      status: 0,
      signal: null,
      stdout: "elements element_index element_token running", // no coordinates
    };
    await expect(probe().run()).rejects.toThrow(/window_bounds|screenshot_scale/);
  });

  it("fails when a tool the runtime depends on is absent on this platform", async () => {
    // The driver's surface is per-platform — its own docs say "List macOS apps"
    // and the Windows build reports a different tool count.
    results.describe = { status: 1, signal: null, stdout: "" };
    await expect(probe().run()).rejects.toThrow(/may not exist on this platform/);
  });

  it("records which platform the contract was checked on", async () => {
    const detail = await probe().run();
    expect(String(detail)).toContain(`contract ok on ${process.platform}`);
  });
});
