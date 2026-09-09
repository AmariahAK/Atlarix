/**
 * An edit to an existing file must not render as **Create · (new file)**.
 *
 * OBSERVED 2026-08-29 on a real turn: a 16-line change to
 * `internal/api/passkey_authentication.go` — a file that had existed all along —
 * showed `+16` on the collapsed row and, on expanding, a green **Create** chip,
 * a `+++ … (new file)` header and a single empty added line. `git diff --stat`
 * said 17 insertions / 1 deletion.
 *
 * Both numbers come from the SAME object: the row prints `view.addedCount` (16,
 * taken from the payload and correct) while `SmartDiffView` recomputes its own
 * count from `oldContent`/`newContent` and got 1. So the counts were never the
 * problem — the CONTENT was, and the operation label was guessed from it.
 *
 * Two independent defects, either of which reproduces it:
 *   1. `edit_file`'s operation enum is `write | replace | merge`. None was
 *      matched, so the tool's own answer was thrown away on every edit.
 *   2. The multi-edit `edits: [{old_content, new_content}]` form was never read,
 *      so both contents arrived empty and the guess fell through to "create".
 *
 * Wrong in the worst direction: "new file" is the label you skim past.
 */
import { describe, expect, it } from "vitest";

import { buildToolExpandView } from "@/lib/chat/tool-expand-view";

/**
 * The result payload deliberately carries NO `operation` field. Existing coverage
 * always supplied one, which is why the enum gap never showed there — the real
 * result only reports success and the line counts, leaving the tool's own
 * `operation` arg as the only source, and that was the one being discarded.
 */
const diffView = (
  args: unknown,
  result: Record<string, unknown> = { success: true, added: 16, removed: 1 },
) => {
  const view = buildToolExpandView(
    "edit_file",
    args,
    JSON.stringify(result),
    "done",
  );
  if (view.kind !== "diff")
    throw new Error(`expected a diff view, got ${view.kind}`);
  return view;
};

describe("edit_file expand view", () => {
  it("calls a replace an update even with no content to inspect — THE BUG", () => {
    // The exact shape that rendered "Create · (new file)": operation present,
    // content carried in `edits`, nothing at the top level.
    const view = diffView({
      path: "internal/api/passkey_authentication.go",
      operation: "replace",
    });
    expect(view.operation).toBe("update");
  });

  it("reads the multi-edit `edits` array, so the body is the real change", () => {
    const view = diffView({
      path: "internal/api/passkey_authentication.go",
      operation: "replace",
      edits: [
        {
          old_content: "if !flagsMatch {",
          new_content: "if !flagsMatch && strict {",
        },
      ],
    });

    expect(view.oldContent).toContain("if !flagsMatch {");
    expect(view.newContent).toContain("strict");
    expect(view.operation).toBe("update");
  });

  it("joins several edits rather than showing only the first", () => {
    const view = diffView({
      path: "a.go",
      operation: "replace",
      edits: [
        { old_content: "one", new_content: "ONE" },
        { old_content: "two", new_content: "TWO" },
      ],
    });
    expect(view.oldContent).toBe("one\ntwo");
    expect(view.newContent).toBe("ONE\nTWO");
  });

  it("merge is an update too — it needs a file to merge into", () => {
    expect(diffView({ path: "a.go", operation: "merge" }).operation).toBe(
      "update",
    );
  });

  it("write stays ambiguous: a create with no prior content, an update with it", () => {
    // `write` genuinely does both, so it is the one operation still entitled to
    // consult the content.
    expect(
      diffView({ path: "new.go", operation: "write", content: "package main" })
        .operation,
    ).toBe("create");
    expect(
      diffView({
        path: "old.go",
        operation: "write",
        old_content: "package main",
        content: "package main // edited",
      }).operation,
    ).toBe("update");
  });

  it("keeps the payload's authoritative line counts", () => {
    // These were always right; the fix must not start recomputing them from the
    // snippet text, which would report the spans rather than the change.
    const view = diffView({
      path: "a.go",
      operation: "replace",
      edits: [{ old_content: "x", new_content: "y" }],
    });
    expect(view.addedCount).toBe(16);
    expect(view.removedCount).toBe(1);
  });
});
