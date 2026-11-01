/**
 * EC2 Linux run 2026-10-30: cancelling the password prompt for the deb update
 * (pkexec exit 126, "Request dismissed") made electron-updater treat it as a
 * dependency failure and ask again, for `apt-get install -f -y`. A refused
 * prompt is the user's answer (patches/electron-updater+6.8.9.patch).
 */
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { DebUpdater } = require("electron-updater/out/DebUpdater");
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function run(failWith: string) {
  const calls: string[][] = [];
  const runner = (args: string[]) => {
    calls.push(args);
    if (args[0] === "dpkg") throw new Error(failWith);
    return "";
  };
  let thrown: unknown;
  try {
    DebUpdater.installWithCommandRunner("dpkg", "/tmp/a.deb", runner, logger);
  } catch (e) {
    thrown = e;
  }
  return { calls: calls.map((c) => c[0]), thrown };
}

describe("deb update install", () => {
  it.each(["126", "127"])("a cancelled or failed password prompt (pkexec %s) is not asked again", (code) => {
    const r = run(`Command pkexec exited with code ${code}`);
    expect(r.calls).toEqual(["dpkg"]);
    expect(String(r.thrown)).toContain(`exited with code ${code}`);
  });

  it("dpkg failing on missing dependencies still repairs them with apt-get", () => {
    const r = run("Command pkexec exited with code 1");
    expect(r.calls).toEqual(["dpkg", "apt-get"]);
    expect(r.thrown).toBeUndefined();
  });
});
