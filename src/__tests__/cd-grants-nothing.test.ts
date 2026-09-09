import { describe, it, expect } from "vitest";
import {
  commandChangesDirectory,
  cwdNoteForCommand,
} from "@/lib/commands/cwd-note";
import { isOutsidePathOnlySystemScope } from "@/lib/system-scope-commands";

/**
 * A model-authored `cd` must grant nothing and change nothing beyond its own
 * shell. Atlarix used to regex `^cd <abs>` out of the model's command string and
 * add that directory to the session's writable roots — an invisible, permanent
 * grant derived from text the model wrote. No comparable harness does this:
 * Claude Code moves the working directory only via the user's `/cd` and grants
 * roots only via `/add-dir`; opencode raises its `external_directory` permission
 * for outside paths a command touches; Codex lets the OS sandbox hold the line
 * wherever the command chdir's to; Cursor uses configured workspace roots.
 */

const WS = "/Users/dev/project";

describe("a cd tells the model it did not move", () => {
  it("fires when the command changes directory", () => {
    expect(commandChangesDirectory("cd /elsewhere && ls")).toBe(true);
    expect(commandChangesDirectory("npm test && cd packages/api")).toBe(true);
    expect(commandChangesDirectory("pushd /tmp")).toBe(true);
  });

  it("stays quiet for ordinary commands — a note on every call is noise", () => {
    expect(commandChangesDirectory("npm test")).toBe(false);
    expect(commandChangesDirectory("git status")).toBe(false);
    // Substring matches must not trigger it.
    expect(commandChangesDirectory("echo 'discard changes'")).toBe(false);
    expect(commandChangesDirectory("cdk deploy")).toBe(false);
  });

  it("names the directory the next command will actually start in", () => {
    const note = cwdNoteForCommand(
      "cd /somewhere/else && python3 x.py",
      WS,
    ).cwdNote!;
    expect(note).toMatch(/working directory is unchanged/i);
    expect(note).toContain(WS);
    expect(note).toMatch(/`cwd` parameter/);
  });

  it("adds no fields at all when there is no cd", () => {
    expect(cwdNoteForCommand("npm test", WS)).toEqual({});
  });

  it("omits the location when the cwd is the default", () => {
    const note = cwdNoteForCommand("cd /x && ls", ".").cwdNote!;
    expect(note).toMatch(/working directory is unchanged\./);
  });
});

describe("sandbox: widen for outside paths, drop only for installers", () => {
  // The boundary comes off only for changes nobody can enumerate ahead of time.
  it("keeps the sandbox for a command that is system-scope only by path", () => {
    expect(
      isOutsidePathOnlySystemScope("cd /Users/dev/other-repo && ls", WS),
    ).toBe(true);
    expect(
      isOutsidePathOnlySystemScope("echo hi > /Users/dev/other/file.txt", WS),
    ).toBe(true);
  });

  it("drops it for a genuine installer or sudo", () => {
    expect(isOutsidePathOnlySystemScope("brew install jq", WS)).toBe(false);
    expect(isOutsidePathOnlySystemScope("sudo rm -rf /var/cache", WS)).toBe(
      false,
    );
    expect(isOutsidePathOnlySystemScope("npm install -g typescript", WS)).toBe(
      false,
    );
  });

  it("an installer BEHIND a cd still drops it — the install is the reason", () => {
    expect(isOutsidePathOnlySystemScope("cd /tmp && brew install jq", WS)).toBe(
      false,
    );
  });

  it("is false for a command that isn't system-scope at all", () => {
    expect(isOutsidePathOnlySystemScope("npm test", WS)).toBe(false);
  });
});
