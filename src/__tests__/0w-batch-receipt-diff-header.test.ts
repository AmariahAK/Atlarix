/**
 * 0w: batched edit receipts — each receipt's diff header must name its own file.
 *
 * Repro: two files (a.txt, b.txt) approved in one batch. The permission preview
 * for each file is merged into the thread via mergeWritePreviewIntoThread. When
 * b.txt's tool item is not yet in the thread, the fallback merges b.txt's content
 * into a.txt's tool item. buildDiffView then reads payload.path ("a.txt") before
 * args.path ("b.txt"), so b.txt's receipt shows "a.txt" in the diff header.
 *
 * Fix: when DISPLAY_PREVIEW_ARG is set in args (a merged preview), prefer
 * pathFromArgs(args) over payload.path.
 */
import { describe, expect, it } from "vitest";
import { buildToolExpandView } from "@/lib/chat/tool-expand-view";
import { DISPLAY_PREVIEW_ARG } from "@/lib/chat/stream-thread";

/**
 * Simulate what mergeWritePreviewIntoThread produces when it merges b.txt's
 * content into a.txt's tool item (the fallback path): the resultText still
 * belongs to a.txt (payload.path = "a.txt"), but the merged args carry
 * path = "b.txt" and DISPLAY_PREVIEW_ARG = true.
 */
function makeResultText(path: string, operation: string): string {
  return JSON.stringify({
    success: true,
    message: `Successfully wrote ${path}`,
    path,
    operation,
    added: 1,
    removed: 0,
  });
}

describe("0w: batched receipt diff header uses its own file's path", () => {
  it("uses args.path when DISPLAY_PREVIEW_ARG is set, even if payload.path differs", () => {
    // a.txt's tool result (payload.path = "a.txt")
    const resultText = makeResultText("a.txt", "create");

    // b.txt's merged args: DISPLAY_PREVIEW_ARG set, path = "b.txt"
    const mergedArgs = {
      path: "b.txt",
      operation: "write",
      content: "This is file b.\n",
      [DISPLAY_PREVIEW_ARG]: true,
    };

    const view = buildToolExpandView("edit_file", mergedArgs, resultText, "done");

    expect(view.kind).toBe("diff");
    if (view.kind === "diff") {
      // The diff header must name b.txt, not a.txt
      expect(view.path).toBe("b.txt");
      expect(view.fileName).toBe("b.txt");
    }
  });

  it("two files approved in one batch each get their own path in the diff view", () => {
    // Simulate the thread after mergeWritePreviewIntoThread for both files.
    // a.txt: correctly merged into its own tool item
    const aArgs = {
      path: "a.txt",
      operation: "write",
      content: "This is file a.\n",
      [DISPLAY_PREVIEW_ARG]: true,
    };
    const aResult = makeResultText("a.txt", "create");
    const aView = buildToolExpandView("edit_file", aArgs, aResult, "done");

    // b.txt: merged into a.txt's tool item (fallback) — resultText has a.txt's path
    const bArgs = {
      path: "b.txt",
      operation: "write",
      content: "This is file b.\n",
      [DISPLAY_PREVIEW_ARG]: true,
    };
    const bResult = makeResultText("a.txt", "create"); // wrong resultText (a.txt's)
    const bView = buildToolExpandView("edit_file", bArgs, bResult, "done");

    expect(aView.kind).toBe("diff");
    expect(bView.kind).toBe("diff");

    if (aView.kind === "diff" && bView.kind === "diff") {
      expect(aView.path).toBe("a.txt");
      expect(aView.fileName).toBe("a.txt");

      // This is the bug: bView.path was "a.txt" before the fix
      expect(bView.path).toBe("b.txt");
      expect(bView.fileName).toBe("b.txt");
    }
  });
});
