/**
 * parseSandboxDenialsFromOutput extracts the denied write path from a failed
 * command's output so escalation-on-denial can offer to grant it. Covers the
 * real formats observed across tools/OSes (macOS BSD, GNU coreutils, Node/libuv,
 * Windows). macOS does NOT log custom sandbox-exec denials to the unified log
 * (verified empirically) — stderr is the capture channel there too.
 */
import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  parseSandboxDenialsFromOutput,
  sandboxGrantPath,
} from "@/lib/sandbox/wrap-command";

describe("parseSandboxDenialsFromOutput", () => {
  it("parses the macOS BSD form (the exact Seatbelt-denied mkdir)", () => {
    const out = "mkdir: /Users/amariah/.yarn: Operation not permitted";
    const d = parseSandboxDenialsFromOutput(out);
    expect(d.map((x) => x.deniedPath)).toEqual(["/Users/amariah/.yarn"]);
  });

  it("parses the Node/libuv EPERM form (the original yarn error)", () => {
    const out = "EPERM: operation not permitted, mkdir '/Users/amariah/.yarn'";
    expect(parseSandboxDenialsFromOutput(out)[0]?.deniedPath).toBe(
      "/Users/amariah/.yarn",
    );
  });

  it("parses the GNU coreutils form with fancy quotes", () => {
    const out = "mkdir: cannot create directory ‘/home/dev/.cargo’: Permission denied";
    expect(parseSandboxDenialsFromOutput(out)[0]?.deniedPath).toBe("/home/dev/.cargo");
  });

  it("parses a Node EACCES open on Windows", () => {
    const out = "EACCES: permission denied, open 'C:\\Users\\dev\\.npm\\cache\\x'";
    expect(parseSandboxDenialsFromOutput(out)[0]?.deniedPath).toBe(
      "C:\\Users\\dev\\.npm\\cache\\x",
    );
  });

  it("dedupes repeated denials and ignores non-permission lines", () => {
    const out = [
      "some normal log line",
      "mkdir: /home/dev/.gradle: Permission denied",
      "mkdir: /home/dev/.gradle: Permission denied",
      "error: file not found",
    ].join("\n");
    expect(parseSandboxDenialsFromOutput(out).map((x) => x.deniedPath)).toEqual([
      "/home/dev/.gradle",
    ]);
  });

  it("returns [] when there is no denial", () => {
    expect(parseSandboxDenialsFromOutput("npm warn deprecated foo\nbuilt ok")).toEqual([]);
  });

  describe("sandboxGrantPath", () => {
    it("grants the leaf itself when the parent is $HOME (never opens all of home)", () => {
      const p = path.join(os.homedir(), ".yarn");
      expect(sandboxGrantPath(p)).toBe(p);
    });

    it("grants the parent dir for a denied file deep in a cache", () => {
      expect(sandboxGrantPath("/home/dev/.cache/app/sub/file.txt")).toBe(
        "/home/dev/.cache/app/sub",
      );
    });

    it("never grants a filesystem-root child wholesale", () => {
      expect(sandboxGrantPath("/opt/thing")).toBe("/opt/thing");
    });
  });
});
