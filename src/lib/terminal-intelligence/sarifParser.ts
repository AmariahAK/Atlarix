/**
 * TerminalIntelligence - SARIF Parser
 * ====================================
 * Parses Static Analysis Results Interchange Format (SARIF) output.
 * 
 * SARIF is an OASIS standard JSON format used by:
 * - ESLint (--format sarif)
 * - Clang-Tidy
 * - CodeQL
 * - Many security scanners
 * 
 * @see https://sarifweb.azurewebsites.net/
 */

import { type ParsedError } from '../devServerErrorParser';

// ═══════════════════════════════════════════════════════════════════════════
// SARIF TYPES (minimal subset we need)
// ═══════════════════════════════════════════════════════════════════════════

interface SARIFLocation {
    physicalLocation?: {
        artifactLocation?: {
            uri?: string;
            uriBaseId?: string;
        };
        region?: {
            startLine?: number;
            startColumn?: number;
            endLine?: number;
            endColumn?: number;
        };
    };
}

interface SARIFResult {
    ruleId?: string;
    level?: 'none' | 'note' | 'warning' | 'error';
    message: {
        text?: string;
        markdown?: string;
    };
    locations?: SARIFLocation[];
}

interface SARIFRun {
    tool: {
        driver: {
            name: string;
            version?: string;
        };
    };
    results: SARIFResult[];
}

interface SARIFLog {
    version: string;
    $schema?: string;
    runs: SARIFRun[];
}

// ═══════════════════════════════════════════════════════════════════════════
// PARSER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if output looks like JSON (starts with { or [)
 */
export function looksLikeJSON(output: string): boolean {
    const trimmed = output.trim();
    return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/**
 * Try to parse output as SARIF format
 * Returns null if not valid SARIF
 */
export function parseSARIF(output: string): ParsedError[] | null {
    // Quick check - only try if it looks like JSON
    if (!looksLikeJSON(output)) {
        return null;
    }

    try {
        const parsed = JSON.parse(output);

        // Validate SARIF structure
        if (!isSARIF(parsed)) {
            return null;
        }

        return extractErrors(parsed);
    } catch {
        // Not valid JSON
        return null;
    }
}

/**
 * Check if parsed JSON is a valid SARIF log
 */
function isSARIF(obj: unknown): obj is SARIFLog {
    if (!obj || typeof obj !== 'object') return false;

    const log = obj as SARIFLog;

    return (
        typeof log.version === 'string' &&
        log.version.startsWith('2.') && // SARIF 2.x
        Array.isArray(log.runs)
    );
}

/**
 * Extract ParsedErrors from SARIF log
 */
function extractErrors(sarif: SARIFLog): ParsedError[] {
    const errors: ParsedError[] = [];

    for (const run of sarif.runs) {
        const toolName = run.tool.driver.name;

        for (const result of run.results) {
            const error = resultToError(result, toolName);
            if (error) {
                errors.push(error);
            }
        }
    }

    return errors;
}

/**
 * Convert a SARIF result to ParsedError
 */
function resultToError(result: SARIFResult, toolName: string): ParsedError | null {
    const message = result.message.text || result.message.markdown || '';
    if (!message) return null;

    // Get location info
    const location = result.locations?.[0]?.physicalLocation;
    const file = location?.artifactLocation?.uri?.replace(/^file:\/\//, '');
    const region = location?.region;

    // Map SARIF level to severity
    const severity: 'error' | 'warning' =
        result.level === 'error' ? 'error' :
            result.level === 'warning' ? 'warning' :
                result.level === 'note' ? 'warning' : 'error';

    // Determine error type based on tool
    const type = getErrorType(toolName);

    return {
        id: `sarif-${toolName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        type,
        severity,
        message: result.ruleId ? `${result.ruleId}: ${message}` : message,
        file,
        line: region?.startLine,
        column: region?.startColumn,
        framework: toolName.toLowerCase(),
        timestamp: Date.now(),
        actionable: true,
        suggestion: result.ruleId ? `Rule: ${result.ruleId}` : undefined,
    };
}

/**
 * Determine error type based on tool name
 */
function getErrorType(toolName: string): ParsedError['type'] {
    const name = toolName.toLowerCase();

    if (name.includes('eslint') || name.includes('lint')) {
        return 'lint';
    }
    if (name.includes('typescript') || name.includes('tsc')) {
        return 'type';
    }
    if (name.includes('security') || name.includes('codeql')) {
        return 'runtime'; // Security issues
    }

    return 'build';
}
