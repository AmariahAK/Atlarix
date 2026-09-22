import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { isAutoWritablePath, isTempPath } from "@/lib/auto-writable-paths";

/**
 * Auto-writable locations, and the hole that must stay shut.
 *
 * The agent is TOLD to write to two places outside the workspace — its memory
 * directory and a scratch directory under the OS temp root — and the approval
 * gate then asked about every write to both. These are the exemptions.
 *
 * The reason this is containment and not a substring match is a real defect:
 * the previous blanket allowance matched `/.atlarix/` anywhere in a path, so
 * `../other-repo/.atlarix/hooks/hooks.json` matched and carried silent write
 * access to another project's hooks. Most of this file exists to pin that shut.
 */

const MEM = path.join(
  os.homedir(),
  ".atlarix",
  "projects",
  "my-project-abc123",
  "memory",
);
const SCRATCH = path.join(os.tmpdir(), "atlarix-scratch", "my-project-abc123");

describe("allows what the prompt told the agent to use", () => {
  it("this workspace's memory directory, and files under it", () => {
    expect(isAutoWritablePath(MEM, MEM)).toBe(true);
    expect(isAutoWritablePath(path.join(MEM, "MEMORY.md"), MEM)).toBe(true);
    expect(isAutoWritablePath(path.join(MEM, "notes", "a.md"), MEM)).toBe(true);
  });

  it("this workspace's scratch directory, and files under it", () => {
    expect(isAutoWritablePath(SCRATCH, MEM, SCRATCH)).toBe(true);
    expect(
      isAutoWritablePath(path.join(SCRATCH, "note.md"), MEM, SCRATCH),
    ).toBe(true);
  });

  it("but NOT the whole temp root", () => {
    // Granting `os.tmpdir()` outright was the first attempt. The suite caught it
    // at once: its workspaces live under the temp root, so "outside the
    // workspace" stopped meaning anything — the outside-folder escalation never
    // fired and a symlink escaping a granted folder landed inside an allowed
    // root. On macOS the root is `/var/folders`, i.e. every app's cache.
    expect(isAutoWritablePath("/tmp/foo.txt", MEM, SCRATCH)).toBe(false);
    expect(
      isAutoWritablePath(path.join(os.tmpdir(), "other.txt"), MEM, SCRATCH),
    ).toBe(false);
    // `isTempPath` still exists for the COMMAND redirect exemption, which is a
    // different question: a `> /tmp/x` was already permitted by the sandbox, so
    // exempting it only stops a pointless system-scope card.
    expect(isTempPath("/tmp/foo.txt")).toBe(true);
    expect(isTempPath(os.tmpdir())).toBe(true);
  });
});

describe("the substring hole stays shut", () => {
  it("another project's .atlarix is NOT writable", () => {
    // The exact path from the original defect.
    expect(
      isAutoWritablePath("/Users/me/other-repo/.atlarix/hooks/hooks.json", MEM),
    ).toBe(false);
  });

  it("another project's MEMORY directory is NOT writable", () => {
    const otherMem = path.join(
      os.homedir(),
      ".atlarix",
      "projects",
      "other-project-zzz999",
      "memory",
    );
    expect(isAutoWritablePath(path.join(otherMem, "MEMORY.md"), MEM)).toBe(
      false,
    );
    // …nor the shared parent that would reach every project at once.
    expect(
      isAutoWritablePath(path.join(os.homedir(), ".atlarix", "projects"), MEM),
    ).toBe(false);
    expect(isAutoWritablePath(path.join(os.homedir(), ".atlarix"), MEM)).toBe(
      false,
    );
  });

  it("a traversal out of the memory root is NOT writable", () => {
    expect(isAutoWritablePath(path.join(MEM, "..", "..", "x"), MEM)).toBe(
      false,
    );
  });

  it("a sibling sharing the memory root's name prefix is NOT writable", () => {
    // `startsWith` without a separator would swallow this.
    expect(isAutoWritablePath(`${MEM}-backup/notes.md`, MEM)).toBe(false);
    expect(isAutoWritablePath(`${SCRATCH}-other/x`, MEM, SCRATCH)).toBe(false);
    expect(isTempPath("/tmpfoo/x")).toBe(false);
    expect(isTempPath("/private/tmpfoo/x")).toBe(false);
  });

  it("ordinary source files are NOT writable", () => {
    expect(isAutoWritablePath("/Users/me/repo/src/index.ts", MEM)).toBe(false);
    expect(isAutoWritablePath("/etc/passwd", MEM)).toBe(false);
    expect(isAutoWritablePath(path.join(os.homedir(), ".zshrc"), MEM)).toBe(
      false,
    );
  });

  it("with no memory dir, only temp is exempt", () => {
    expect(isAutoWritablePath(path.join(MEM, "MEMORY.md"), null)).toBe(false);
    expect(isAutoWritablePath(path.join(SCRATCH, "x"), null, SCRATCH)).toBe(
      true,
    );
  });

  it("a relative path is never auto-writable", () => {
    // The caller resolves first; anything unresolved is refused rather than
    // guessed at, so a relative path can't be judged against the wrong root.
    expect(isAutoWritablePath("src/index.ts", MEM)).toBe(false);
    expect(isAutoWritablePath("", MEM)).toBe(false);
  });
});
