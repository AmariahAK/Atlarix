/**
 * Per-hunk diff accept/reject (v10)
 * =================================
 * Real line-based hunks via the `diff` package (LCS), plus pure composition of
 * a partial file from a selected subset of hunks. Used by SmartDiffView's
 * selectable mode and the inline approval flow — approving only some hunks
 * writes `composeContentFromHunks(old, new, selected)` instead of the full
 * proposed content.
 */

import { structuredPatch } from "diff";

export type DiffHunkLine = {
  type: "context" | "add" | "remove";
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
};

export type DiffHunk = {
  /** 0-based index within the hunk list. */
  index: number;
  /** 1-based first line in the OLD content covered by this hunk (incl. context). */
  oldStart: number;
  /** Number of OLD lines covered (incl. context). */
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffHunkLine[];
  addedCount: number;
  removedCount: number;
};

const DEFAULT_CONTEXT = 3;

/** Compute real (LCS) hunks between two file versions, with line numbers. */
export function computeDiffHunks(
  oldContent: string,
  newContent: string,
  context: number = DEFAULT_CONTEXT,
): DiffHunk[] {
  const patch = structuredPatch("a", "b", oldContent, newContent, "", "", {
    context,
  });
  return patch.hunks.map((h, index) => {
    let oldLine = h.oldStart;
    let newLine = h.newStart;
    let addedCount = 0;
    let removedCount = 0;
    const lines: DiffHunkLine[] = [];
    for (const raw of h.lines) {
      const marker = raw[0];
      // "\ No newline at end of file" markers are metadata, not content.
      if (marker === "\\") continue;
      const content = raw.slice(1);
      if (marker === "+") {
        lines.push({ type: "add", content, newLineNum: newLine });
        newLine++;
        addedCount++;
      } else if (marker === "-") {
        lines.push({ type: "remove", content, oldLineNum: oldLine });
        oldLine++;
        removedCount++;
      } else {
        lines.push({
          type: "context",
          content,
          oldLineNum: oldLine,
          newLineNum: newLine,
        });
        oldLine++;
        newLine++;
      }
    }
    return {
      index,
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines,
      addedCount,
      removedCount,
    };
  });
}

/**
 * Build the file content that results from applying ONLY the selected hunks
 * of the old→new diff. Selecting every hunk returns `newContent` verbatim;
 * selecting none returns `oldContent` verbatim.
 */
export function composeContentFromHunks(
  oldContent: string,
  newContent: string,
  selectedHunkIndices: ReadonlySet<number> | readonly number[],
  context: number = DEFAULT_CONTEXT,
): string {
  const selected =
    selectedHunkIndices instanceof Set
      ? selectedHunkIndices
      : new Set(selectedHunkIndices);
  const hunks = computeDiffHunks(oldContent, newContent, context);
  if (hunks.length === 0) return newContent;
  if (selected.size === 0) return oldContent;
  if (hunks.every((h) => selected.has(h.index))) return newContent;

  const oldLines = oldContent.split("\n");
  const out = [...oldLines];
  // Apply from the bottom up so earlier splices don't shift later offsets.
  for (let i = hunks.length - 1; i >= 0; i--) {
    const hunk = hunks[i]!;
    if (!selected.has(hunk.index)) continue;
    const replacement = hunk.lines
      .filter((l) => l.type !== "remove")
      .map((l) => l.content);
    out.splice(hunk.oldStart - 1, hunk.oldLines, ...replacement);
  }
  return out.join("\n");
}
