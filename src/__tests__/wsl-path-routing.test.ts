/**
 * WSL workspace detection and path translation.
 *
 * `parseWslPath` decides whether a command gets routed into a Linux distro or stays
 * on the Windows side with the Low-integrity sandbox. Getting it wrong in either
 * direction is bad: a false positive tries to run a Windows project in Linux, and a
 * false negative confines the wrong filesystem. It's pure and total, so unlike the
 * Win32/Landlock code it can be tested properly on any host.
 */
import { describe, it, expect } from "vitest";
import { parseWslPath } from "@/lib/sandbox/wsl";

describe("parseWslPath — recognised", () => {
  it("parses the \\\\wsl$ share", () => {
    expect(parseWslPath("\\\\wsl$\\Ubuntu\\home\\me\\proj")).toEqual({
      distro: "Ubuntu",
      linuxPath: "/home/me/proj",
    });
  });

  it("parses the newer \\\\wsl.localhost share", () => {
    expect(parseWslPath("\\\\wsl.localhost\\Debian\\srv\\app")).toEqual({
      distro: "Debian",
      linuxPath: "/srv/app",
    });
  });

  it("keeps distro names containing dots and dashes intact", () => {
    // `Ubuntu-22.04` is the common real-world shape; a greedy dot match would
    // mangle it into the wrong distro and every `wsl -d` call would fail.
    expect(parseWslPath("\\\\wsl$\\Ubuntu-22.04\\home\\me")).toEqual({
      distro: "Ubuntu-22.04",
      linuxPath: "/home/me",
    });
  });

  it("accepts forward slashes, since Node hands back either style", () => {
    expect(parseWslPath("//wsl$/Ubuntu/home/me/proj")).toEqual({
      distro: "Ubuntu",
      linuxPath: "/home/me/proj",
    });
  });

  it("is case-insensitive on the share name", () => {
    expect(parseWslPath("\\\\WSL$\\Ubuntu\\x")?.linuxPath).toBe("/x");
    expect(parseWslPath("\\\\WSL.LocalHost\\Ubuntu\\x")?.linuxPath).toBe("/x");
  });

  it("maps the distro share root to /", () => {
    expect(parseWslPath("\\\\wsl$\\Ubuntu")).toEqual({ distro: "Ubuntu", linuxPath: "/" });
    expect(parseWslPath("\\\\wsl$\\Ubuntu\\")).toEqual({ distro: "Ubuntu", linuxPath: "/" });
  });

  it("preserves spaces in paths", () => {
    expect(parseWslPath("\\\\wsl$\\Ubuntu\\home\\me\\my project")?.linuxPath).toBe(
      "/home/me/my project",
    );
  });
});

describe("parseWslPath — must NOT match", () => {
  // Each of these would wrongly divert a Windows-native workspace into Linux.
  it.each([
    ["a normal drive path", "C:\\Users\\me\\proj"],
    ["a POSIX path", "/home/me/proj"],
    ["an unrelated UNC share", "\\\\server\\share\\proj"],
    ["a lookalike host", "\\\\wslx\\Ubuntu\\home"],
    ["a wsl-ish substring mid-path", "C:\\wsl$\\Ubuntu\\home"],
    ["empty", ""],
  ])("returns null for %s", (_label, input) => {
    expect(parseWslPath(input)).toBeNull();
  });
});
