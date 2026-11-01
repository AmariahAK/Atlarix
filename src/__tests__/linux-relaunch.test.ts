/**
 * After a deb/rpm update, Atlarix starts itself again from a detached shell
 * instead of app.relaunch(): Electron's relauncher carries no-new-privs, so
 * the setuid sandbox fails and the app stays closed (EC2 Ubuntu 24.04,
 * 2026-10-30). The shell waits for the old process, then runs the new binary.
 */
import { spawn as realSpawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { relaunchAfterExit } from "@/main/update-helpers";

describe("relaunchAfterExit", () => {
  it("spawns a detached shell that waits for the old pid, then runs the app with its args", () => {
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ unref }));
    relaunchAfterExit(4242, "/usr/lib/atlarix/atlarix", ["--user-data-dir=/x"], spawn);
    expect(spawn).toHaveBeenCalledWith(
      "/bin/sh",
      ["-c", expect.stringContaining('kill -0 "$0"'), "4242", "/usr/lib/atlarix/atlarix", "--user-data-dir=/x"],
      { detached: true, stdio: "ignore" },
    );
    expect(unref).toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("really starts the program only after that pid is gone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaunch-"));
    const mark = path.join(dir, "ran");
    const old = realSpawn("/bin/sh", ["-c", "sleep 1"], { stdio: "ignore" });
    relaunchAfterExit(old.pid!, "/bin/sh", ["-c", `date +%s%N > "${mark}"`], realSpawn as never);
    await new Promise((r) => setTimeout(r, 400));
    expect(fs.existsSync(mark)).toBe(false); // old process still running
    await new Promise((r) => old.on("exit", r));
    for (let i = 0; i < 30 && !fs.existsSync(mark); i++) await new Promise((r) => setTimeout(r, 100));
    expect(fs.existsSync(mark)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
