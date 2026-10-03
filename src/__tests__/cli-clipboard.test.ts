import { describe, expect, it } from "vitest";
import { encodeFor, nativeCopyCommand } from "@/cli/tui/clipboard";

describe("copy on select: the native route", () => {
  it("uses this machine's copy tool, and none over SSH (that clipboard is not yours)", () => {
    expect(nativeCopyCommand("darwin", {})).toEqual([["pbcopy", []]]);
    expect(nativeCopyCommand("win32", {})).toEqual([["clip", [], "utf16le-bom"]]);
    expect(nativeCopyCommand("linux", { WSL_DISTRO_NAME: "Ubuntu" })).toEqual([["clip.exe", [], "utf16le-bom"]]);
    expect(nativeCopyCommand("linux", { WAYLAND_DISPLAY: "wayland-0" })[0]).toEqual(["wl-copy", []]);
    expect(nativeCopyCommand("linux", { DISPLAY: ":0" }).map(([c]) => c)).toEqual(["xclip", "xsel"]);
    expect(nativeCopyCommand("linux", {})).toEqual([]);
    expect(nativeCopyCommand("darwin", { SSH_CONNECTION: "1 2 3 4" })).toEqual([]);
  });

  it("feeds clip UTF-16 with a byte-order mark, so non-ASCII survives", () => {
    const b = encodeFor("● é\nx", "utf16le-bom");
    expect([...b.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(b.subarray(2).toString("utf16le")).toBe("● é\r\nx");
    expect(encodeFor("● é", undefined).toString("utf8")).toBe("● é");
  });
});
