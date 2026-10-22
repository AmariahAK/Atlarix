/**
 * atlarix.cliPath set to a .cmd or .bat on Windows (QA E8): Node refuses to
 * spawn those without a shell ("spawn EINVAL") since its 2024 fix, and the
 * panel then waited on "Starting Atlarix…" for ever. They run through the
 * shell, quoted; everything else is spawned directly, as before.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({}));

describe("how the panel starts atlarix", () => {
  it("a .cmd or .bat on Windows: through the shell, quoted", async () => {
    const { spawnCommand } = await import("../../packages/vscode/src/connection");
    expect(spawnCommand("C:\\a95 qa\\a95-qa.cmd", "win32")).toEqual({ command: '"C:\\a95 qa\\a95-qa.cmd"', shell: true });
    expect(spawnCommand("C:\\tools\\atlarix.BAT", "win32")).toEqual({ command: '"C:\\tools\\atlarix.BAT"', shell: true });
  });

  it("an .exe, and anything on macOS or Linux: directly", async () => {
    const { spawnCommand } = await import("../../packages/vscode/src/connection");
    expect(spawnCommand("C:\\Program Files\\Atlarix\\atlarix.exe", "win32")).toEqual({
      command: "C:\\Program Files\\Atlarix\\atlarix.exe",
      shell: false,
    });
    expect(spawnCommand("/usr/local/bin/atlarix.cmd", "darwin")).toEqual({ command: "/usr/local/bin/atlarix.cmd", shell: false });
  });
});
