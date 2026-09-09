/**
 * Dev Server Error Types
 * ======================
 * Shared types for error parsing across the application.
 *
 * Note: Actual parsing is now handled by TerminalIntelligence.
 * @see ./terminal-intelligence/index.ts
 */

// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════

export interface ParsedError {
  id: string;
  type:
    | "syntax"
    | "type"
    | "runtime"
    | "lint"
    | "build"
    | "import"
    | "structural";
  severity: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
  column?: number;
  framework: string;
  timestamp: number;
  actionable: boolean;
  suggestion?: string;
  rawOutput?: string;
  stack?: string;
}

// ═══════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════

/**
 * Deduplicate errors with a time window
 */
export function deduplicateErrors(
  existingErrors: ParsedError[],
  newErrors: ParsedError[],
  windowMs = 5000,
): ParsedError[] {
  const now = Date.now();

  return newErrors.filter((newErr) => {
    return !existingErrors.some(
      (existing) =>
        existing.message === newErr.message &&
        existing.file === newErr.file &&
        existing.line === newErr.line &&
        now - existing.timestamp < windowMs,
    );
  });
}
