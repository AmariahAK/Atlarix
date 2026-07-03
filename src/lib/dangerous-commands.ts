/**
 * Dangerous Command Detection
 * ===========================
 * Detects risky shell commands and provides plain-English explanations.
 *
 * This is the SINGLE danger source of truth. "Dangerous" no longer means a hard
 * block — it means the command is surfaced with an amber badge and is NEVER
 * silently auto-approved (even in autonomous mode) until the user has an explicit
 * always-allow for it. The always-allow is keyed per danger PATTERN
 * (`dangerLabelKey`), not by the coarse first-token category — so "always allow
 * git" can never silently allow `git push --force`, and allowing a specific
 * dangerous command doesn't allow the others.
 *
 * Two match sources, unioned:
 *  1. DANGEROUS_PATTERNS — regexes for specific dangerous forms (rm -rf, git
 *     push --force, …), each with a stable id + explanation.
 *  2. DANGEROUS_FIRST_TOKENS — commands whose first token is inherently risky
 *     (rm, sudo, kill, chmod, …). Migrated from the former DANGEROUS_CATEGORIES
 *     so retiring that list doesn't drop any command's danger status. First-token
 *     only (matches the old category semantics: `foo && rm x` was category "foo").
 */

export interface DangerMatch {
  /** Stable, kebab-case id — used as the always-allow permission key. */
  id: string;
  pattern: RegExp;
  explanation: string;
}

export const DANGEROUS_PATTERNS: DangerMatch[] = [
  {
    id: "rm-rf",
    pattern: /rm\s+-rf\s+/,
    explanation: "This will permanently delete files and folders. Deleted files cannot be recovered.",
  },
  {
    id: "rm-r",
    pattern: /rm\s+-r\s+/,
    explanation: "This will recursively delete directories and their contents. Deleted files cannot be recovered.",
  },
  {
    id: "sudo",
    pattern: /\bsudo\b/,
    explanation: "This runs with elevated privileges. It can modify system files or install software.",
  },
  {
    id: "curl-pipe-shell",
    pattern: /curl\s+.*\|\s*(bash|sh)\b/,
    explanation: "This downloads and executes a script from the internet. Only run if you trust the source.",
  },
  {
    id: "wget-pipe-shell",
    pattern: /wget\s+.*\|\s*(bash|sh)\b/,
    explanation: "This downloads and executes a script from the internet. Only run if you trust the source.",
  },
  {
    id: "chmod-777",
    pattern: /chmod\s+777\b/,
    explanation: "This makes files readable, writable, and executable by everyone. Often unnecessary and can be a security risk.",
  },
  {
    id: "dd-overwrite",
    pattern: /\bdd\s+if=/,
    explanation: "This can overwrite disk sectors. Incorrect use can cause permanent data loss.",
  },
  {
    id: "mkfs",
    pattern: /\bmkfs\./,
    explanation: "This formats a storage device. All existing data on the device will be permanently erased.",
  },
  {
    id: "format-drive",
    pattern: /\bformat\b.*\b(c:|d:)/i,
    explanation: "This may format a drive. All data on the drive will be permanently lost.",
  },
  {
    id: "git-push-force",
    pattern: /git\s+push\b.*--force(?!-with-lease)\b/,
    explanation: "This force-pushes and can OVERWRITE remote history for everyone — commits others rely on may be lost. Prefer --force-with-lease.",
  },
  {
    id: "git-push-force-with-lease",
    pattern: /git\s+push\b.*--force-with-lease\b/,
    explanation: "This force-pushes (with a safety lease). It rewrites remote history — confirm no one else has pushed since you last fetched.",
  },
  {
    id: "git-reset-hard",
    pattern: /git\s+reset\s+--hard\b/,
    explanation: "This discards ALL uncommitted changes and moves the branch pointer — local work not committed will be permanently lost.",
  },
];

/**
 * Commands whose FIRST TOKEN is inherently risky (migrated from the former
 * DANGEROUS_CATEGORIES). id = `cmd-<token>`. First-token only, mirroring the old
 * category semantics. Some overlap DANGEROUS_PATTERNS (e.g. rm, sudo) — the
 * union is deterministic and harmless.
 */
const DANGEROUS_FIRST_TOKENS: Record<string, string> = {
  rm: "This deletes files. Deleted files cannot be recovered.",
  sudo: "This runs with elevated privileges. It can modify system files or install software.",
  kill: "This terminates a running process.",
  pkill: "This terminates processes by name — it can stop more than you intend.",
  chmod: "This changes file permissions.",
  chown: "This changes file ownership.",
  curl: "This makes a network request and may download/execute remote content.",
  wget: "This downloads content from the internet.",
  bash: "This runs a shell script, which can do anything.",
  sh: "This runs a shell script, which can do anything.",
  zsh: "This runs a shell script, which can do anything.",
  eval: "This executes an arbitrary constructed command.",
  exec: "This replaces the current process with another command.",
  dd: "This performs low-level disk I/O and can cause permanent data loss.",
  mkfs: "This formats a storage device — all data on it is erased.",
  fdisk: "This edits the disk partition table.",
  reboot: "This restarts the machine.",
  shutdown: "This shuts the machine down.",
  poweroff: "This powers the machine off.",
};

function firstToken(command: string): string {
  const trimmed = (command || "").trim();
  if (!trimmed) return "";
  return (trimmed.split(/\s+/)[0] ?? "").toLowerCase();
}

/**
 * All danger ids a command matches (pattern ids ∪ first-token id), deduped and
 * sorted for a deterministic key. Empty when the command is not dangerous.
 */
export function getDangerMatchIds(command: string): string[] {
  const trimmed = (command || "").trim();
  if (!trimmed) return [];
  const ids = new Set<string>();
  for (const { id, pattern } of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) ids.add(id);
  }
  const tok = firstToken(trimmed);
  if (tok in DANGEROUS_FIRST_TOKENS) ids.add(`cmd-${tok}`);
  return [...ids].sort();
}

/** Check if a command matches any dangerous pattern or risky first token. */
export function isDangerousCommand(command: string): boolean {
  return getDangerMatchIds(command).length > 0;
}

/**
 * The stable permission key for a dangerous command — `danger:<id>[+<id>…]`.
 * Returns null for non-dangerous commands. The `danger:` prefix guarantees no
 * collision with first-token category keys in the shared command-permission
 * store, so an "always allow git" (category) never satisfies a dangerous key.
 */
export function dangerLabelKey(command: string): string | null {
  const ids = getDangerMatchIds(command);
  return ids.length ? `danger:${ids.join("+")}` : null;
}

/** Get a plain-English explanation for a dangerous command (badge text). */
export function getDangerExplanation(command: string): string {
  const trimmed = (command || "").trim();
  if (!trimmed) return "";
  // Prefer a specific pattern explanation; fall back to the first-token one.
  const patternMatch = DANGEROUS_PATTERNS.find(({ pattern }) => pattern.test(trimmed));
  if (patternMatch) return patternMatch.explanation;
  const tok = firstToken(trimmed);
  return (
    DANGEROUS_FIRST_TOKENS[tok] ??
    "This command may have unintended side effects. Proceed with caution."
  );
}
