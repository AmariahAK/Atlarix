/**
 * Default read-only command allow-set + quote-aware segmentation.
 * ==============================================================
 * Reference-grade command permission (opencode / Claude Code model): the gate
 * evaluates a command PER SEGMENT against user allow/deny rules, and this module
 * supplies two pieces of that:
 *
 *  1. `quoteAwareSegments` — split a command into its pipeline/chain segments
 *     WITHOUT splitting inside quotes (so `grep 'a|b'` is one segment, not two).
 *  2. `DEFAULT_ALLOW_CATEGORIES` + `isDefaultAllowedSegment` — a small set of
 *     pure read/search commands that count as a DEFAULT "allow" for a segment
 *     when the user hasn't set an explicit rule. This is a prompt-reduction
 *     CONVENIENCE, overridable by a user `always_deny`, NOT the trust boundary —
 *     the OS write-sandbox + the dangerous-command gate + the system-scope gate
 *     are the boundary (see SECURITY_AUDIT.md). Dangerous/system-scope segments
 *     never reach this default (the gate routes them first).
 *
 * A chain of only readers cannot write files, run arbitrary code, or open a
 * network channel — so `awk`/`sed` (`-i`/`w`/`system()`), `xargs`, `tee`/`dd`,
 * interpreters, and `env`/`cd` prefixes are deliberately NOT in the default set.
 */

import { isBlockedSecretBasename } from "./security/env-secret-paths";

/**
 * Read/search/print commands treated as a DEFAULT allow per segment. Overridable
 * by a user `always_deny` rule on the same category. NOT a safety boundary.
 */
export const DEFAULT_ALLOW_CATEGORIES = new Set<string>([
  // search / list / stat
  "grep", "egrep", "fgrep", "rg", "ls", "find", "tree", "stat", "file", "wc",
  "pwd", "which", "realpath", "basename", "dirname",
  // read / print
  "cat", "head", "tail", "echo", "printf", "nl", "tac", "rev",
  // read-only text transforms (no write/exec surface)
  "sort", "uniq", "cut", "tr", "column", "comm", "jq",
  // read-only info / hashing
  "date", "cksum", "md5", "shasum", "sha256sum",
]);

/**
 * Harmless redirects that don't write to a real file: stderr/stdout to the null
 * sink or to another fd (`2>/dev/null`, `>/dev/null`, `&>/dev/null`, `2>&1`,
 * `1>&2`). Stripped before the write-redirect check.
 */
const SAFE_REDIRECT_RE = /(?:&|\d*)>>?\s*\/dev\/null|\d*>&\d/g;

/**
 * After safe redirects are stripped, ANY of these in a segment's quote-blanked
 * skeleton disqualifies it from the default: `<`/`>` (file read/write redirect),
 * backtick/`$` (substitution / var expansion), `(`/`)` (subshell).
 */
const DISALLOWED_METACHAR_RE = /[<>`$()]/;

/** Pipeline/chain separators (`&&`, `||`, `|`, `&`, `;`, newline). */
const SEGMENT_SPLIT_RE = /&&|\|\||[|&;\n]/;

/** `find` primaries that execute or mutate — never default-allow when present. */
const FIND_ACTION_RE =
  /(^|\s)-(exec|execdir|ok|okdir|delete|fprint0|fprintf|fprint|fls)\b/;

/**
 * Credential-path substrings the secret-basename check doesn't cover (SSH keys,
 * cloud/CI credential files). `.env`, `*.pem/.key/.p12/.pfx`, and the credential
 * JSON basenames are handled by `isBlockedSecretBasename`.
 */
const CREDENTIAL_PATH_RE =
  /(\.ssh\/id_|id_rsa|id_ed25519|id_ecdsa|id_dsa|\.aws\/credentials|\.netrc|\.git-credentials|\.npmrc|\.kube\/config|\.docker\/config\.json)/i;

/** Benign leading wrappers stripped off a segment (NOT `env` — that stays, so an
 *  `env VAR=val cmd` prefix keeps the segment out of the default set → prompt). */
const LEADING_WRAPPER_RE =
  /^(?:cd\s+[^\s;&|]+\s*|time\s+|nice\s+(?:-n\s+-?\d+\s+)?)+/i;

/**
 * Blank balanced quoted spans so the remainder is unquoted shell syntax. Single
 * quotes are fully literal. Double quotes are literal for `|&;<>()` but keep
 * `$`/backtick active — a double-quoted span with either is substitution →
 * return null. Unbalanced quotes → null. Length is preserved 1:1 with the input
 * (quoted chars → spaces) so skeleton offsets map onto the original string.
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

/** True when any argument looks like a secret/credential path. */
function referencesSecretPath(command: string): boolean {
  if (CREDENTIAL_PATH_RE.test(command)) return true;
  for (const rawToken of command.split(/\s+/)) {
    const token = rawToken.replace(/^['"]|['"]$/g, "");
    if (!token) continue;
    if (isBlockedSecretBasename(token)) return true;
  }
  return false;
}

function firstToken(segment: string): string {
  return (segment.trim().split(/\s+/)[0] ?? "").toLowerCase();
}

/**
 * Split `command` into its pipeline/chain segments, quote-aware. Returns `null`
 * when the command can't be safely segmented (substitution inside double quotes,
 * or unbalanced quotes) — the caller should treat that as "prompt". Benign
 * leading `cd DIR`/`time`/`nice` wrappers are stripped; empty segments dropped.
 * (Outside-workspace `cd` is caught separately by the whole-command system-scope
 * check with the real workspace root.)
 */
export function quoteAwareSegments(command: string): string[] | null {
  const trimmed = (command || "").trim();
  if (!trimmed) return [];
  const skeleton = unquotedSkeleton(trimmed);
  if (skeleton === null) return null;
  // Blank safe redirects (equal-length) BEFORE scanning for separators so the
  // `&` in `2>&1` / `&>/dev/null` isn't mistaken for a background operator. The
  // blanking preserves length so offsets still map onto the original string.
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

/**
 * True when a single SEGMENT is a default-allowed read: its first token is in
 * `DEFAULT_ALLOW_CATEGORIES`, it carries no file redirect / substitution /
 * subshell, no `find` action primary, and no secret-path argument. Callers must
 * route dangerous/system-scope segments elsewhere BEFORE consulting this.
 */
export function isDefaultAllowedSegment(segment: string): boolean {
  const seg = (segment || "").trim();
  if (!seg) return false;
  const skeleton = unquotedSkeleton(seg);
  if (skeleton === null) return false;
  if (DISALLOWED_METACHAR_RE.test(skeleton.replace(SAFE_REDIRECT_RE, " "))) {
    return false;
  }
  const tok = firstToken(seg);
  if (!DEFAULT_ALLOW_CATEGORIES.has(tok)) return false;
  if (tok === "find" && FIND_ACTION_RE.test(seg)) return false;
  if (referencesSecretPath(seg)) return false;
  return true;
}
