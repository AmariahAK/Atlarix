/**
 * pnpm's real store on macOS lives under `~/Library/pnpm` (PNPM_HOME), which the
 * Seatbelt writable set previously omitted — so `pnpm install` stalled on denied
 * store writes. The default writable set must grant it (and an explicit
 * PNPM_HOME), else the child sandbox blocks package-manager writes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { wrapCommandInSandbox } from "@/lib/sandbox/wrap-command";

const isMac = process.platform === "darwin";

describe.runIf(isMac)("macOS sandbox grants the pnpm store", () => {
  const savedPnpmHome = process.env.PNPM_HOME;
  let pnpmHome = "";

  beforeEach(() => {
    // A real, existing dir so realpath resolution includes it in the profile.
    pnpmHome = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-pnpm-home-"));
    process.env.PNPM_HOME = pnpmHome;
  });

  afterEach(() => {
    if (savedPnpmHome === undefined) delete process.env.PNPM_HOME;
    else process.env.PNPM_HOME = savedPnpmHome;
    try {
      fs.rmSync(pnpmHome, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it("includes an explicit PNPM_HOME in the writable subpaths", () => {
    const w = wrapCommandInSandbox({
      command: "pnpm install",
      shell: "/bin/zsh",
      workspacePath: os.tmpdir(),
    });
    const profile = w.args.join(" ");
    expect(w.sandboxed).toBe(true);
    // realpath because the sandbox resolves symlinks (/var → /private/var on mac).
    expect(profile).toContain(realpathSync(pnpmHome));
  });

  it("includes ~/Library/pnpm when it exists on the machine", () => {
    const libPnpm = path.join(os.homedir(), "Library", "pnpm");
    if (!fs.existsSync(libPnpm)) return; // not present on this host — nothing to assert
    const w = wrapCommandInSandbox({
      command: "pnpm install",
      shell: "/bin/zsh",
      workspacePath: os.tmpdir(),
    });
    expect(w.args.join(" ")).toContain(realpathSync(libPnpm));
  });
});
