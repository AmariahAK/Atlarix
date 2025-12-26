/**
 * Tree-sitter Parser for Workspace Analysis
 * ==========================================
 * NOTE: Tree-sitter native bindings are incompatible with Electron.
 * This module always returns null to use regex fallback.
 * Keeping the interface for future compatibility when tree-sitter-wasm becomes available.
 */

export interface ParsedFileResult {
    imports: string[];
    exports: string[];
    functions: string[];
    classes: string[];
    functionCalls: string[];
    classInstantiations: string[];
}

/**
 * Parse file with tree-sitter (disabled - native bindings don't work with Electron)
 * Always returns null to trigger regex fallback in workspace-analyzer.ts
 */
export async function parseWithTreeSitter(
    _content: string,
    _language: string
): Promise<ParsedFileResult | null> {
    // Tree-sitter native bindings are incompatible with Electron.
    // Using regex fallback in workspace-analyzer.ts instead.
    return null;
}

/**
 * Check if tree-sitter is available (always false in Electron)
 */
export async function isTreeSitterAvailable(): Promise<boolean> {
    return false;
}
