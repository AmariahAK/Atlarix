/**
 * C1 — path-resolver parity contract (TODO.md:1489).
 *
 * Two workspace-relative path resolvers exist:
 *   - resolvePathUnderWorkspace (safeWorkspaceRelativePath.ts) — used by read_file
 *   - safeJoin (path_utils.ts) — used by @-mentions, response_processor, etc.
 *
 * They are NOT being merged: safeJoin has 40+ tests and many callers, and the two
 * use DIFFERENT philosophies — safeJoin THROWS on anything suspicious, while
 * resolvePathUnderWorkspace SANITIZES (strips `/workspace/` + leading slashes,
 * blocks system-like first segments) and contains the rest. Forcing identical
 * behavior would be a risky behavior change for no security gain.
 *
 * What MUST never drift is the security invariant they actually share:
 * neither resolver ever yields a path OUTSIDE the workspace root — whether by
 * throwing or by containing. This test pins exactly that.
 */
import { describe, expect, it } from "vitest";
import * as path from "path";
import { resolvePathUnderWorkspace } from "@/ipc/utils/safeWorkspaceRelativePath";
import { safeJoin } from "@/ipc/utils/path_utils";

const ROOT = path.resolve("/work/project");

/** A resolver "contains" an input if it throws OR returns a path under ROOT. */
function contains(fn: () => string): boolean {
  let resolved: string;
  try {
    resolved = fn();
  } catch {
    return true; // throwing is a valid form of containment
  }
  const rel = path.relative(ROOT, path.resolve(resolved));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Escape attempts: BOTH resolvers must CONTAIN every one (throw or keep inside).
const ESCAPE_ATTEMPTS = [
  "../outside.txt",
  "../../etc/passwd",
  "src/../../../etc/passwd",
  "/etc/passwd",
  "C:\\Windows\\System32",
  "\\\\server\\share\\file.txt",
  "~/secrets.txt",
  "/workspace/../../../etc/passwd",
];

const ORDINARY = ["src/app.ts", "package.json", "a/b/c/d.txt", "src/./x.ts"];

describe("path resolver parity (C1 / TODO:1489)", () => {
  for (const bad of ESCAPE_ATTEMPTS) {
    it(`neither escapes on: ${bad}`, () => {
      expect(contains(() => resolvePathUnderWorkspace(ROOT, bad))).toBe(true);
      expect(contains(() => safeJoin(ROOT, bad))).toBe(true);
    });
  }

  for (const ok of ORDINARY) {
    it(`both accept and contain: ${ok}`, () => {
      expect(contains(() => resolvePathUnderWorkspace(ROOT, ok))).toBe(true);
      expect(contains(() => safeJoin(ROOT, ok))).toBe(true);
      expect(() => resolvePathUnderWorkspace(ROOT, ok)).not.toThrow();
      expect(() => safeJoin(ROOT, ok)).not.toThrow();
    });
  }

  it("documents the INTENTIONAL philosophy difference (sanitize vs throw)", () => {
    // `~/x`: safeJoin THROWS (home shortcut); resolvePathUnderWorkspace SANITIZES
    // it into a contained literal `~` segment. Both safe (no escape) — pinned so
    // a future 'consolidation' is a conscious, reviewed decision, not silent drift.
    expect(() => safeJoin(ROOT, "~/x")).toThrow();
    expect(() => resolvePathUnderWorkspace(ROOT, "~/x")).not.toThrow();
    // resolvePathUnderWorkspace is also STRICTER on system-like first segments
    // (it blocks them; safeJoin treats them as ordinary relative dirs).
    expect(() => resolvePathUnderWorkspace(ROOT, "Users/me/x")).toThrow();
    expect(() => safeJoin(ROOT, "Users/me/x")).not.toThrow();
  });
});
