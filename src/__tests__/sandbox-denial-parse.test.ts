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

/**
 * The two spellings that actually occurred, verbatim from
 * `~/Library/Logs/Atlarix/main.log` on 2026-08-29.
 *
 * Both were missed before — one on a capital `O`, one on word order — and because
 * nothing was attributed, the grant card never appeared and an agent spent six
 * turns diagnosing a boundary nobody told it about. These are the regression.
 */
describe("real-world denial spellings", () => {
  it("catches zsh's phrase-then-path form", () => {
    const out = parseSandboxDenialsFromOutput(
      "zsh:1: operation not permitted: /Users/amariah/.docker/buildx/activity/.writetest",
    );
    expect(out.map((d) => d.deniedPath)).toEqual([
      "/Users/amariah/.docker/buildx/activity/.writetest",
    ]);
  });

  it("catches a lowercase phrase after the path, with anything in front", () => {
    // buildx's own wording. The previous pattern required `: ` immediately before
    // the path, which this shape does not have.
    const out = parseSandboxDenialsFromOutput(
      "ERROR: failed to write /Users/amariah/.docker/buildx/activity/.tmp-abc: operation not permitted",
    );
    expect(out.map((d) => d.deniedPath)).toEqual([
      "/Users/amariah/.docker/buildx/activity/.tmp-abc",
    ]);
  });

  it("grants the PARENT directory, not the temp file itself", () => {
    // A timestamp file is a different name every run; granting it would fix
    // nothing. `sandboxGrantPath` is what makes the grant durable.
    const [d] = parseSandboxDenialsFromOutput(
      "zsh:1: operation not permitted: /Users/amariah/.docker/buildx/activity/.writetest",
    );
    expect(d!.grantPath).toBe("/Users/amariah/.docker/buildx/activity");
  });

  it("does NOT match a path fragment inside a larger token", () => {
    // The boundary guard. Without it `relative/path` yielded `/path`, and the user
    // would be asked to grant a directory nothing mentioned.
    expect(parseSandboxDenialsFromOutput("relative/path: operation not permitted")).toEqual([]);
  });

  it("still says nothing about prose that merely contains the phrase", () => {
    expect(
      parseSandboxDenialsFromOutput("a log line about permission denied policies"),
    ).toEqual([]);
  });
});
