/**
 * edit_file replace-matching cascade (v14.8.7 §D).
 *
 * A near-miss `old_content` should self-heal instead of erroring — weak
 * open-weight models rarely reproduce whitespace/escaping exactly. Ported from
 * opencode's battle-tested replacer cascade
 * (atlarix-references/opencode/packages/opencode/src/tool/edit.ts): each
 * `Replacer` yields candidate spans, first UNIQUE non-disproportionate span
 * wins. Uniqueness + disproportion rails ensure we never silently edit the
 * wrong region — the whole point of a fuzzy matcher is precision, not guessing.
 *
 * Pure string functions — no fs, safe to unit-test in isolation.
 */

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

export type ReplacementResult =
  | { kind: "match"; index: number; matchLength: number; fuzzy: boolean }
  /** old_content matched N>1 places — caller asks for more surrounding context. */
  | { kind: "multiple"; occurrences: number }
  /** a fuzzy span ballooned far beyond old_content — refuse rather than corrupt. */
  | { kind: "disproportionate" }
  | { kind: "none" };

// Similarity thresholds for block-anchor fallback matching (opencode parity).
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65;
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65;

function levenshtein(a: string, b: string): number {
  if (a === "" || b === "") return Math.max(a.length, b.length);
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(matrix[i - 1]![j]! + 1, matrix[i]![j - 1]! + 1, matrix[i - 1]![j - 1]! + cost);
    }
  }
  return matrix[a.length]![b.length]!;
}

export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find;
};

export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");
  if (searchLines[searchLines.length - 1] === "") searchLines.pop();

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j]!.trim() !== searchLines[j]!.trim()) {
        matches = false;
        break;
      }
    }
    if (matches) {
      let matchStartIndex = 0;
      for (let k = 0; k < i; k++) matchStartIndex += originalLines[k]!.length + 1;
      let matchEndIndex = matchStartIndex;
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k]!.length;
        if (k < searchLines.length - 1) matchEndIndex += 1;
      }
      yield content.substring(matchStartIndex, matchEndIndex);
    }
  }
};

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");
  if (searchLines.length < 3) return;
  if (searchLines[searchLines.length - 1] === "") searchLines.pop();

  const firstLineSearch = searchLines[0]!.trim();
  const lastLineSearch = searchLines[searchLines.length - 1]!.trim();
  const searchBlockSize = searchLines.length;
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25));

  const candidates: Array<{ startLine: number; endLine: number }> = [];
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i]!.trim() !== firstLineSearch) continue;
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j]!.trim() === lastLineSearch) {
        const actualBlockSize = j - i + 1;
        if (Math.abs(actualBlockSize - searchBlockSize) <= maxLineDelta) {
          candidates.push({ startLine: i, endLine: j });
        }
        break;
      }
    }
  }
  if (candidates.length === 0) return;

  const spanOf = (startLine: number, endLine: number): string => {
    let matchStartIndex = 0;
    for (let k = 0; k < startLine; k++) matchStartIndex += originalLines[k]!.length + 1;
    let matchEndIndex = matchStartIndex;
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k]!.length;
      if (k < endLine) matchEndIndex += 1;
    }
    return content.substring(matchStartIndex, matchEndIndex);
  };

  const middleSimilarity = (startLine: number, endLine: number, averaged: boolean): number => {
    const actualBlockSize = endLine - startLine + 1;
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
    if (linesToCheck <= 0) return 1.0;
    let similarity = 0;
    for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
      const originalLine = originalLines[startLine + j]!.trim();
      const searchLine = searchLines[j]!.trim();
      const maxLen = Math.max(originalLine.length, searchLine.length);
      if (maxLen === 0) continue;
      const distance = levenshtein(originalLine, searchLine);
      similarity += averaged ? 1 - distance / maxLen : (1 - distance / maxLen) / linesToCheck;
      if (!averaged && similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) break;
    }
    return averaged ? similarity / linesToCheck : similarity;
  };

  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]!;
    if (middleSimilarity(startLine, endLine, false) >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      yield spanOf(startLine, endLine);
    }
    return;
  }

  let bestMatch: { startLine: number; endLine: number } | null = null;
  let maxSimilarity = -1;
  for (const candidate of candidates) {
    const similarity = middleSimilarity(candidate.startLine, candidate.endLine, true);
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
      bestMatch = candidate;
    }
  }
  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    yield spanOf(bestMatch.startLine, bestMatch.endLine);
  }
};

export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim();
  const normalizedFind = normalizeWhitespace(find);
  const lines = content.split("\n");

  for (const line of lines) {
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line;
    } else if (normalizeWhitespace(line).includes(normalizedFind)) {
      const words = find.trim().split(/\s+/);
      if (words.length > 0) {
        const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
        try {
          const match = line.match(new RegExp(pattern));
          if (match) yield match[0];
        } catch {
          // invalid regex — skip
        }
      }
    }
  }

  const findLines = find.split("\n");
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length);
      if (normalizeWhitespace(block.join("\n")) === normalizedFind) yield block.join("\n");
    }
  }
};

export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split("\n");
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
    if (nonEmptyLines.length === 0) return text;
    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => line.match(/^(\s*)/)?.[1]?.length ?? 0),
    );
    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n");
  };

  const normalizedFind = removeIndentation(find);
  const contentLines = content.split("\n");
  const findLines = find.split("\n");
  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n");
    if (removeIndentation(block) === normalizedFind) yield block;
  }
};

/** The direct fix for over-escaped `old_content` (v14.8.7 §B). */
export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapedFind = unescapeString(find);
  if (content.includes(unescapedFind)) yield unescapedFind;

  const lines = content.split("\n");
  const findLines = unescapedFind.split("\n");
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (unescapeString(block) === unescapedFind) yield block;
  }
};

export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim();
  if (trimmedFind === find) return;
  if (content.includes(trimmedFind)) yield trimmedFind;

  const lines = content.split("\n");
  const findLines = find.split("\n");
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (block.trim() === trimmedFind) yield block;
  }
};

export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n");
  if (findLines.length < 3) return;
  if (findLines[findLines.length - 1] === "") findLines.pop();

  const contentLines = content.split("\n");
  const firstLine = findLines[0]!.trim();
  const lastLine = findLines[findLines.length - 1]!.trim();

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i]!.trim() !== firstLine) continue;
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j]!.trim() !== lastLine) continue;
      const blockLines = contentLines.slice(i, j + 1);
      if (blockLines.length === findLines.length) {
        let matchingLines = 0;
        let totalNonEmptyLines = 0;
        for (let k = 1; k < blockLines.length - 1; k++) {
          const blockLine = blockLines[k]!.trim();
          const findLine = findLines[k]!.trim();
          if (blockLine.length > 0 || findLine.length > 0) {
            totalNonEmptyLines++;
            if (blockLine === findLine) matchingLines++;
          }
        }
        if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
          yield blockLines.join("\n");
          break;
        }
      }
      break;
    }
  }
};

/** Unescape backslash escape sequences (opencode `unescapeString` parity). */
export function unescapeString(str: string): string {
  return str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar: string) => {
    switch (capturedChar) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "'":
        return "'";
      case '"':
        return '"';
      case "`":
        return "`";
      case "\\":
        return "\\";
      case "\n":
        return "\n";
      case "$":
        return "$";
      default:
        return match;
    }
  });
}

/** Reject a fuzzy span that ballooned well past old_content (opencode parity). */
export function isDisproportionateMatch(search: string, oldString: string): boolean {
  const oldLines = oldString.split("\n").length;
  const searchLines = search.split("\n").length;
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
  if (oldLines === 1) return false;
  return search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

const REPLACERS: Array<[name: string, replacer: Replacer]> = [
  ["exact", SimpleReplacer],
  ["line-trimmed", LineTrimmedReplacer],
  ["block-anchor", BlockAnchorReplacer],
  ["whitespace", WhitespaceNormalizedReplacer],
  ["indentation", IndentationFlexibleReplacer],
  ["escape", EscapeNormalizedReplacer],
  ["trimmed-boundary", TrimmedBoundaryReplacer],
  ["context-aware", ContextAwareReplacer],
];

/**
 * Locate `oldString` in `content` via the escalating cascade. Returns the
 * original-content index + matched length so the caller can splice replacement
 * text directly (mirrors the prior `fuzzyFindString` contract). `fuzzy: true`
 * means a non-exact strategy matched (callers surface a re-read notice).
 *
 * Safety: a non-exact strategy that yields more than one distinct in-content
 * span, or a single span occurring more than once, is treated as ambiguous and
 * skipped (never applied) — we refuse rather than edit the wrong region. Only
 * the EXACT strategy reports `multiple` (the classic "add more context" error).
 */
export function findReplacement(content: string, oldString: string): ReplacementResult {
  if (oldString.length === 0) return { kind: "none" };

  let sawMultiple: number | null = null;
  for (const [name, replacer] of REPLACERS) {
    const found = new Set<string>();
    for (const search of replacer(content, oldString)) {
      if (search && content.includes(search)) found.add(search);
    }
    if (found.size === 0) continue;
    // More than one distinct candidate span for this strategy → ambiguous.
    if (found.size > 1) {
      if (name === "exact") continue; // impossible (SimpleReplacer yields once)
      continue;
    }
    const search = [...found][0]!;
    const occ = countOccurrences(content, search);
    if (occ > 1) {
      if (name === "exact") return { kind: "multiple", occurrences: occ };
      sawMultiple = occ; // remember, but keep trying stricter-unique strategies
      continue;
    }
    if (isDisproportionateMatch(search, oldString)) return { kind: "disproportionate" };
    return {
      kind: "match",
      index: content.indexOf(search),
      matchLength: search.length,
      fuzzy: name !== "exact",
    };
  }
  if (sawMultiple != null) return { kind: "multiple", occurrences: sawMultiple };
  return { kind: "none" };
}
