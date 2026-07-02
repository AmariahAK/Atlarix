/**
 * Dangerous Command Detection
 * ===========================
 * Detects risky shell commands and provides plain-English explanations.
 * Used for "I understand" checkbox UX before approving.
 */

export interface DangerMatch {
  pattern: RegExp;
  explanation: string;
}

export const DANGEROUS_PATTERNS: DangerMatch[] = [
  {
    pattern: /rm\s+-rf\s+/,
    explanation: "This will permanently delete files and folders. Deleted files cannot be recovered.",
  },
  {
    pattern: /rm\s+-r\s+/,
    explanation: "This will recursively delete directories and their contents. Deleted files cannot be recovered.",
  },
  {
    pattern: /\bsudo\b/,
    explanation: "This runs with elevated privileges. It can modify system files or install software.",
  },
  {
    pattern: /curl\s+.*\|\s*(bash|sh)\b/,
    explanation: "This downloads and executes a script from the internet. Only run if you trust the source.",
  },
  {
    pattern: /wget\s+.*\|\s*(bash|sh)\b/,
    explanation: "This downloads and executes a script from the internet. Only run if you trust the source.",
  },
  {
    pattern: /chmod\s+777\b/,
    explanation: "This makes files readable, writable, and executable by everyone. Often unnecessary and can be a security risk.",
  },
  {
    pattern: /\bdd\s+if=/,
    explanation: "This can overwrite disk sectors. Incorrect use can cause permanent data loss.",
  },
  {
    pattern: /\bmkfs\./,
    explanation: "This formats a storage device. All existing data on the device will be permanently erased.",
  },
  {
    pattern: /\bformat\b.*\b(c:|d:)/i,
    explanation: "This may format a drive. All data on the drive will be permanently lost.",
  },
  {
    pattern: /git\s+push\b.*--force(?!-with-lease)\b/,
    explanation: "This force-pushes and can OVERWRITE remote history for everyone — commits others rely on may be lost. Prefer --force-with-lease.",
  },
  {
    pattern: /git\s+push\b.*--force-with-lease\b/,
    explanation: "This force-pushes (with a safety lease). It rewrites remote history — confirm no one else has pushed since you last fetched.",
  },
  {
    pattern: /git\s+reset\s+--hard\b/,
    explanation: "This discards ALL uncommitted changes and moves the branch pointer — local work not committed will be permanently lost.",
  },
];

/**
 * Check if a command matches any dangerous pattern
 */
export function isDangerousCommand(command: string): boolean {
  const trimmed = (command || "").trim();
  if (!trimmed) return false;
  return DANGEROUS_PATTERNS.some(({ pattern }) => pattern.test(trimmed));
}

/**
 * Get plain-English explanation for dangerous command
 */
export function getDangerExplanation(command: string): string {
  const trimmed = (command || "").trim();
  if (!trimmed) return "";
  const match = DANGEROUS_PATTERNS.find(({ pattern }) => pattern.test(trimmed));
  return match?.explanation ?? "This command may have unintended side effects. Proceed with caution.";
}
