/**
 * Elision-merge (Cursor-style "fast apply", deterministic — no apply-model).
 *
 * The model provides the file's new shape but replaces long UNCHANGED spans with
 * a `// ... existing code ...` marker, so a weak model never has to reproduce
 * exact old text for the parts it isn't touching. We stitch the sketch back into
 * the real file by anchoring the lines ADJACENT to each marker against the
 * original and keeping the elided original content between them.
 *
 * Contract (enforced — we REFUSE rather than corrupt): the line immediately
 * before and after each marker must be an UNCHANGED line that still exists in
 * the file, so the kept region can be located. Changes live in the middle of
 * concrete blocks, away from markers.
 */

/** A line that is just an ellipsis comment ("// ... existing code ...", "# …", a bare "..."). */
export function isElisionMarker(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (!/(\.{3}|…)/.test(t)) return false; // must carry an ellipsis
  const body = t
    .replace(/^(?:\/\/+|#+|--+|;+|\/\*+|\*+|<!--)\s*/, "")
    .replace(/\s*(?:\*\/|-->)\s*$/, "")
    .trim();
  // Essentially just an ellipsis, optionally "... existing code ..." style.
  return (
    /^(?:\.{3}|…)(\s*(?:existing|unchanged|rest|code|keep|snip|omitted|previous|same|more|below|above|here)[\w -]*)?\s*(?:\.{3}|…)?$/i.test(
      body,
    ) ||
    /^(?:existing|unchanged|rest|code)[\w -]*(?:\.{3}|…)/i.test(body)
  );
}

function firstNonEmpty(block: string): string {
  return block.split("\n").find((l) => l.trim().length > 0) ?? "";
}
function lastNonEmpty(block: string): string {
  const lines = block.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim().length > 0) return lines[i];
  return "";
}

export type MergeResult =
  | { ok: true; merged: string; fullRewrite: boolean }
  | { ok: false; error: string };

/**
 * Stitch an elision `sketch` into `original`. If the sketch has no markers it's
 * a full rewrite (returned verbatim, `fullRewrite:true`).
 */
export function mergeElision(original: string, sketch: string): MergeResult {
  const sketchLines = sketch.split("\n");

  // Partition into concrete blocks separated by markers; track leading/trailing.
  const segments: string[] = [];
  let cur: string[] = [];
  let markerCount = 0;
  let leadingElision = false;
  let trailingElision = false;
  let seenConcrete = false;
  for (const ln of sketchLines) {
    if (isElisionMarker(ln)) {
      markerCount++;
      if (!seenConcrete) leadingElision = true;
      else if (cur.length) {
        segments.push(cur.join("\n"));
        cur = [];
      }
      trailingElision = true;
    } else {
      cur.push(ln);
      if (ln.trim().length > 0) {
        seenConcrete = true;
        trailingElision = false;
      }
    }
  }
  if (cur.length) segments.push(cur.join("\n"));

  if (markerCount === 0) {
    return { ok: true, merged: sketch, fullRewrite: true };
  }
  if (segments.length === 0) {
    return {
      ok: false,
      error: "The merge content is only elision markers — include the actual changed code between them.",
    };
  }

  const origLines = original.split("\n");
  const findLine = (needle: string, from: number): number => {
    const t = needle.trim();
    if (!t) return -1;
    for (let i = from; i < origLines.length; i++) {
      if (origLines[i].trim() === t) return i;
    }
    return -1;
  };
  const anchorFail = (which: string, needle: string) => ({
    ok: false as const,
    error: `Could not anchor ${which} ("${needle.trim().slice(0, 60)}") in the file. The line ${which} a "... existing code ..." marker must be an UNCHANGED line copied verbatim from the file, so the kept region can be located. Re-read the file and retry.`,
  });

  const out: string[] = [];
  let origCursor = 0;

  // Leading marker → keep the original head up to where the first block begins.
  if (leadingElision) {
    const firstLine = firstNonEmpty(segments[0]);
    const idx = findLine(firstLine, 0);
    if (idx < 0) return anchorFail("after", firstLine);
    out.push(...origLines.slice(0, idx));
    origCursor = idx;
  }

  for (let s = 0; s < segments.length; s++) {
    out.push(segments[s]);

    const isLast = s === segments.length - 1;
    const hasGapAfter = !isLast || trailingElision;
    if (!hasGapAfter) break;

    // Advance the original cursor past this block by anchoring its last line.
    const lastLine = lastNonEmpty(segments[s]);
    const li = findLine(lastLine, origCursor);
    if (li < 0) return anchorFail("before", lastLine);
    origCursor = li + 1;

    if (!isLast) {
      // Keep original content between this block and the next.
      const nextFirst = firstNonEmpty(segments[s + 1]);
      const ni = findLine(nextFirst, origCursor);
      if (ni < 0) return anchorFail("after", nextFirst);
      out.push(...origLines.slice(origCursor, ni));
      origCursor = ni;
    } else {
      // Trailing marker → keep the rest of the file.
      out.push(...origLines.slice(origCursor));
      origCursor = origLines.length;
    }
  }

  return { ok: true, merged: out.join("\n"), fullRewrite: false };
}
