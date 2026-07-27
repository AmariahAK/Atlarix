/**
 * Reviewing writer sub-agent proposals (v14.21.0).
 *
 * Three jobs, all in service of one rule: the MAIN agent decides, and the
 * harness writes the sub-agent's exact bytes. Nothing here ever asks a model to
 * re-type a file.
 *
 *   1. format  — turn a proposal set into per-file unified diffs the main agent
 *                can actually read (the old path pasted ONE 20K-capped diff for
 *                the whole set, so a large first file starved the rest).
 *   2. conflict — when two sub-agents touch the same file, say whether their
 *                changes are disjoint (both can land) or overlapping (a human
 *                judgement the main agent has to make).
 *   3. rebase  — at accept time the file may have moved under the proposal.
 *                Re-anchor each hunk against what is on disk NOW; refuse the
 *                file if any hunk's context is gone.
 *
 * The refusal in (3) is deliberate. A wrong silent merge produces a file nobody
 * reviewed; a refusal produces a message the model can act on.
 */

import { computeDiffHunks, type DiffHunk } from "@/lib/diff/compose-hunks";
import type { ProposalSet, ProposedFile } from "./subagent-proposals";

/**
 * Per-file cap on the diff text handed to the model. Applied per FILE, not to
 * the set: the old single 20K budget meant one big file could consume the whole
 * allowance and later files arrived empty.
 */
export const MAX_FILE_DIFF_CHARS = 8_000;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Formatting
// ─────────────────────────────────────────────────────────────────────────────

/** Render hunks as a standard unified diff body. */
export function formatUnifiedDiff(
  relPath: string,
  oldContent: string,
  newContent: string,
  maxChars: number = MAX_FILE_DIFF_CHARS,
): { text: string; added: number; removed: number; truncated: boolean } {
  const hunks = computeDiffHunks(oldContent, newContent);
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    added += h.addedCount;
    removed += h.removedCount;
  }

  const out: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines) {
      const marker = l.type === "add" ? "+" : l.type === "remove" ? "-" : " ";
      out.push(marker + l.content);
    }
  }

  let text = out.join("\n");
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + "\n…[diff truncated — read the file to see the rest]";
    truncated = true;
  }
  return { text, added, removed, truncated };
}

export interface ProposalFileView {
  relPath: string;
  type: "create" | "update";
  added: number;
  removed: number;
  diff: string;
  truncated: boolean;
}

export function buildProposalFileViews(set: ProposalSet): ProposalFileView[] {
  const views: ProposalFileView[] = [];
  for (const f of set.files.values()) {
    const { text, added, removed, truncated } = formatUnifiedDiff(
      f.relPath,
      f.baseContent ?? "",
      f.content,
    );
    views.push({
      relPath: f.relPath,
      type: f.type,
      added,
      removed,
      diff: text,
      truncated,
    });
  }
  // Stable, reviewable order.
  views.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return views;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Conflicts between two sub-agents
// ─────────────────────────────────────────────────────────────────────────────

/** Line ranges (1-based, in BASE coordinates) that a proposal actually changes. */
function changedBaseRanges(f: ProposedFile): Array<[number, number]> {
  const hunks = computeDiffHunks(f.baseContent ?? "", f.content);
  const ranges: Array<[number, number]> = [];
  for (const h of hunks) {
    // Narrow each hunk to the lines it really touches — the surrounding context
    // is not a change, and counting it would flag adjacent-but-disjoint edits.
    let lo = Infinity;
    let hi = -Infinity;
    for (const l of h.lines) {
      if (l.type === "remove" && l.oldLineNum != null) {
        lo = Math.min(lo, l.oldLineNum);
        hi = Math.max(hi, l.oldLineNum);
      } else if (l.type === "add") {
        // A pure insertion has no old line; anchor it between its neighbours.
        lo = Math.min(lo, h.oldStart);
        hi = Math.max(hi, h.oldStart);
      }
    }
    if (lo !== Infinity) ranges.push([lo, hi]);
  }
  return ranges;
}

function rangesOverlap(
  a: Array<[number, number]>,
  b: Array<[number, number]>,
): boolean {
  for (const [aLo, aHi] of a) {
    for (const [bLo, bHi] of b) {
      if (aLo <= bHi && bLo <= aHi) return true;
    }
  }
  return false;
}

export interface ProposalConflict {
  relPath: string;
  /** Agent names, in the order their sets were created. */
  agents: string[];
  /** True when their changed line ranges actually overlap in the base file. */
  overlapping: boolean;
}

/**
 * Files touched by more than one of `sets`, and whether the touches collide.
 *
 * Disjoint touches are NOT a conflict: accepting both works, because the second
 * accept rebases onto the first one's result (see `rebaseOntoCurrent`).
 */
export function findProposalConflicts(sets: ProposalSet[]): ProposalConflict[] {
  const byPath = new Map<string, Array<{ set: ProposalSet; file: ProposedFile }>>();
  for (const set of sets) {
    for (const [fullPath, file] of set.files) {
      const list = byPath.get(fullPath) ?? [];
      list.push({ set, file });
      byPath.set(fullPath, list);
    }
  }

  const conflicts: ProposalConflict[] = [];
  for (const [, entries] of byPath) {
    if (entries.length < 2) continue;
    const ranges = entries.map((e) => changedBaseRanges(e.file));
    let overlapping = false;
    for (let i = 0; i < ranges.length && !overlapping; i++) {
      for (let j = i + 1; j < ranges.length && !overlapping; j++) {
        if (rangesOverlap(ranges[i], ranges[j])) overlapping = true;
      }
    }
    conflicts.push({
      relPath: entries[0].file.relPath,
      agents: entries.map((e) => e.set.agentName),
      overlapping,
    });
  }
  return conflicts;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Rebase at accept time
// ─────────────────────────────────────────────────────────────────────────────

export type RebaseResult =
  | { ok: true; content: string; rebased: boolean }
  | { ok: false; reason: string; failingHunks: string[] };

/** The OLD side of a hunk (context + removed lines), in order. */
function hunkOldSide(h: DiffHunk): string[] {
  return h.lines.filter((l) => l.type !== "add").map((l) => l.content);
}

/** The NEW side of a hunk (context + added lines), in order. */
function hunkNewSide(h: DiffHunk): string[] {
  return h.lines.filter((l) => l.type !== "remove").map((l) => l.content);
}

/** Every index where `needle` occurs as a contiguous run in `hay`. */
function findAllRuns(hay: string[], needle: string[]): number[] {
  if (needle.length === 0 || needle.length > hay.length) return [];
  const hits: number[] = [];
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) hits.push(i);
  }
  return hits;
}

function renderHunkForError(h: DiffHunk): string {
  const head = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
  const body = h.lines
    .slice(0, 12)
    .map((l) => (l.type === "add" ? "+" : l.type === "remove" ? "-" : " ") + l.content)
    .join("\n");
  return `${head}\n${body}`;
}

/**
 * Re-anchor a proposal onto the file as it exists NOW.
 *
 * `base` is the content when the sub-agent first touched the file, `proposed`
 * is what it wants, `current` is disk. When base === current this is a no-op
 * and returns `proposed` verbatim — the common case, and it stays byte-exact.
 *
 * Otherwise each hunk is located by its own context. A hunk that matches
 * exactly once is applied; anything else (missing, ambiguous, or overlapping
 * another applied hunk) fails the whole file. Partial application would leave a
 * file in a state neither the sub-agent nor the reviewer ever saw.
 */
export function rebaseOntoCurrent(
  base: string,
  proposed: string,
  current: string,
): RebaseResult {
  if (current === base) return { ok: true, content: proposed, rebased: false };
  if (current === proposed) return { ok: true, content: proposed, rebased: false };

  const hunks = computeDiffHunks(base, proposed);
  if (hunks.length === 0) {
    // Nothing proposed, but disk moved — keep disk.
    return { ok: true, content: current, rebased: true };
  }

  const currentLines = current.split("\n");
  type Placed = { at: number; oldLen: number; newSide: string[]; hunk: DiffHunk };
  const placed: Placed[] = [];
  const failing: DiffHunk[] = [];

  for (const h of hunks) {
    const oldSide = hunkOldSide(h);
    if (oldSide.length === 0) {
      // No context and no removals — nothing to anchor against.
      failing.push(h);
      continue;
    }
    const hits = findAllRuns(currentLines, oldSide);
    if (hits.length !== 1) {
      failing.push(h);
      continue;
    }
    placed.push({
      at: hits[0],
      oldLen: oldSide.length,
      newSide: hunkNewSide(h),
      hunk: h,
    });
  }

  if (failing.length > 0) {
    return {
      ok: false,
      reason:
        `${failing.length} of ${hunks.length} proposed change(s) no longer match this file — ` +
        "it was modified after the sub-agent read it.",
      failingHunks: failing.map(renderHunkForError),
    };
  }

  // Two hunks landing on the same lines means the proposal contradicts itself
  // against the current file; splicing both would corrupt it.
  placed.sort((a, b) => a.at - b.at);
  for (let i = 1; i < placed.length; i++) {
    const prev = placed[i - 1];
    if (placed[i].at < prev.at + prev.oldLen) {
      return {
        ok: false,
        reason:
          "Two proposed changes re-anchor onto overlapping lines of the current file — " +
          "the change can't be applied unambiguously.",
        failingHunks: [renderHunkForError(prev.hunk), renderHunkForError(placed[i].hunk)],
      };
    }
  }

  // Splice bottom-up so earlier indices stay valid.
  const out = currentLines.slice();
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i];
    out.splice(p.at, p.oldLen, ...p.newSide);
  }
  return { ok: true, content: out.join("\n"), rebased: true };
}
