/**
 * The build scripts' CLI parser.
 *
 * This exists because of a specific CI failure on 2026-09-05: the x64 macOS job
 * was invoked as `--arch=x64`, the build scripts parsed only `--arch x64`, and so
 * they silently built the runner's own arm64 while echoing `--arch=x64` in the same
 * log line. Every internal assertion passed — each compared the binary against the
 * RESOLVED target rather than the REQUESTED one, so they agreed with each other and
 * were both wrong. Only re-reading the arch off the packaged copy caught it, and
 * without that the Intel DMG ships arm64 helpers: installs fine, launches fine,
 * computer use dead on every Intel Mac.
 *
 * So the equals-form cases below are the regression, not decoration.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs build script, typed by its sibling .d.mts
import { argValue, argFlag } from "../../scripts/cli-args.mjs";

/** argv as node presents it: [exec, script, ...args]. */
const argv = (...args: string[]) => ["node", "script.mjs", ...args];

describe("argValue", () => {
  it("reads the space-separated form", () => {
    expect(argValue(argv("--arch", "x64"), "arch")).toBe("x64");
  });

  it("reads the EQUALS form — the one that shipped the wrong arch", () => {
    expect(argValue(argv("--arch=x64"), "arch")).toBe("x64");
  });

  it("does not fall through to a default when the equals form is used", () => {
    // The exact bug: `undefined` here means the caller's `?? process.arch` fires
    // and the script builds for whatever host it happens to be on.
    expect(argValue(argv("--arch=x64"), "arch")).not.toBeUndefined();
  });

  it("returns undefined for an absent flag, so callers can default", () => {
    expect(argValue(argv("--target", "aarch64-apple-darwin"), "arch")).toBeUndefined();
  });

  it("never swallows a following FLAG as if it were a value", () => {
    // `--arch --target x` must not yield "--target": that would resolve a triple
    // named after a flag and fail somewhere far away from the cause.
    expect(argValue(argv("--arch", "--target", "x"), "arch")).toBeUndefined();
  });

  it("handles a bare flag at the end of argv without reading past the array", () => {
    expect(argValue(argv("--arch"), "arch")).toBeUndefined();
  });

  it("accepts an empty equals value as an explicit empty string", () => {
    // Distinct from absent: the caller can tell "not passed" from "passed blank".
    expect(argValue(argv("--arch="), "arch")).toBe("");
  });

  it("does not match a flag that merely starts with the name", () => {
    expect(argValue(argv("--architecture=arm64"), "arch")).toBeUndefined();
  });

  it("reads each of several flags independently", () => {
    const a = argv("--stage=package", "--platform", "darwin", "--arch=x64");
    expect(argValue(a, "stage")).toBe("package");
    expect(argValue(a, "platform")).toBe("darwin");
    expect(argValue(a, "arch")).toBe("x64");
  });
});

describe("argFlag", () => {
  it("detects a bare boolean flag", () => {
    expect(argFlag(argv("--verify-only"), "verify-only")).toBe(true);
  });

  it("detects the equals form too", () => {
    expect(argFlag(argv("--verify-only=true"), "verify-only")).toBe(true);
  });

  it("is false when absent", () => {
    expect(argFlag(argv("--arch=x64"), "verify-only")).toBe(false);
  });
});
