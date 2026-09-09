/**
 * Characterization tests for the pure helpers inside `PermissionInterceptor`.
 *
 * Written BEFORE those helpers were extracted out of the 2,128-line class, and
 * deliberately asserting current behaviour rather than desired behaviour — the
 * point is to catch a change in what the model sees, not to improve it. They ran
 * green against the private methods first, then against the extracted modules.
 *
 * `formatCommandOutput` is what every non-trivial command result passes through
 * on its way to the model, and it had no direct coverage at all.
 */
import { describe, it, expect } from "vitest";
import {
  formatCommandOutput,
  resolveMaxOutputBytes,
} from "@/ipc/handlers/permissions/command-output";
import { targetPathsForOperation } from "@/ipc/handlers/permissions/operation-targets";
import type { PermissionRequest } from "@/lib/tools/permissions/schema";

const req = (operation: string, preview: unknown): PermissionRequest =>
  ({
    __permission_required: true,
    operation,
    preview,
  }) as unknown as PermissionRequest;

describe("formatCommandOutput", () => {
  it("returns a marker rather than an empty string when nothing was output", () => {
    expect(formatCommandOutput("", "", 80_000)).toBe("(no output)");
    expect(formatCommandOutput("   \n  ", "", 80_000)).toBe("(no output)");
  });

  it("passes short output through untouched", () => {
    expect(formatCommandOutput("hello", "", 80_000)).toBe("hello");
    expect(formatCommandOutput("", "boom", 80_000)).toBe("boom");
  });

  it("labels both streams only when both have content", () => {
    const both = formatCommandOutput("out", "err", 80_000);
    expect(both).toContain("=== STDOUT ===");
    expect(both).toContain("=== STDERR ===");
    // One stream alone is NOT labelled — the model gets the bare text.
    expect(formatCommandOutput("out", "", 80_000)).toBe("out");
  });

  /**
   * REWRITTEN, not deleted. The previous version pinned the old shape — errors,
   * then warnings, then "FIRST 5 LINES", then "LAST 5 LINES" — which is exactly
   * the behaviour that had to change, so it correctly failed the fix.
   *
   * That shape ignored the budget: with the 80,000-byte default it returned about
   * 550 bytes, under 1% of the allowance, and models responded by declaring the
   * output truncated and re-running the command redirected to a file. It also
   * reordered the output, so for anything log-shaped the sequence — which IS the
   * information — was unreadable.
   */
  it("FILLS the byte budget instead of collapsing to a fixed ten lines", () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i}`);
    const out = formatCommandOutput(lines.join("\n"), "", 8000);

    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(8000);
    // The old shape yielded ~13 lines whatever the budget. Using most of an 8 KB
    // allowance means hundreds.
    expect(out.split("\n").length).toBeGreaterThan(200);
    expect(Buffer.byteLength(out, "utf8")).toBeGreaterThan(6000);
  });

  it("keeps output IN ORDER — head, then a gap notice, then tail", () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i}`);
    const out = formatCommandOutput(lines.join("\n"), "", 2000);

    expect(out.indexOf("line 0")).toBeGreaterThanOrEqual(0);
    expect(out).toContain("line 3999");
    // Head strictly before tail, and the gap declared between them.
    expect(out.indexOf("line 0")).toBeLessThan(out.indexOf("omitted"));
    expect(out.indexOf("omitted")).toBeLessThan(out.indexOf("line 3999"));
  });

  it("says HOW MUCH it dropped, so sampled output cannot pass as complete", () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i}`);
    const out = formatCommandOutput(lines.join("\n"), "", 2000);
    expect(out).toMatch(/omitted \d+ line\(s\) in the middle/);
  });

  it("surfaces error lines that fell in the omitted middle, labelled as such", () => {
    // A compile error in the middle of a long build is the one thing worth
    // breaking order for — but the reader has to be told that is what happened.
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i}`);
    lines[2000] = "ERROR: something failed in the middle";
    const out = formatCommandOutput(lines.join("\n"), "", 2000);

    expect(out).toContain("ERROR: something failed in the middle");
    expect(out).toMatch(/error line\(s\) from the omitted middle/);
    // Appended AFTER the ordered body, not spliced into it.
    expect(out.indexOf("line 0")).toBeLessThan(
      out.indexOf("ERROR: something failed in the middle"),
    );
  });

  it("adds no gap notice when everything fits", () => {
    const out = formatCommandOutput("a\nb\nc", "", 80_000);
    expect(out).toBe("a\nb\nc");
    expect(out).not.toContain("omitted");
  });

  it("counts BYTES, not characters — a multibyte tail is never split mid-rune", () => {
    // The cap is a UTF-8 byte budget; slicing by character count would let a
    // 3-byte glyph straddle the boundary and reach the model as U+FFFD.
    const out = formatCommandOutput("字".repeat(5000), "", 600);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(600);
    expect(out).not.toContain("�");
  });

  it("says WHY it truncated, so the model can raise the cap itself", () => {
    const out = formatCommandOutput("x".repeat(200_000), "", 2000);
    expect(out).toContain("max_output_bytes");
  });
});

describe("resolveMaxOutputBytes", () => {
  it("defaults to 80k and clamps to [1024, 1_000_000]", () => {
    expect(resolveMaxOutputBytes(undefined)).toBe(80_000);
    expect(resolveMaxOutputBytes(0)).toBe(80_000); // falsy → default, not 1024
    expect(resolveMaxOutputBytes(50)).toBe(1024);
    expect(resolveMaxOutputBytes(5_000_000)).toBe(1_000_000);
    expect(resolveMaxOutputBytes(40_000)).toBe(40_000);
  });

  it("treats junk as the default rather than NaN", () => {
    expect(resolveMaxOutputBytes("nonsense" as unknown as number)).toBe(80_000);
  });
});

describe("targetPathsForOperation", () => {
  it("collects the single path for ordinary file operations", () => {
    for (const op of ["edit_file", "delete_file"]) {
      expect(targetPathsForOperation(req(op, { path: "src/a.ts" }))).toEqual([
        "src/a.ts",
      ]);
    }
  });

  /**
   * The `default` branch fails CLOSED, and that is the point of it.
   *
   * It used to `break` with nothing pushed — which sounds harmless and is the
   * opposite: this file's header states that a path missing from the list is a
   * path that is never gated, so an unrecognized operation had its targets checked
   * against nothing. It never bit only because every operation happened to be
   * listed, which made removing the dead ones (`write_file`, `replace_code`,
   * `insert_code`, `delete_lines` — no producer since v13.8) a fail-open change
   * waiting to happen.
   */
  it("still yields targets for an operation the switch does not know", () => {
    expect(
      targetPathsForOperation(req("some_future_file_op", { path: "src/a.ts" })),
    ).toEqual(["src/a.ts"]);
  });

  it("yields both endpoints for an unknown operation that renames", () => {
    expect(
      targetPathsForOperation(
        req("some_future_move_op", { fromPath: "a.ts", toPath: "b.ts" }),
      ),
    ).toEqual(["a.ts", "b.ts"]);
  });

  // The removed names are no longer special-cased, but they are still gated —
  // by the fail-closed default rather than by a label of their own.
  it("still gates the retired operation names via that default", () => {
    for (const op of [
      "write_file",
      "replace_code",
      "insert_code",
      "delete_lines",
    ]) {
      expect(
        targetPathsForOperation(req(op, { path: "src/a.ts" })),
        op,
      ).toEqual(["src/a.ts"]);
    }
  });

  it("collects BOTH endpoints of a rename", () => {
    // A rename can carry a file across the workspace boundary in either
    // direction; missing one endpoint means an ungranted target is never gated.
    expect(
      targetPathsForOperation(
        req("rename_file", { fromPath: "/out/a.ts", toPath: "src/b.ts" }),
      ),
    ).toEqual(["/out/a.ts", "src/b.ts"]);
  });

  it("descends into batch_plan children", () => {
    // batch_plan re-dispatches per sub-operation. If its children were not
    // collected here the batch would ask for nothing, then throw part-way
    // through having already applied the earlier items.
    expect(
      targetPathsForOperation(
        req("batch_plan", {
          operations: [
            { path: "a.ts" },
            { fromPath: "b.ts", toPath: "c.ts" },
            { path: "" },
          ],
        }),
      ),
    ).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  // Keyed on SHAPE, not on an operation name. `write_multiple_files` (the only
  // op that ever sent an array) is gone, and the branch stays because it fails
  // CLOSED: an array that fell through to the per-operation switch would yield
  // no targets, and no targets means the containment check has nothing to check.
  // So this deliberately passes an operation name the switch does not know.
  it("reads ANY array preview as a list of targets, whatever the operation", () => {
    expect(
      targetPathsForOperation(
        req("some_future_batch_op", [{ path: "a.ts" }, { path: "b.ts" }]),
      ),
    ).toEqual(["a.ts", "b.ts"]);
  });

  it("drops blank and non-string paths instead of emitting empties", () => {
    expect(targetPathsForOperation(req("write_file", { path: "   " }))).toEqual(
      [],
    );
    expect(targetPathsForOperation(req("write_file", {}))).toEqual([]);
    expect(
      targetPathsForOperation(req("write_file", { path: 42 as never })),
    ).toEqual([]);
  });

  it("returns nothing for operations that carry no path", () => {
    expect(
      targetPathsForOperation(req("run_command", { command: "ls" })),
    ).toEqual([]);
  });
});
