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
    type: 'syntax' | 'type' | 'runtime' | 'lint' | 'build' | 'import' | 'structural';
    severity: 'error' | 'warning';
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
    windowMs = 5000
): ParsedError[] {
    const now = Date.now();

    return newErrors.filter(newErr => {
        return !existingErrors.some(existing =>
            existing.message === newErr.message &&
            existing.file === newErr.file &&
            existing.line === newErr.line &&
            (now - existing.timestamp) < windowMs
        );
    });
}

/**
 * Generate actionable suggestion based on error message
 */
export function generateSuggestion(message: string): string | undefined {
    if (/cannot find module/i.test(message)) {
        return 'Install the missing module with npm/yarn';
    }
    if (/is not defined/i.test(message)) {
        return 'Import or define the missing variable/function';
    }
    if (/does not provide.*export/i.test(message)) {
        return 'Check export name or add the export to the module';
    }
    if (/is not assignable/i.test(message)) {
        return 'Fix type mismatch or update type definition';
    }
    if (/syntaxerror/i.test(message)) {
        return 'Fix syntax error (missing bracket, semicolon, etc.)';
    }
    return undefined;
}
