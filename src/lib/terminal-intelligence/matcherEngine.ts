/**
 * TerminalIntelligence - Matcher Engine
 * =====================================
 * Core engine that applies GitHub Actions Problem Matchers to terminal output.
 *
 * Problem Matchers are community-maintained regex patterns that parse
 * compiler/linter output into structured error information.
 *
 * Sources:
 * - actions/setup-node (TypeScript, ESLint)
 * - actions/setup-python
 * - actions/setup-go
 * - rust-lang/rust
 */

import { type ParsedError } from "../devServerErrorParser";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GitHub Actions Problem Matcher format
 * @see https://github.com/actions/toolkit/blob/main/docs/problem-matchers.md
 */
export interface ProblemMatcherPattern {
  regexp: string;
  file?: number; // Capture group for file path
  line?: number; // Capture group for line number
  column?: number; // Capture group for column number
  severity?: number; // Capture group for severity
  message: number; // Capture group for error message (required)
  code?: number; // Capture group for error code
  loop?: boolean; // Whether to continue matching on same line
}

export interface ProblemMatcher {
  owner: string;
  severity?: "error" | "warning";
  pattern: ProblemMatcherPattern[];
}

export interface ProblemMatcherFile {
  problemMatcher: ProblemMatcher[];
}

// ═══════════════════════════════════════════════════════════════════════════
// MATCHER ENGINE
// ═══════════════════════════════════════════════════════════════════════════

export class MatcherEngine {
  private registry: Map<string, ProblemMatcher> = new Map();

  /**
   * Load a problem matcher into the registry
   */
  loadMatcher(matcher: ProblemMatcher): void {
    this.registry.set(matcher.owner, matcher);
  }

  /**
   * Load multiple matchers from a JSON file format
   */
  loadMatcherFile(file: ProblemMatcherFile): void {
    for (const matcher of file.problemMatcher) {
      this.loadMatcher(matcher);
    }
  }

  /**
   * Get all loaded matcher names
   */
  getLoadedMatchers(): string[] {
    return Array.from(this.registry.keys());
  }

  /**
   * Parse terminal output using all registered matchers
   */
  parse(output: string): ParsedError[] {
    const errors: ParsedError[] = [];
    const seenKeys = new Set<string>();
    const lines = output.split("\n");

    for (const [, matcher] of this.registry) {
      const matcherErrors = this.applyMatcher(lines, matcher);

      for (const error of matcherErrors) {
        // Deduplicate by message + file + line
        const key = `${error.message}|${error.file || ""}|${error.line || ""}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          errors.push(error);
        }
      }
    }

    return errors;
  }

  /**
   * Apply a single matcher to the output lines
   */
  private applyMatcher(
    lines: string[],
    matcher: ProblemMatcher,
  ): ParsedError[] {
    const errors: ParsedError[] = [];

    // For single-pattern matchers
    if (matcher.pattern.length === 1) {
      const pattern = matcher.pattern[0];
      const regex = new RegExp(pattern.regexp, "gi");

      for (const line of lines) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = regex.exec(line)) !== null) {
          const error = this.extractError(match, pattern, matcher);
          if (error) {
            errors.push(error);
          }

          // If not looping, break after first match
          if (!pattern.loop) break;
        }
      }
    } else {
      // Multi-pattern matchers (stateful, multi-line)
      errors.push(...this.applyMultiPatternMatcher(lines, matcher));
    }

    return errors;
  }

  /**
   * Apply multi-pattern matcher (for multi-line error formats)
   */
  private applyMultiPatternMatcher(
    lines: string[],
    matcher: ProblemMatcher,
  ): ParsedError[] {
    const errors: ParsedError[] = [];
    let patternIndex = 0;
    let partialMatch: Partial<ParsedError> = {};

    for (const line of lines) {
      const pattern = matcher.pattern[patternIndex];
      const regex = new RegExp(pattern.regexp, "gi");
      const match = regex.exec(line);

      if (match) {
        // Extract fields from this pattern
        const fields = this.extractFields(match, pattern);
        partialMatch = { ...partialMatch, ...fields };

        // Move to next pattern or complete the error
        if (patternIndex === matcher.pattern.length - 1) {
          // All patterns matched, create error
          const error = this.createError(partialMatch, matcher);
          if (error) errors.push(error);

          // Reset for next error
          patternIndex = 0;
          partialMatch = {};
        } else {
          patternIndex++;
        }
      } else if (patternIndex > 0) {
        // Pattern chain broken, try starting over
        patternIndex = 0;
        partialMatch = {};

        // Try matching first pattern on this line
        const firstPattern = matcher.pattern[0];
        const firstRegex = new RegExp(firstPattern.regexp, "gi");
        const firstMatch = firstRegex.exec(line);

        if (firstMatch) {
          partialMatch = this.extractFields(firstMatch, firstPattern);
          patternIndex = 1;
        }
      }
    }

    return errors;
  }

  /**
   * Extract error fields from a regex match
   */
  private extractFields(
    match: RegExpExecArray,
    pattern: ProblemMatcherPattern,
  ): Partial<ParsedError> {
    const fields: Partial<ParsedError> = {};

    if (pattern.file !== undefined && match[pattern.file]) {
      fields.file = match[pattern.file].trim();
    }
    if (pattern.line !== undefined && match[pattern.line]) {
      fields.line = parseInt(match[pattern.line], 10);
    }
    if (pattern.column !== undefined && match[pattern.column]) {
      fields.column = parseInt(match[pattern.column], 10);
    }
    if (pattern.message !== undefined && match[pattern.message]) {
      fields.message = match[pattern.message].trim();
    }
    if (pattern.severity !== undefined && match[pattern.severity]) {
      const sev = match[pattern.severity].toLowerCase();
      fields.severity = sev.includes("warn") ? "warning" : "error";
    }
    if (pattern.code !== undefined && match[pattern.code]) {
      fields.suggestion = `Code: ${match[pattern.code]}`;
    }

    return fields;
  }

  /**
   * Extract error from single-pattern match
   */
  private extractError(
    match: RegExpExecArray,
    pattern: ProblemMatcherPattern,
    matcher: ProblemMatcher,
  ): ParsedError | null {
    const fields = this.extractFields(match, pattern);
    return this.createError(fields, matcher);
  }

  /**
   * Create a ParsedError from extracted fields
   */
  private createError(
    fields: Partial<ParsedError>,
    matcher: ProblemMatcher,
  ): ParsedError | null {
    if (!fields.message) return null;

    return {
      id: `matcher-${matcher.owner}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: "build",
      severity: fields.severity || matcher.severity || "error",
      message: fields.message,
      file: fields.file,
      line: fields.line,
      column: fields.column,
      framework: matcher.owner,
      timestamp: Date.now(),
      actionable: true,
      suggestion: fields.suggestion,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════════════

export const matcherEngine = new MatcherEngine();
