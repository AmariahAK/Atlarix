/**
 * edit_file over-escape detection + repair (v14.8.7 §B).
 *
 * Live-observed bug: open-weight models (3 Qwens + DeepSeek) over-escape their
 * native-FC JSON tool args — a whole file body arrives collapsed onto one
 * physical line with literal backslash-n (`\n`, two chars) where real newlines
 * were intended. The write path applies zero transforms, so those literals hit
 * disk verbatim, and the models cannot self-recover. The AI-SDK JSON parse is a
 * faithful round-trip, so this is always model-emitted — the fix lives here.
 *
 * Policy (chosen with the user): auto-repair ONLY when we are confident, never
 * silently rewrite a file that legitimately contains a `\n` escape sequence
 * (e.g. `const s = "a\nb"` on one line, docs about escaping). Three verdicts:
 *   - "ok":        no confident over-escape signal → write verbatim (default).
 *   - "repair":    unmistakable collapse → unescape + surface a notice.
 *   - "ambiguous": structural literal `\n` mixed WITH real newlines → hard-block
 *                  with an actionable message so the model re-sends clean.
 *
 * Pure — no fs, safe to unit-test.
 */

import { unescapeString } from "./edit-match";

export type EscapeVerdict = "ok" | "repair" | "ambiguous";

// A literal backslash-n (the two characters 0x5C 0x6E), not a real newline.
const LITERAL_NEWLINE = /\\n/g;

/**
 * Literal `\n` at a plausible STATEMENT boundary — the signature of a real line
 * break the model escaped, as opposed to a `\n` inside a normal string literal
 * (which sits between word chars, e.g. `"a\nb"`). Two code-specific shapes:
 *   - after a terminator/opener: `;\n`  `{\n`  `}\n`  `,\n`  `)\n`  `>\n`
 *   - a literal `\n` followed by INDENTATION (2+ spaces/tabs) then code — i.e. a
 *     new indented line, which prose ("use \n for x", one space) does not match.
 * Deliberately conservative: a false negative just skips repair; a false
 * positive would block/rewrite a legit file.
 */
const STRUCTURAL_LITERAL_NEWLINE = /(?:[;{},)>]\s*\\n)|(?:\\n[ \t]{2,}\S)/g;

function count(re: RegExp, s: string): number {
  return (s.match(re) || []).length;
}

/**
 * Verdict for a block of content the tool is about to write.
 * - "repair": ≥2 structural literal newlines AND zero real newlines (the whole
 *   body collapsed to one line — near-certain over-escape).
 * - "ambiguous": ≥1 structural literal newline AND ≥1 real newline (partial
 *   over-escape — too risky to auto-fix; ask the model to re-send).
 * - "ok": everything else, including a lone `"a\nb"` string literal.
 */
export function analyzeEscaping(content: string): EscapeVerdict {
  if (count(LITERAL_NEWLINE, content) === 0) return "ok";
  const structural = count(STRUCTURAL_LITERAL_NEWLINE, content);
  if (structural === 0) return "ok";
  const realNewlines = count(/\n/g, content);
  if (realNewlines === 0 && structural >= 2) return "repair";
  if (realNewlines > 0) return "ambiguous";
  // Exactly one structural literal newline on a single physical line — not
  // confident enough to rewrite; leave it verbatim.
  return "ok";
}

/** Unescape an over-escaped body (only call when analyzeEscaping === "repair"). */
export function repairOverEscaped(content: string): string {
  return unescapeString(content);
}

export const OVER_ESCAPE_REPAIR_NOTICE =
  "Auto-corrected over-escaped content: literal `\\n`/`\\t` sequences were converted to real line breaks (the model appears to have double-escaped its tool arguments). Review the diff to confirm.";

export const OVER_ESCAPE_AMBIGUOUS_ERROR =
  "Content appears partially over-escaped — it mixes real line breaks with literal `\\n` at statement boundaries. Re-send this edit using REAL newlines (a real line break, not the two characters backslash-n). Do not escape newlines inside the tool argument.";
