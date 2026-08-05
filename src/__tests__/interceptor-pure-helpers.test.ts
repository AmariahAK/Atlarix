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
  ({ __permission_required: true, operation, preview }) as unknown as PermissionRequest;

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

  it("summarizes past the byte cap, leading with errors then warnings", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    lines[100] = "ERROR: something failed";
    lines[200] = "warning: deprecated";
    const out = formatCommandOutput(lines.join("\n"), "", 500);
    expect(out).toContain("=== ERRORS ===");
    expect(out).toContain("ERROR: something failed");
    expect(out).toContain("=== FIRST 5 LINES ===");
    expect(out).toContain("=== LAST 5 LINES ===");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(500);
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
    for (const op of [
      "write_file",
      "edit_file",
      "replace_code",
      "insert_code",
      "delete_lines",
      "delete_file",
    ]) {
      expect(targetPathsForOperation(req(op, { path: "src/a.ts" }))).toEqual([
        "src/a.ts",
      ]);
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

  it("reads an array preview as write_multiple_files", () => {
    expect(
      targetPathsForOperation(
        req("write_multiple_files", [{ path: "a.ts" }, { path: "b.ts" }]),
      ),
    ).toEqual(["a.ts", "b.ts"]);
  });

  it("drops blank and non-string paths instead of emitting empties", () => {
    expect(
      targetPathsForOperation(req("write_file", { path: "   " })),
    ).toEqual([]);
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
