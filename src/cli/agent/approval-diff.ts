/**
 * The diff an edit approval shows: computed from the preview's old and new
 * contents with the desktop's own hunks (src/lib/diff/compose-hunks.ts), the
 * same view the app's approval card draws.
 *
 * `preview.diff` is NOT reliably text: edit_file sends a summary object
 * ({ added, removed, old_snippet, new_snippet }) there despite the schema's
 * "unified diff" string. Treating it as text crashed the CLI's prompt
 * (`p.diff.split is not a function`), so it is only used when it really is one.
 */
import { computeDiffHunks } from "@/lib/diff/compose-hunks";

export interface DiffLine {
  kind: "add" | "remove" | "context" | "gap";
  text: string;
}

export interface ApprovalDiff {
  lines: DiffLine[];
  /** Lines left out of `lines`. */
  more: number;
  added: number;
  removed: number;
}

interface PreviewLike {
  type?: unknown;
  content?: unknown;
  oldContent?: unknown;
  diff?: unknown;
}

export function approvalDiff(p: PreviewLike, maxLines = 14): ApprovalDiff | null {
  const all: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  if (typeof p.content === "string" && (typeof p.oldContent === "string" || p.type === "create")) {
    const hunks = computeDiffHunks(typeof p.oldContent === "string" ? p.oldContent : "", p.content, 2);
    hunks.forEach((h, i) => {
      if (i > 0) all.push({ kind: "gap", text: "⋯" });
      for (const l of h.lines) {
        const num = l.type === "remove" ? l.oldLineNum : l.newLineNum;
        const mark = l.type === "add" ? "+" : l.type === "remove" ? "-" : " ";
        all.push({ kind: l.type, text: `${String(num ?? "").padStart(4)} ${mark} ${l.content}` });
      }
      added += h.addedCount;
      removed += h.removedCount;
    });
  } else if (typeof p.diff === "string" && p.diff.trim()) {
    for (const l of p.diff.split("\n")) {
      if (l.startsWith("+++") || l.startsWith("---")) continue;
      const kind = l.startsWith("+") ? "add" : l.startsWith("-") ? "remove" : l.startsWith("@@") ? "gap" : "context";
      if (kind === "add") added++;
      if (kind === "remove") removed++;
      all.push({ kind, text: l });
    }
  }
  if (all.length === 0) return null;
  return { lines: all.slice(0, maxLines), more: Math.max(0, all.length - maxLines), added, removed };
}
