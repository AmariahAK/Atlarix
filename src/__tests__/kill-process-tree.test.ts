/**
 * `killShellProcess` must reap the whole process TREE, not just the child we hold.
 *
 * Every command runs through a shell, so the pid we own is `sh`, never the thing
 * the user actually started. Signalling it alone reaped the shell and left the
 * real work running — cancelling a dev server killed the shell and left node
 * holding the port, invisible to the person who just pressed stop.
 *
 * These use REAL processes on purpose. The bug lives entirely in how the OS
 * routes a signal, so a mocked ChildProcess would assert our own assumptions
 * back at us and pass either way.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { killShellProcess } from "@/ipc/utils/runShellCommand";

const posixOnly = process.platform === "win32" ? describe.skip : describe;

function isAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

/**
 * A shell that starts a long-lived grandchild and records its pid.
 *
 * `& … wait` rather than a plain foreground command: many shells `exec` a lone
 * final command, which would collapse the shell and the grandchild into one
 * process and quietly make the test unable to fail.
 */
function spawnShellWithGrandchild(pidFile: string, detached: boolean) {
  const script =
    `node -e 'setInterval(() => {}, 1000)' & ` +
    `echo $! > ${JSON.stringify(pidFile)}; wait`;
  return spawn(script, {
    shell: "/bin/sh",
    stdio: ["ignore", "pipe", "pipe"],
    detached,
  });
}

async function readGrandchildPid(pidFile: string): Promise<number> {
  const ready = await waitFor(() => {
    try {
      return fs.readFileSync(pidFile, "utf8").trim().length > 0;
    } catch {
      return false;
    }
  }, 10_000);
  expect(ready).toBe(true);
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  expect(Number.isInteger(pid)).toBe(true);
  return pid;
}

posixOnly("killShellProcess — process tree", () => {
  it("kills the grandchild, not just the shell", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-killtree-"));
    const pidFile = path.join(dir, "grandchild.pid");
    // `detached: true` mirrors what runShellProcess now passes on POSIX.
    const proc = spawnShellWithGrandchild(pidFile, true);
    let grandchild = 0;
    try {
      grandchild = await readGrandchildPid(pidFile);
      expect(isAlive(grandchild)).toBe(true);

      killShellProcess(proc);

      const shellGone = await waitFor(
        () => proc.exitCode !== null || proc.signalCode !== null,
        5_000,
      );
      expect(shellGone).toBe(true);

      const grandchildGone = await waitFor(() => !isAlive(grandchild), 5_000);
      expect(grandchildGone).toBe(true);
    } finally {
      if (grandchild && isAlive(grandchild)) {
        try {
          process.kill(grandchild, "SIGKILL");
        } catch {
          /* noop */
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 25_000);

  /**
   * Pins the BUG, not only the fix: signalling the direct child alone leaves the
   * grandchild running. Without this, a regression that quietly dropped
   * `detached` would still let the test above pass on a fast machine.
   */
  it("signalling only the direct child leaves the grandchild running", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-killtree-"));
    const pidFile = path.join(dir, "grandchild.pid");
    const proc = spawnShellWithGrandchild(pidFile, false);
    let grandchild = 0;
    try {
      grandchild = await readGrandchildPid(pidFile);
      expect(isAlive(grandchild)).toBe(true);

      proc.kill("SIGKILL");
      await waitFor(
        () => proc.exitCode !== null || proc.signalCode !== null,
        5_000,
      );

      // Give it the same grace the real kill path allows before concluding.
      await new Promise((r) => setTimeout(r, 500));
      expect(isAlive(grandchild)).toBe(true);
    } finally {
      if (grandchild && isAlive(grandchild)) {
        try {
          process.kill(grandchild, "SIGKILL");
        } catch {
          /* noop */
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 25_000);
});
