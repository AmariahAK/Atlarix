/**
 * TerminalIntelligence
 * ====================
 * Intelligent terminal output parser that uses a 3-layer system:
 * 
 * 1. SARIF Parser (if JSON) - Structured analysis output
 * 2. Problem Matchers (primary) - Community regex patterns
 * 3. LLM Fallback (emergency) - AI for unknown formats
 * 
 * Usage:
 * ```typescript
 * import { TerminalIntelligence } from './terminal-intelligence';
 * 
 * const errors = await TerminalIntelligence.parse(terminalOutput);
 * // Or with LLM fallback:
 * const errors = await TerminalIntelligence.parseWithFallback(output, callAI);
 * ```
 */

import { type ParsedError } from '../devServerErrorParser';
import { matcherEngine, type ProblemMatcherFile } from './matcherEngine';
import { parseSARIF, looksLikeJSON } from './sarifParser';
import { llmParse, likelyContainsErrors, canCallLLM } from './llmFallback';
import { ALL_MATCHERS } from './matchers/bundled';

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
    console.log(`[TerminalIntelligence] Loaded ${matcherEngine.getLoadedMatchers().length} problem matchers`);
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
 * Parse terminal output with LLM fallback for unknown formats
 * Slower, may use AI API
 */
async function parseWithFallback(
    output: string,
    callAI: (prompt: string) => Promise<string>
): Promise<ParsedError[]> {
    ensureInitialized();

    // First try fast path
    const errors = parse(output);

    // If we found errors, return them
    if (errors.length > 0) {
        return errors;
    }

    // Layer 3: LLM Fallback (only if likely has errors and within rate limit)
    if (likelyContainsErrors(output) && canCallLLM()) {
        const llmErrors = await llmParse(output, callAI);
        return llmErrors;
    }

    return [];
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
    parseWithFallback,
    loadMatcher,
    getLoadedMatchers,
};

// Re-export types
export { type ProblemMatcherFile } from './matcherEngine';
