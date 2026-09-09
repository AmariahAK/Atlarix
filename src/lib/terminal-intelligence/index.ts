/**
 * TerminalIntelligence
 * ====================
 * Deterministic terminal output parser — no LLM, no API calls:
 *
 * 1. SARIF Parser (if JSON) - Structured analysis output
 * 2. Problem Matchers (primary) - Community regex patterns
 *
 * Usage:
 * ```typescript
 * import { TerminalIntelligence } from './terminal-intelligence';
 *
 * const errors = TerminalIntelligence.parse(terminalOutput);
 * ```
 */

import { type ParsedError } from "../devServerErrorParser";
import { matcherEngine, type ProblemMatcherFile } from "./matcherEngine";
import { parseSARIF, looksLikeJSON } from "./sarifParser";
import { ALL_MATCHERS } from "./matchers/bundled";

// ═══════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

let initialized = false;

function ensureInitialized(): void {
  if (initialized) return;

  // Load all bundled matchers
  for (const matcherFile of ALL_MATCHERS) {
    matcherEngine.loadMatcherFile(matcherFile);
  }

  initialized = true;
  console.log(
    `[TerminalIntelligence] Loaded ${matcherEngine.getLoadedMatchers().length} problem matchers`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse terminal output using SARIF + Problem Matchers (no LLM)
 * Fast, synchronous, no API calls
 */
function parse(output: string): ParsedError[] {
  ensureInitialized();

  // Layer 1: Try SARIF (if looks like JSON)
  if (looksLikeJSON(output)) {
    const sarifErrors = parseSARIF(output);
    if (sarifErrors && sarifErrors.length > 0) {
      return sarifErrors;
    }
  }

  // Layer 2: Apply Problem Matchers
  const matcherErrors = matcherEngine.parse(output);
  return matcherErrors;
}

/**
 * Load additional matchers at runtime
 */
function loadMatcher(matcherFile: ProblemMatcherFile): void {
  ensureInitialized();
  matcherEngine.loadMatcherFile(matcherFile);
}

/**
 * Get list of loaded matcher names
 */
function getLoadedMatchers(): string[] {
  ensureInitialized();
  return matcherEngine.getLoadedMatchers();
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════════════════

export const TerminalIntelligence = {
  parse,
  loadMatcher,
  getLoadedMatchers,
};

// Re-export types
export { type ProblemMatcherFile } from "./matcherEngine";
