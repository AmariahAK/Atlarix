/**
 * Compound-aware shell-line segmentation, shared by the always-on danger gate
 * (`dangerous-commands.ts`) and the system-scope gate (`system-scope-commands.ts`)
 * so a risky command can't hide behind a benign prefix (`echo ok && kill -9 1`).
 *
 * (Extracted from the former `command-mutation.ts` when the mutation/read command
 * taxonomies were removed in favor of OS-sandbox enforcement.)
 */

/**
 * Split a shell line into the commands it actually runs (compound-aware), so a
 * risky segment inside `cd x && rm -rf y` can't hide behind a benign prefix.
 */
export function commandSegments(command: string): string[] {
  return (
    command
      // surface command substitutions so an inner command is seen
      .replace(/\$\(([^)]*)\)/g, " ; $1 ; ")
      .replace(/`([^`]*)`/g, " ; $1 ; ")
      // Split on real shell separators. `&&`/`||` first (so they aren't split by
      // the single-operator alternatives), then a standalone `&` (background/
      // sequencing operator — `a & b` runs BOTH sides, so `b` must be its own
      // segment or a risky command could hide behind a benign `a`), then `;`,
      // newline, and `|`. `&(?!&)` matches a single `&` but never the `&&` pair.
      .split(/&&|\|\||&(?!&)|[;\n|]/)
      .map((s) => s.trim())
      .filter(Boolean)
      // strip leading pass-through wrappers and assignments — NOT sudo
      .map((s) => stripLeadingWrappers(s))
      .filter(Boolean)
  );
}

// ── Quote-aware segmentation (for the permission gate) ───────────────────────
// (Moved from the former command-default-allow.ts when its read-command taxonomy
// was removed; only the segmentation survives.)

/** Harmless redirects to the null sink / another fd (`2>/dev/null`, `2>&1`). */
const SAFE_REDIRECT_RE = /(?:&|\d*)>>?\s*\/dev\/null|\d*>&\d/g;
/** Pipeline/chain separators (`&&`, `||`, `|`, `&`, `;`, newline). */
const SEGMENT_SPLIT_RE = /&&|\|\||[|&;\n]/;
/**
 * What may stand in front of the command a segment really runs, and is stripped
 * before it is classified: `cd DIR`, the shell's per-command environment
 * (`NAME=value`, quoted or not), and wrappers that just run their argument
 * (`env`, `command`, `builtin`, `exec`, `nohup`, `time`, `nice`). NOT `sudo`,
 * which changes what the command may do and is classified as itself.
 *
 * ONE definition for both segmenters. Before it, the permission gate stripped
 * none of `NAME=value`, `env`, `command`, `exec`, `nohup`, so the first word of
 * `X=1 rm a.txt` was "x=1": not a risky command, not an installer, so it ran
 * without asking. `X=1 curl …` and `FOO=bar ssh host` went through the same way.
 */
const ASSIGNMENT = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"(?:[^"\\]|\\.)*"|[^\s;&|'"]*)\s+`;
const LEADING_PREFIX_RE = new RegExp(
  String.raw`^(?:cd\s+[^\s;&|]+\s*|time\s+(?:-p\s+)?|nice\s+(?:-n\s*-?\d+\s+|-\d+\s+)?|nohup\s+|command\s+(?:-p\s+)?|builtin\s+|exec\s+|env\s+(?:-i\s+|-u\s+\S+\s+)*|` +
    ASSIGNMENT +
    ")+",
  "i",
);

/** A segment without its leading wrappers and assignments (see LEADING_PREFIX_RE). */
export function stripLeadingWrappers(segment: string): string {
  return segment.trim().replace(LEADING_PREFIX_RE, "").trim();
}

/**
 * Blank balanced quoted spans so the remainder is unquoted shell syntax. Single
 * quotes are fully literal. Double quotes are literal for `|&;<>()` but keep
 * `$`/backtick active — a double-quoted span with either is substitution →
 * return null. Unbalanced quotes → null. Length is preserved 1:1 (quoted chars →
 * spaces) so skeleton offsets map onto the original string.
 */
export function unquotedSkeleton(command: string): string | null {
  let s = command.replace(/'[^']*'/g, (m) => " ".repeat(m.length));
  /*
   * A DOUBLE-QUOTED SPAN IS BLANKED, NOT REJECTED.
   *
   * This used to set a `rejected` flag whenever a double-quoted span contained
   * `$` or a backtick, so the whole command came back `null` and
   * `resolveRunCommandPermissionGate` fell through to a blanket prompt. That
   * made `echo "HEAD: $(git log --oneline -1)"` — and even `echo "$HOME"` —
   * ask for approval every single time, which is most of what an agent writes:
   * 24 approval blocks in one half-hour session, on commands the model is
   * designed to auto-run.
   *
   * It was protecting nothing. The blanking here only decides WHERE the
   * separators are; `quoteAwareSegments` slices each segment out of the
   * ORIGINAL string, so the substitution text survives into the segment and
   * reaches `isDangerousCommand`, which splits `$(…)` and backticks itself.
   * Measured: `echo "$(rm -rf /)"` and ``echo "`rm -rf /`"`` are both reported
   * dangerous with the spans blanked, exactly as the unquoted `cat $(rm -rf x)`
   * case already was.
   *
   * Blanking is also the RIGHT answer for separators: a `;` or `|` inside the
   * quotes must not split the command, and an inner command's own separators
   * still reach the danger gate through `commandSegments`.
   */
  s = s.replace(/"[^"]*"/g, (m) => " ".repeat(m.length));
  // An unbalanced quote is still unparseable — fail safe to a prompt.
  if (/['"]/.test(s)) return null;
  return s;
}

/**
 * Split `command` into its pipeline/chain segments, quote-aware. Returns `null`
 * only when the command can't be safely segmented (unbalanced quotes) — the
 * caller should treat that as "prompt". Substitution inside double quotes is
 * segmented normally and left intact in the segment text, so the danger gate
 * still sees it (see `unquotedSkeleton`). Benign leading `cd DIR`/`time`/`nice`
 * wrappers are stripped; empty segments dropped.
 */
export function quoteAwareSegments(command: string): string[] | null {
  const trimmed = (command || "").trim();
  if (!trimmed) return [];
  const skeleton = unquotedSkeleton(trimmed);
  if (skeleton === null) return null;
  // Blank safe redirects (equal-length) BEFORE scanning for separators so the
  // `&` in `2>&1` isn't mistaken for a background operator.
  const scan = skeleton.replace(SAFE_REDIRECT_RE, (m) => " ".repeat(m.length));

  const segments: string[] = [];
  const re = new RegExp(SEGMENT_SPLIT_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scan)) !== null) {
    segments.push(trimmed.slice(last, m.index));
    last = m.index + m[0].length;
  }
  segments.push(trimmed.slice(last));

  return segments
    .map((s) => stripLeadingWrappers(s))
    .filter(Boolean);
}
