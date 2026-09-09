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
      // strip benign leading wrappers (cd DIR, env VAR=…, time, nice) — NOT sudo
      .map((s) =>
        s
          .replace(
            /^(?:cd\s+[^\s;&]+\s*|env\s+\w+=\S+\s+|time\s+|nice\s+(?:-n\s+-?\d+\s+)?)+/i,
            "",
          )
          .trim(),
      )
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
/** Benign leading wrappers stripped off a segment (NOT `env`/`sudo`). */
const LEADING_WRAPPER_RE =
  /^(?:cd\s+[^\s;&|]+\s*|time\s+|nice\s+(?:-n\s+-?\d+\s+)?)+/i;

/**
 * Blank balanced quoted spans so the remainder is unquoted shell syntax. Single
 * quotes are fully literal. Double quotes are literal for `|&;<>()` but keep
 * `$`/backtick active — a double-quoted span with either is substitution →
 * return null. Unbalanced quotes → null. Length is preserved 1:1 (quoted chars →
 * spaces) so skeleton offsets map onto the original string.
 */
function unquotedSkeleton(command: string): string | null {
  let s = command.replace(/'[^']*'/g, (m) => " ".repeat(m.length));
  let rejected = false;
  s = s.replace(/"[^"]*"/g, (m) => {
    if (/[$`]/.test(m)) rejected = true;
    return " ".repeat(m.length);
  });
  if (rejected) return null;
  if (/['"]/.test(s)) return null;
  return s;
}

/**
 * Split `command` into its pipeline/chain segments, quote-aware. Returns `null`
 * when the command can't be safely segmented (substitution inside double quotes,
 * or unbalanced quotes) — the caller should treat that as "prompt". Benign
 * leading `cd DIR`/`time`/`nice` wrappers are stripped; empty segments dropped.
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
    .map((s) => s.trim().replace(LEADING_WRAPPER_RE, "").trim())
    .filter(Boolean);
}
