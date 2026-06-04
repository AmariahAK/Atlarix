/**
 * TerminalIntelligence - LLM Fallback
 * ====================================
 * Emergency fallback that uses AI to parse unknown error formats.
 * 
 * Features:
 * - Rate limiting (max 10 calls/minute)
 * - Output caching (avoid duplicate LLM calls)
 * - Error keyword detection (only call if likely an error)
 */

import { type ParsedError } from '../devServerErrorParser';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const MAX_CALLS_PER_MINUTE = 10;
const CACHE_MAX_SIZE = 100;
const OUTPUT_SAMPLE_SIZE = 1500; // Max chars to send to LLM

// Error keywords that suggest output contains errors
const ERROR_KEYWORDS = [
    'error', 'Error', 'ERROR',
    'exception', 'Exception', 'EXCEPTION',
    'failed', 'Failed', 'FAILED',
    'fatal', 'Fatal', 'FATAL',
    'panic', 'Panic', 'PANIC',
    'warning', 'Warning', 'WARNING',
    'TypeError', 'SyntaxError', 'ReferenceError',
    'undefined', 'is not defined',
    'cannot find', 'not found',
    'unexpected', 'invalid',
];

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════

// Simple hash function for caching
function hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
}

// LRU-ish cache for parsed outputs
const outputCache = new Map<string, ParsedError[]>();

// Rate limiting state
let callTimestamps: number[] = [];

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if output likely contains errors (based on keywords)
 */
export function likelyContainsErrors(output: string): boolean {
    return ERROR_KEYWORDS.some(keyword => output.includes(keyword));
}

/**
 * Check if we're within rate limit
 */
export function canCallLLM(): boolean {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;

    // Clean old timestamps
    callTimestamps = callTimestamps.filter(ts => ts > oneMinuteAgo);

    return callTimestamps.length < MAX_CALLS_PER_MINUTE;
}

/**
 * Record an LLM call for rate limiting
 */
function recordLLMCall(): void {
    callTimestamps.push(Date.now());
}

/**
 * Parse output using LLM fallback
 * Returns cached result if available
 */
export async function llmParse(
    output: string,
    callAI: (prompt: string) => Promise<string>
): Promise<ParsedError[]> {
    const hash = hashString(output);

    // Check cache first
    if (outputCache.has(hash)) {
        return outputCache.get(hash)!;
    }

    // Check if output likely contains errors
    if (!likelyContainsErrors(output)) {
        return [];
    }

    // Check rate limit
    if (!canCallLLM()) {
        console.warn('[TerminalIntelligence] LLM rate limit exceeded, skipping fallback');
        return [];
    }

    // Record this call
    recordLLMCall();

    // Prepare prompt
    const sample = output.slice(-OUTPUT_SAMPLE_SIZE); // Take last N chars (most recent)
    const prompt = `Extract error information from this terminal/build output.
Return ONLY a valid JSON array of objects with these fields:
- file: string (file path, or null if unknown)
- line: number (line number, or null if unknown)
- column: number (column number, or null if unknown)  
- message: string (the error message, required)
- severity: "error" or "warning"

If no errors found, return: []

Terminal output:
\`\`\`
${sample}
\`\`\`

JSON response:`;

    try {
        const response = await callAI(prompt);

        // Extract JSON from response (handle markdown code blocks)
        const jsonMatch = response.match(/\[[\s\S]*?\]/);
        if (!jsonMatch) {
            return [];
        }

        const parsed = JSON.parse(jsonMatch[0]) as Array<{
            file?: string;
            line?: number;
            column?: number;
            message: string;
            severity?: string;
        }>;

        // Convert to ParsedError format
        const errors: ParsedError[] = parsed
            .filter(item => item.message)
            .map((item, index) => ({
                id: `llm-${Date.now()}-${index}`,
                type: 'runtime' as const,
                severity: (item.severity === 'warning' ? 'warning' : 'error') as 'error' | 'warning',
                message: item.message,
                file: item.file || undefined,
                line: item.line || undefined,
                column: item.column || undefined,
                framework: 'llm-detected',
                timestamp: Date.now(),
                actionable: true,
            }));

        // Cache results
        if (outputCache.size >= CACHE_MAX_SIZE) {
            // Remove oldest entry
            const firstKey = outputCache.keys().next().value;
            if (firstKey) outputCache.delete(firstKey);
        }
        outputCache.set(hash, errors);

        return errors;
    } catch (e) {
        console.error('[TerminalIntelligence] LLM parse failed:', e);
        return [];
    }
}

