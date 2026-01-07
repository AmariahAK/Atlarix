/**
 * Structural Health Check
 * =======================
 * Layer 4 of the Quad Error Detection System.
 * 
 * This module validates code structure by attempting to generate a simple diagram.
 * If the AI can't "visualize" the code, it means there's a structural issue.
 * 
 * Features:
 * - Mermaid error parsing for file/line extraction
 * - File hash caching to avoid redundant analysis
 * - Confidence scoring for error severity
 * - Integration with browserErrorsAtom
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { type ParsedError } from '@/lib/devServerErrorParser';

// ═══════════════════════════════════════════════════════════════════════════
// FILE HASH CACHE - Avoid redundant analysis
// ═══════════════════════════════════════════════════════════════════════════

const fileHashCache = new Map<string, string>();

function hashContent(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
}

export function shouldProbeFile(filePath: string, content: string): boolean {
    const currentHash = hashContent(content);
    const cachedHash = fileHashCache.get(filePath);

    if (cachedHash === currentHash) {
        return false; // File hasn't changed, skip analysis
    }

    fileHashCache.set(filePath, currentHash);
    return true;
}

export function clearFileHashCache(): void {
    fileHashCache.clear();
}

// ═══════════════════════════════════════════════════════════════════════════
// MERMAID ERROR PARSING
// ═══════════════════════════════════════════════════════════════════════════

export interface MermaidErrorDetails {
    message: string;
    line?: number;
    file?: string;
    severity: 'critical' | 'error' | 'warning';
    originalError: string;
}

/**
 * Parse a Mermaid error message to extract structural details.
 * 
 * Example errors:
 * - "Lexical error on line 31. Unrecognized text."
 * - "Parse error on line 10: Unexpected token"
 * - "Error: Invalid syntax at line 5"
 * 
 * The error often contains file references like "types/recipe.ts" in the context.
 */
export function parseMermaidError(error: string): MermaidErrorDetails {
    const result: MermaidErrorDetails = {
        message: error.split('.')[0] || error, // First sentence
        severity: 'error',
        originalError: error,
    };

    // Extract line number
    // Pattern: "on line X", "at line X", "line X:"
    const lineMatch = error.match(/(?:on|at)\s+line\s+(\d+)/i) ||
        error.match(/line\s+(\d+):/i);
    if (lineMatch) {
        result.line = parseInt(lineMatch[1], 10);
    }

    // Extract file reference from context
    // Pattern: common file extensions in the error text
    const fileMatch = error.match(/([a-zA-Z0-9_\-./]+\.(ts|tsx|js|jsx|py|go|rs|vue|svelte))/i);
    if (fileMatch) {
        result.file = fileMatch[1];
    }

    // Determine severity based on error type
    if (error.toLowerCase().includes('lexical error')) {
        result.severity = 'critical'; // Can't even tokenize
    } else if (error.toLowerCase().includes('parse error') ||
        error.toLowerCase().includes('syntax error')) {
        result.severity = 'error';
    } else if (error.toLowerCase().includes('unexpected') ||
        error.toLowerCase().includes('unrecognized')) {
        result.severity = 'error';
    } else {
        result.severity = 'warning'; // Minor diagram hiccup
    }

    return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// STRUCTURAL ERROR CREATION
// ═══════════════════════════════════════════════════════════════════════════

export interface StructuralProbeResult {
    healthy: boolean;
    confidence: number; // 0-100
    errors: ParsedError[];
    suggestion?: string;
}

/**
 * Create a structural error from a Mermaid parsing failure.
 * This is called when diagram generation fails for a file.
 */
export function createStructuralError(
    mermaidError: string,
    context: {
        filePath?: string;
        operation?: 'write' | 'edit' | 'insert' | 'delete';
    }
): ParsedError {
    const parsed = parseMermaidError(mermaidError);

    return {
        id: `structural-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        type: 'structural',
        severity: parsed.severity === 'critical' ? 'error' :
            parsed.severity === 'error' ? 'error' : 'warning',
        message: `Structural issue: ${parsed.message}`,
        file: parsed.file || context.filePath,
        line: parsed.line,
        framework: 'diagram',
        timestamp: Date.now(),
        actionable: true,
        suggestion: `The code structure cannot be analyzed${parsed.line ? ` near line ${parsed.line}` : ''}. This often indicates syntax errors or malformed code.`,
        rawOutput: parsed.originalError,
    };
}

/**
 * Validate structural health after a file operation.
 * Returns probe result with confidence score.
 */
export function validateStructure(
    filePath: string,
    fileContent: string,
    mermaidResult: { success: boolean; error?: string; code?: string }
): StructuralProbeResult {
    if (mermaidResult.success) {
        return {
            healthy: true,
            confidence: 100,
            errors: [],
        };
    }

    const error = mermaidResult.error || 'Unknown diagram generation error';
    const structuralError = createStructuralError(error, { filePath });

    // Calculate confidence based on error type
    let confidence = 50; // Base confidence

    if (error.toLowerCase().includes('lexical error')) {
        confidence = 20; // Very low confidence - serious issue
    } else if (error.toLowerCase().includes('parse error')) {
        confidence = 30;
    } else if (error.toLowerCase().includes('syntax')) {
        confidence = 35;
    } else if (error.toLowerCase().includes('unexpected')) {
        confidence = 40;
    }

    return {
        healthy: false,
        confidence,
        errors: [structuralError],
        suggestion: structuralError.suggestion,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// FILE EXTENSION CHECKS
// ═══════════════════════════════════════════════════════════════════════════

const SUPPORTED_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.go', '.rs', '.vue', '.svelte',
    '.java', '.kt', '.cs', '.cpp', '.c', '.h',
    '.rb', '.php',
]);

/**
 * Check if a file should be probed for structural issues.
 */
export function isProbeableFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return SUPPORTED_EXTENSIONS.has(ext);
}

// ═══════════════════════════════════════════════════════════════════════════
// INTEGRATION HOOKS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Hook to be called after AI file operations.
 * This should be integrated into the edit-tools handlers.
 * 
 * Usage:
 * ```typescript
 * import { onFileWritten } from './structuralHealthCheck';
 * 
 * // After successful file write:
 * const result = await onFileWritten(filePath, newContent, diagramGenerator);
 * if (result.errors.length > 0) {
 *     // Add to browserErrorsAtom
 * }
 * ```
 */
export async function onFileWritten(
    filePath: string,
    content: string,
    generateDiagram: (filePath: string) => Promise<{ success: boolean; error?: string; code?: string }>
): Promise<StructuralProbeResult> {
    // Skip non-probeable files
    if (!isProbeableFile(filePath)) {
        return { healthy: true, confidence: 100, errors: [] };
    }

    // Skip if file hasn't changed
    if (!shouldProbeFile(filePath, content)) {
        return { healthy: true, confidence: 100, errors: [] };
    }

    try {
        const diagramResult = await generateDiagram(filePath);
        return validateStructure(filePath, content, diagramResult);
    } catch (e) {
        // Diagram generation threw an exception
        return validateStructure(filePath, content, {
            success: false,
            error: e instanceof Error ? e.message : String(e),
        });
    }
}
