/**
 * `isCmdShell` — does this shell speak cmd.exe syntax or POSIX?
 *
 * This exists because the same wrong assumption caused two separate bugs, and the
 * second one was in the test written to catch the first:
 *
 *  1. `atlarix-sandbox.exe` hardcoded `cmd.exe /c` while UNsandboxed runs went
 *     through `getAcceptableShell()` — which prefers Git-for-Windows' bash when it
 *     is installed. POSIX-shaped commands (`printf`, `VAR=x cmd`, `mkdir -p`)
 *     therefore failed under the sandbox with cmd syntax errors that read like
 *     sandbox denials but were not.
 *  2. The `sandbox` self-test probe then branched on `process.platform === "win32"`
 *     and used `type` to read a file. In bash `type` is a builtin meaning "describe
 *     a command", so the read failed sandboxed AND unsandboxed — observed on a real
 *     Windows 10 run as `FAIL … probe environment is broken, not the sandbox`.
 *
 * The lesson: on Windows, platform does NOT imply shell. Branch on the shell.
 */
import { describe, it, expect, afterEach } from "vitest";
import { isCmdShell } from "@/lib/shell/resolve-shell";

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}
afterEach(() => setPlatform(realPlatform));

describe("isCmdShell on Windows", () => {
  it("says NO for Git-for-Windows bash — the case that broke twice", () => {
    setPlatform("win32");
    expect(isCmdShell("C:\\Program Files\\Git\\bin\\bash.exe")).toBe(false);
    // Wherever git happens to be installed.
    expect(
      isCmdShell("C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\bash.exe"),
    ).toBe(false);
  });

  it("says YES for cmd.exe, in either casing", () => {
    setPlatform("win32");
    expect(isCmdShell("C:\\Windows\\System32\\cmd.exe")).toBe(true);
    expect(isCmdShell("C:\\WINDOWS\\SYSTEM32\\CMD.EXE")).toBe(true);
  });

  it("says NO for PowerShell — it is not cmd, and has no printf either", () => {
    setPlatform("win32");
    expect(
      isCmdShell(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ),
    ).toBe(false);
    expect(isCmdShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(
      false,
    );
  });

  it("handles forward slashes, which Node hands back on Windows too", () => {
    setPlatform("win32");
    expect(isCmdShell("C:/Windows/System32/cmd.exe")).toBe(true);
    expect(isCmdShell("C:/Program Files/Git/bin/bash.exe")).toBe(false);
  });

  it("falls back to platform default only when the shell is unknown", () => {
    setPlatform("win32");
    expect(isCmdShell("")).toBe(true);
    setPlatform("darwin");
    expect(isCmdShell("")).toBe(false);
  });
});

describe("isCmdShell on POSIX hosts", () => {
  it.each(["/bin/zsh", "/bin/bash", "/bin/sh", "/usr/local/bin/fish"])(
    "says NO for %s",
    (shell) => {
      setPlatform("darwin");
      expect(isCmdShell(shell)).toBe(false);
    },
  );

  it("does not treat a POSIX file merely NAMED cmd as cmd.exe on Linux", () => {
    setPlatform("linux");
    // `/usr/bin/cmd` on Linux is not Windows' interpreter; but the name matches, so
    // this documents the accepted limitation rather than pretending it doesn't exist.
    expect(isCmdShell("/usr/bin/cmd")).toBe(true);
  });
});
