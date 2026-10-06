import { describe, it, expect } from "vitest";
import { terminalCommand } from "@/lib/peers/continue-in-terminal";

describe("continue in terminal", () => {
  it("opens Terminal on macOS in the folder, resuming the session", () => {
    const c = terminalCommand(
      "darwin",
      "/opt/homebrew/bin/atlarix",
      "/Users/x/my repo",
      "1b2c-3d",
    )!;
    expect(c.file).toBe("osascript");
    expect(c.args.join(" ")).toContain(
      `cd '/Users/x/my repo' && '/opt/homebrew/bin/atlarix' --resume 1b2c-3d`,
    );
  });
  it("carries a non-default data folder to the CLI", () => {
    const c = terminalCommand(
      "linux",
      "/usr/bin/atlarix",
      "/w",
      "abc",
      "/tmp/data",
    )!;
    expect(c.args.at(-1)).toContain(
      "ATLARIX_USER_DATA_DIR='/tmp/data' '/usr/bin/atlarix' --resume abc",
    );
  });
  it("quotes paths with quotes in them and refuses a strange session id", () => {
    const c = terminalCommand("darwin", "/b/atlarix", `/w/it's`, "abc")!;
    expect(c.args[3]).toContain(`'/w/it'\\\\''s'`);
    expect(
      terminalCommand("darwin", "/b/atlarix", "/w", "x; rm -rf ~"),
    ).toBeNull();
  });
  it("uses cmd start on Windows", () => {
    const c = terminalCommand(
      "win32",
      "C:\\\\a\\\\atlarix.exe",
      "C:\\\\w",
      "abc",
    )!;
    expect(c.file).toBe("cmd.exe");
    expect(c.args.at(-1)).toContain("--resume abc");
  });
});
