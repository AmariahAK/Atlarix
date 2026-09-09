/**
 * `GIT_NOT_INSTALLED_MESSAGE` must name a command that exists on the user's OS.
 *
 * It previously hardcoded `xcode-select --install` for every platform, so a Windows
 * user with no git was told to run a macOS-only command — seen on a real Windows
 * install. A recovery hint that cannot work on the user's system is worse than
 * none, because it sends them somewhere that doesn't exist.
 *
 * The constant is computed at module load from `process.platform`, so each case
 * re-imports with the platform stubbed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const realPlatform = process.platform;

function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

async function messageFor(p: NodeJS.Platform): Promise<string> {
  setPlatform(p);
  vi.resetModules();
  const mod = await import("@/ipc/utils/system_git_exec");
  return mod.GIT_NOT_INSTALLED_MESSAGE;
}

afterEach(() => {
  Object.defineProperty(process, "platform", {
    value: realPlatform,
    configurable: true,
  });
  vi.resetModules();
});

describe("GIT_NOT_INSTALLED_MESSAGE", () => {
  it("tells macOS users to run xcode-select", async () => {
    const msg = await messageFor("darwin");
    expect(msg).toContain("xcode-select --install");
  });

  it("tells Windows users about Git for Windows, NOT xcode-select", async () => {
    const msg = await messageFor("win32");
    expect(msg).toContain("winget install Git.Git");
    expect(msg).not.toContain("xcode-select");
  });

  it("tells Linux users to use their package manager, NOT xcode-select", async () => {
    const msg = await messageFor("linux");
    expect(msg).toContain("apt install git");
    expect(msg).not.toContain("xcode-select");
  });

  it("always explains what is wrong and why it matters", async () => {
    for (const p of ["darwin", "win32", "linux"] as NodeJS.Platform[]) {
      const msg = await messageFor(p);
      expect(msg).toContain("Git is not installed");
      expect(msg).toContain("version control features");
    }
  });
});
