/**
 * Atlarix Symbol Tools
 * ====================
 * Smart tools for viewing specific code symbols without reading entire files.
 * 
 * Tools:
 * - view_symbol: View a function/class by name (40x more efficient than read_file)
 * - get_file_outline: Get table of contents for a file (10x more efficient)
 */

import * as fs from "fs";
import * as path from "path";
import { glob } from "glob";
import {
    ToolRegistry,
    ToolCategory,
    createParameters,
    stringParam,
    booleanParam,
} from "./registry";

// ═══════════════════════════════════════════════════════════
// LANGUAGE PATTERNS
// ═══════════════════════════════════════════════════════════

interface LanguagePatterns {
    function: RegExp;
    class: RegExp;
    interface: RegExp;
    type: RegExp;
    import: RegExp;
    export: RegExp;
}

const PATTERNS: Record<string, LanguagePatterns> = {
    typescript: {
        function: /^(export\s+)?(async\s+)?function\s+(\w+)/,
        class: /^(export\s+)?class\s+(\w+)/,
        interface: /^(export\s+)?interface\s+(\w+)/,
        type: /^(export\s+)?type\s+(\w+)/,
        import: /^import\s+/,
        export: /^export\s+/,
    },
    javascript: {
        function: /^(export\s+)?(async\s+)?function\s+(\w+)/,
        class: /^(export\s+)?class\s+(\w+)/,
        interface: /$/,  // No interfaces in JS
        type: /$/,       // No types in JS
        import: /^import\s+/,
        export: /^export\s+/,
    },
    python: {
        function: /^(async\s+)?def\s+(\w+)/,
        class: /^class\s+(\w+)/,
        interface: /$/,
        type: /$/,
        import: /^(from\s+\w+\s+)?import\s+/,
        export: /$/,  // Python uses __all__
    },
};

// Get patterns for file type
function getPatternsForFile(filePath: string): LanguagePatterns {
    const ext = path.extname(filePath).toLowerCase();
    if (['.ts', '.tsx'].includes(ext)) return PATTERNS.typescript;
    if (['.js', '.jsx', '.mjs'].includes(ext)) return PATTERNS.javascript;
    if (['.py'].includes(ext)) return PATTERNS.python;
    return PATTERNS.typescript; // Default
}

// ═══════════════════════════════════════════════════════════
// SYMBOL EXTRACTION
// ═══════════════════════════════════════════════════════════

interface SymbolInfo {
    name: string;
    type: 'function' | 'class' | 'interface' | 'type' | 'method' | 'variable';
    line: number;
    endLine?: number;
    signature?: string;
}

/**
 * Extract symbol locations from file content
 */
function extractSymbols(content: string, patterns: LanguagePatterns): SymbolInfo[] {
    const lines = content.split('\n');
    const symbols: SymbolInfo[] = [];

    let currentClass: string | null = null;
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Track brace depth for class scope
        braceDepth += (line.match(/{/g) || []).length;
        braceDepth -= (line.match(/}/g) || []).length;

        // Reset class context when we exit
        if (braceDepth === 0) currentClass = null;

        // Check for class
        const classMatch = trimmed.match(patterns.class);
        if (classMatch) {
            const name = classMatch[2] || classMatch[1];
            currentClass = name;
            symbols.push({
                name,
                type: 'class',
                line: i + 1,
                signature: trimmed.slice(0, 80),
            });
            continue;
        }

        // Check for interface
        const interfaceMatch = trimmed.match(patterns.interface);
        if (interfaceMatch) {
            const name = interfaceMatch[2] || interfaceMatch[1];
            symbols.push({
                name,
                type: 'interface',
                line: i + 1,
                signature: trimmed.slice(0, 80),
            });
            continue;
        }

        // Check for type
        const typeMatch = trimmed.match(patterns.type);
        if (typeMatch) {
            const name = typeMatch[2] || typeMatch[1];
            symbols.push({
                name,
                type: 'type',
                line: i + 1,
                signature: trimmed.slice(0, 80),
            });
            continue;
        }

        // Check for function/method
        const funcMatch = trimmed.match(patterns.function);
        if (funcMatch) {
            const name = funcMatch[3] || funcMatch[2] || funcMatch[1];
            symbols.push({
                name: currentClass ? `${currentClass}.${name}` : name,
                type: currentClass ? 'method' : 'function',
                line: i + 1,
                signature: trimmed.slice(0, 100),
            });
            continue;
        }

        // Check for arrow functions / const functions (TypeScript/JS)
        const arrowMatch = trimmed.match(/^(export\s+)?(const|let|var)\s+(\w+)\s*=\s*(async\s+)?\(/);
        if (arrowMatch) {
            symbols.push({
                name: arrowMatch[3],
                type: 'function',
                line: i + 1,
                signature: trimmed.slice(0, 100),
            });
            continue;
        }
    }

    return symbols;
}

/**
 * Find the end line of a symbol (looks for matching braces/indentation)
 */
function findSymbolEnd(lines: string[], startLine: number): number {
    const startIndent = lines[startLine].search(/\S/);
    let braceCount = 0;
    let foundOpen = false;

    for (let i = startLine; i < lines.length; i++) {
        const line = lines[i];

        // Count braces
        braceCount += (line.match(/{/g) || []).length;
        braceCount -= (line.match(/}/g) || []).length;

        if (braceCount > 0) foundOpen = true;

        // For brace-based languages
        if (foundOpen && braceCount === 0) {
            return i;
        }

        // For Python (indentation-based)
        if (i > startLine && line.trim() && line.search(/\S/) <= startIndent) {
            return i - 1;
        }
    }

    return Math.min(startLine + 50, lines.length - 1); // Default limit
}

/**
 * Extract symbol body from content
 */
function extractSymbolBody(content: string, symbolName: string): { found: boolean; body: string; file?: string; line?: number } {
    const lines = content.split('\n');
    const patterns = getPatternsForFile('.ts'); // Use TS patterns as they're most comprehensive
    const symbols = extractSymbols(content, patterns);

    // Find matching symbol
    const symbol = symbols.find(s =>
        s.name === symbolName ||
        s.name.endsWith(`.${symbolName}`) ||
        s.name.toLowerCase() === symbolName.toLowerCase()
    );

    if (!symbol) {
        return { found: false, body: '' };
    }

    const endLine = findSymbolEnd(lines, symbol.line - 1);
    const body = lines.slice(symbol.line - 1, endLine + 1).join('\n');

    return {
        found: true,
        body,
        line: symbol.line,
    };
}

// ═══════════════════════════════════════════════════════════
// VIEW SYMBOL TOOL
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "view_symbol",
    category: ToolCategory.FILE,
    description:
        "View a specific function, class, or interface by name. MUCH more efficient than reading entire files. Use when you know the symbol name from search_code or get_file_outline.",
    cost: 1,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true,
    parameters: createParameters(
        {
            symbol_name: stringParam("Name of function, class, or interface to view (e.g., 'handleClick', 'UserService', 'Props')"),
            file_path: stringParam("Optional: Specific file to search in. If omitted, searches entire workspace."),
            include_dependencies: booleanParam("Include types/interfaces this symbol depends on (default: false)"),
        },
        ["symbol_name"]
    ),
    handler: async ({ symbol_name, file_path, include_dependencies = false, workspace }) => {
        try {
            if (!workspace) {
                throw new Error("No workspace provided");
            }

            let filesToSearch: string[] = [];

            if (file_path) {
                // Search in specific file
                const normalizedPath = file_path
                    .replace(/^\/workspace\//, '')
                    .replace(/^workspace\//, '')
                    .replace(/^\/+/, '');
                filesToSearch = [path.join(workspace, normalizedPath)];
            } else {
                // Search entire workspace
                const files = await glob("**/*.{ts,tsx,js,jsx,py}", {
                    cwd: workspace,
                    ignore: ["node_modules/**", ".git/**", "dist/**", "build/**"],
                });
                filesToSearch = files.map(f => path.join(workspace, f));
            }

            // Search for symbol in files
            for (const filePath of filesToSearch) {
                try {
                    const content = await fs.promises.readFile(filePath, "utf-8");
                    const result = extractSymbolBody(content, symbol_name);

                    if (result.found) {
                        const relativePath = path.relative(workspace, filePath);
                        let output = `📍 **${symbol_name}** found in \`${relativePath}\` (line ${result.line})\n\n`;
                        output += "```" + path.extname(filePath).slice(1) + "\n";
                        output += result.body;
                        output += "\n```";

                        // Include dependencies if requested
                        if (include_dependencies) {
                            const deps = extractDependencies(content, result.body);
                            if (deps.length > 0) {
                                output += "\n\n**Dependencies:**\n```typescript\n";
                                output += deps.join("\n\n");
                                output += "\n```";
                            }
                        }

                        return output;
                    }
                } catch {
                    // Skip unreadable files
                }
            }

            return `❌ Symbol '${symbol_name}' not found in workspace. Try:\n` +
                `1. Check spelling (case-sensitive)\n` +
                `2. Use search_code to find where it's defined\n` +
                `3. Use get_file_outline to see available symbols in a file`;

        } catch (error) {
            throw new Error(`Failed to view symbol: ${error}`);
        }
    },
});

/**
 * Extract type dependencies from a symbol's body
 */
function extractDependencies(fullContent: string, symbolBody: string): string[] {
    const deps: string[] = [];

    // Find type annotations in the symbol body
    const typeMatches = symbolBody.match(/:\s*(\w+)(?:\[\])?(?:\s*\|)/g) || [];
    const genericMatches = symbolBody.match(/<(\w+)>/g) || [];

    const typeNames = new Set<string>();

    [...typeMatches, ...genericMatches].forEach(match => {
        const name = match.replace(/[:<>[\]\s|]/g, '');
        if (name && !['string', 'number', 'boolean', 'void', 'any', 'unknown', 'null', 'undefined'].includes(name)) {
            typeNames.add(name);
        }
    });

    // Find these types in the full content
    const lines = fullContent.split('\n');
    for (const typeName of typeNames) {
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.match(new RegExp(`^(export\\s+)?(interface|type)\\s+${typeName}\\b`))) {
                const endLine = findSymbolEnd(lines, i);
                deps.push(lines.slice(i, endLine + 1).join('\n'));
                break;
            }
        }
    }

    return deps.slice(0, 3); // Limit to 3 dependencies
}

// ═══════════════════════════════════════════════════════════
// GET FILE OUTLINE TOOL
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "get_file_outline",
    category: ToolCategory.FILE,
    description:
        "Get a table of contents for a file showing imports, exports, functions, classes, and types. Use BEFORE read_file to understand a file's structure efficiently.",
    cost: 1,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true,
    parameters: createParameters(
        {
            path: stringParam("Path to the file (relative to workspace)"),
        },
        ["path"]
    ),
    handler: async ({ path: filePath, workspace }) => {
        try {
            if (!workspace) {
                throw new Error("No workspace provided");
            }

            // Normalize path
            const normalizedPath = filePath
                .replace(/^\/workspace\//, '')
                .replace(/^workspace\//, '')
                .replace(/^\/+/, '');

            const fullPath = path.join(workspace, normalizedPath);
            const content = await fs.promises.readFile(fullPath, "utf-8");
            const lines = content.split('\n');
            const patterns = getPatternsForFile(fullPath);

            // Extract different sections
            const imports: string[] = [];
            const exports: string[] = [];
            const functions: { name: string; line: number; signature: string }[] = [];
            const classes: { name: string; line: number }[] = [];
            const interfaces: { name: string; line: number }[] = [];
            const types: { name: string; line: number }[] = [];

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const trimmed = line.trim();

                // Imports (first 30 lines usually)
                if (i < 30 && patterns.import.test(trimmed)) {
                    imports.push(trimmed.slice(0, 80));
                    continue;
                }

                // Exports
                if (patterns.export.test(trimmed) && !trimmed.includes('import')) {
                    exports.push(`Line ${i + 1}: ${trimmed.slice(0, 60)}`);
                }

                // Classes
                const classMatch = trimmed.match(patterns.class);
                if (classMatch) {
                    classes.push({
                        name: classMatch[2] || classMatch[1],
                        line: i + 1,
                    });
                    continue;
                }

                // Interfaces
                const interfaceMatch = trimmed.match(patterns.interface);
                if (interfaceMatch) {
                    interfaces.push({
                        name: interfaceMatch[2] || interfaceMatch[1],
                        line: i + 1,
                    });
                    continue;
                }

                // Types
                const typeMatch = trimmed.match(patterns.type);
                if (typeMatch) {
                    types.push({
                        name: typeMatch[2] || typeMatch[1],
                        line: i + 1,
                    });
                    continue;
                }

                // Functions
                const funcMatch = trimmed.match(patterns.function);
                if (funcMatch) {
                    functions.push({
                        name: funcMatch[3] || funcMatch[2] || funcMatch[1],
                        line: i + 1,
                        signature: trimmed.slice(0, 80),
                    });
                    continue;
                }

                // Arrow functions
                const arrowMatch = trimmed.match(/^(export\s+)?(const|let)\s+(\w+)\s*=\s*(async\s+)?\(/);
                if (arrowMatch) {
                    functions.push({
                        name: arrowMatch[3],
                        line: i + 1,
                        signature: trimmed.slice(0, 80),
                    });
                }
            }

            // Build output
            let output = `📄 **File Outline: ${normalizedPath}**\n`;
            output += `**Total lines:** ${lines.length}\n\n`;

            if (imports.length > 0) {
                output += `**📦 Imports (${imports.length}):**\n`;
                imports.slice(0, 10).forEach(imp => {
                    output += `  ${imp}\n`;
                });
                if (imports.length > 10) {
                    output += `  ... and ${imports.length - 10} more\n`;
                }
                output += '\n';
            }

            if (classes.length > 0) {
                output += `**🏛️ Classes (${classes.length}):**\n`;
                classes.forEach(c => {
                    output += `  - \`${c.name}\` (line ${c.line})\n`;
                });
                output += '\n';
            }

            if (interfaces.length > 0) {
                output += `**📋 Interfaces (${interfaces.length}):**\n`;
                interfaces.forEach(i => {
                    output += `  - \`${i.name}\` (line ${i.line})\n`;
                });
                output += '\n';
            }

            if (types.length > 0) {
                output += `**🔷 Types (${types.length}):**\n`;
                types.forEach(t => {
                    output += `  - \`${t.name}\` (line ${t.line})\n`;
                });
                output += '\n';
            }

            if (functions.length > 0) {
                output += `**⚡ Functions (${functions.length}):**\n`;
                functions.forEach(f => {
                    output += `  - \`${f.name}\` (line ${f.line})\n`;
                });
                output += '\n';
            }

            output += `\n💡 **Tip:** Use \`view_symbol('${functions[0]?.name || classes[0]?.name || 'symbolName'}')\` to see specific code, or \`read_file\` with \`line_range\` for sections.`;

            return output;

        } catch (error) {
            throw new Error(`Failed to get file outline: ${error}`);
        }
    },
});

export { extractSymbols, extractSymbolBody };
