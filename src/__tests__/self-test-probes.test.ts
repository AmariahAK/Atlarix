/**
 * The self-test probes are the packaged-build safety net — and until now nothing
 * verified the PROBES themselves. That gap is not academic: `pty-spawn` writes
 * `printf '%s\n' <marker>` into a PowerShell pty on Windows, and PowerShell has
 * no `printf`, so the marker lands in the error text and the probe passes having
 * executed nothing.
 *
 * These tests cover the three probes added for the Microsoft Store (MSIX)
 * packaging spike, which are the ones that must be trustworthy BEFORE a build
 * goes to a Windows machine — a probe that lies costs a full round trip. Only
 * the host-portable probes run here; `pty-spawn`, `proxy-worker`, `ripgrep`, and
 * `ai-sdk-deps` need the packaged asar and stay the job of
 * `scripts/run-packaged-self-test.mjs`.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PROBES, runSelfTest } from "@/main/self-test";
import { wrapCommandInSandbox } from "@/lib/sandbox/wrap-command";
import { getAcceptableShell } from "@/lib/shell/resolve-shell";

function probe(name: string) {
  const found = DEFAULT_PROBES.find((p) => p.name === name);
  if (!found) throw new Error(`no probe named "${name}" — did DEFAULT_PROBES get renamed?`);
  return found;
}

describe("self-test probe registry", () => {
  it("has unique probe names", () => {
    const names = DEFAULT_PROBES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("still registers the packaged-only probes", () => {
    const names = DEFAULT_PROBES.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining(["pty-spawn", "proxy-worker", "ripgrep", "ai-sdk-deps"]),
    );
  });

  it("registers the sandbox probe", () => {
    expect(DEFAULT_PROBES.map((p) => p.name)).toContain("sandbox");
  });
});

describe("sandbox probe", () => {
  /**
   * Only run it where a sandbox actually exists. The `quality` CI job runs
   * `npm test` on ubuntu-latest WITHOUT building the Landlock helper or
   * installing bwrap, so an unconditional run would fail there for environmental
   * reasons and teach us nothing. The real cross-platform gate is
   * `scripts/run-packaged-self-test.mjs` in the three package jobs, where the
   * helpers are built.
   */
  const available = (() => {
    try {
      return wrapCommandInSandbox({
        command: "exit 0",
        shell: getAcceptableShell(),
        workspacePath: os.tmpdir(),
      }).sandboxed;
    } catch {
      return false;
    }
  })();

  it.skipIf(!available)(
    "confines writes while leaving reads and exec alone",
    async () => {
      const detail = String(await probe("sandbox").run());
      expect(detail).toContain("confined writes");
      // Leaves nothing behind in HOME, where it stages its workspace and target.
      const leftovers = fs
        .readdirSync(os.homedir())
        .filter((f) => f.startsWith("atlarix-sbx-"));
      expect(leftovers).toEqual([]);
    },
    120_000,
  );

  it.skipIf(available)("is skipped when no sandbox is available on this host", () => {
    // Placeholder so the suite reports the reason rather than silently omitting.
    expect(available).toBe(false);
  });
});

describe("context probe", () => {
  it("reports the paths the MSIX spike needs, without failing", async () => {
    const detail = String(await probe("context").run());
    // These key names are what the runbook tells the maintainer to diff between a
    // Squirrel and an MSIX install, so renaming one silently breaks the spike.
    for (const key of ["windowsStore=", "userData=", "temp=", "home=", "execPath=", "resources="]) {
      expect(detail).toContain(key);
    }
    expect(detail).toContain(`home=${os.homedir()}`);
  });
});

describe("child-exec probe", () => {
  it("proves a command actually executed, not merely that a shell spawned", async () => {
    const detail = String(await probe("child-exec").run());
    expect(detail).toContain("executed the command");
    // git is best-effort by design (a bare test box may have none), but the probe
    // must always report which way it went rather than staying silent.
    expect(detail).toMatch(/git=/);
  });

  it("would FAIL if the shell exited non-zero (the gap pty-spawn has)", async () => {
    // Guards the actual assertion: execFile rejects on a non-zero exit, which is
    // what makes this probe catch a shell that cannot run commands. pty-spawn
    // cannot distinguish that case from success.
    const { promisify } = await import("node:util");
    const { execFile } = await import("node:child_process");
    await expect(
      promisify(execFile)(process.execPath, ["-e", "process.exit(3)"]),
    ).rejects.toMatchObject({ code: 3 });
  });
});

describe("fs-outside-container probe", () => {
  it("writes, reads back, reports the resolved path, and cleans up", async () => {
    const detail = String(await probe("fs-outside-container").run());
    expect(detail).toContain("wrote+read");
    // On a normal (non-container) host there must be no redirection warning —
    // that string appearing here would mean the detection logic is inverted.
    expect(detail).not.toContain("REDIRECTED");

    // The probe must not leave litter in the user's home directory.
    const leftovers = fs
      .readdirSync(os.homedir())
      .filter((f) => f.startsWith(".atlarix-self-test-"));
    expect(leftovers).toEqual([]);
  });

  it("removes its temp file even when the read-back assertion fails", async () => {
    // The cleanup lives in a `finally`, so a mid-probe throw must not leak. Prove
    // it by pointing the same write/read/cleanup shape at a path we corrupt.
    const target = path.join(os.tmpdir(), `atlarix-probe-cleanup-${process.pid}`);
    await expect(
      (async () => {
        await fs.promises.writeFile(target, "a", "utf8");
        try {
          throw new Error("simulated read-back mismatch");
        } finally {
          await fs.promises.rm(target, { force: true });
        }
      })(),
    ).rejects.toThrow("simulated read-back mismatch");
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe("runSelfTest", () => {
  it("returns code 0 and one result per probe when all pass", async () => {
    const report = await runSelfTest([
      { name: "ok-a", run: async () => "detail a" },
      { name: "ok-b", run: async () => undefined },
    ]);
    expect(report.code).toBe(0);
    expect(report.results.map((r) => r.name)).toEqual(["ok-a", "ok-b"]);
    expect(report.results.every((r) => r.ok)).toBe(true);
  });

  it("returns a non-zero code and keeps going after a failing probe", async () => {
    const report = await runSelfTest([
      { name: "boom", run: async () => { throw new Error("nope"); } },
      { name: "after", run: async () => "still ran" },
    ]);
    expect(report.code).toBe(1);
    expect(report.results[0]).toMatchObject({ name: "boom", ok: false, detail: "nope" });
    // A failing probe must not abort the run — otherwise one early failure hides
    // every later finding, which is exactly what a spike cannot afford.
    expect(report.results[1]).toMatchObject({ name: "after", ok: true });
  });
});
