/**
 * Dev Server Error Parser
 * =======================
 * Parses dev server terminal output for errors - IDE-style error detection.
 * 
 * Supports: Vite, TypeScript, Next.js, ESLint, Webpack, Python, Go, Rust
 */

// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════

export interface ParsedError {
    id: string;
    type: 'syntax' | 'type' | 'runtime' | 'lint' | 'build' | 'import';
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
// ERROR PATTERNS
// ═══════════════════════════════════════════════════════════

interface ErrorPattern {
    pattern: RegExp;
    framework: string;
    type: ParsedError['type'];
    severity: ParsedError['severity'];
    extract: (match: RegExpMatchArray) => Partial<ParsedError>;
}

const ERROR_PATTERNS: ErrorPattern[] = [
    // ─────────────────────────────────────────────────────────
    // Vite / TypeScript
    // ─────────────────────────────────────────────────────────
    {
        // TypeScript error: src/App.tsx:15:3 - error TS2322: Type 'string' is not assignable...
        pattern: /(\S+\.tsx?):(\d+):(\d+)\s*[-–]\s*error\s+TS(\d+):\s*(.+)/gi,
        framework: 'typescript',
        type: 'type',
        severity: 'error',
        extract: (m) => ({
            file: m[1],
            line: parseInt(m[2]),
            column: parseInt(m[3]),
            message: `TS${m[4]}: ${m[5]}`,
        }),
    },
    {
        // Vite SyntaxError: The requested module '/src/types/recipe.ts' does not provide...
        pattern: /SyntaxError:\s*(.+?)(?:\s*\(at\s+(\S+):(\d+):?(\d+)?\))?/gi,
        framework: 'vite',
        type: 'syntax',
        severity: 'error',
        extract: (m) => ({
            message: m[1].trim(),
            file: m[2],
            line: m[3] ? parseInt(m[3]) : undefined,
            column: m[4] ? parseInt(m[4]) : undefined,
        }),
    },
    {
        // Vite module error: [vite] Internal server error: ...
        pattern: /\[vite\]\s*(?:Internal server error|Error):\s*(.+)/gi,
        framework: 'vite',
        type: 'build',
        severity: 'error',
        extract: (m) => ({ message: m[1].trim() }),
    },
    {
        // Generic error with file:line:col format
        pattern: /(\S+\.[jt]sx?):(\d+):(\d+):\s*(?:error|Error)[\s:]+(.+)/gi,
        framework: 'vite',
        type: 'syntax',
        severity: 'error',
        extract: (m) => ({
            file: m[1],
            line: parseInt(m[2]),
            column: parseInt(m[3]),
            message: m[4].trim(),
        }),
    },

    // ─────────────────────────────────────────────────────────
    // Next.js
    // ─────────────────────────────────────────────────────────
    {
        // Next.js error symbol: ⨯ Error: ...
        pattern: /⨯\s*(?:Error:?\s*)?(.+)/gi,
        framework: 'nextjs',
        type: 'build',
        severity: 'error',
        extract: (m) => ({ message: m[1].trim() }),
    },
    {
        // Next.js Module not found
        pattern: /Module not found:\s*(.+)/gi,
        framework: 'nextjs',
        type: 'import',
        severity: 'error',
        extract: (m) => ({
            message: m[1].trim(),
            suggestion: 'Install missing dependency or fix import path',
            actionable: true,
        }),
    },

    // ─────────────────────────────────────────────────────────
    // ESLint
    // ─────────────────────────────────────────────────────────
    {
        // ESLint: src/App.tsx:15:3: error 'foo' is not defined no-undef
        pattern: /(\S+):(\d+):(\d+):\s*(error|warning)\s+(.+?)\s+(\S+\/\S+|\S+-\S+)$/gim,
        framework: 'eslint',
        type: 'lint',
        severity: 'warning', // Will be overridden by extract
        extract: (m) => ({
            file: m[1],
            line: parseInt(m[2]),
            column: parseInt(m[3]),
            severity: m[4].toLowerCase() as 'error' | 'warning',
            message: `${m[5]} (${m[6]})`,
        }),
    },

    // ─────────────────────────────────────────────────────────
    // Webpack
    // ─────────────────────────────────────────────────────────
    {
        // Webpack: ERROR in ./src/App.tsx
        pattern: /ERROR in\s+(.+?)(?:\n|$)/gi,
        framework: 'webpack',
        type: 'build',
        severity: 'error',
        extract: (m) => ({
            message: `Build error in ${m[1].trim()}`,
            file: m[1].trim(),
        }),
    },
    {
        // Webpack: Module parse failed
        pattern: /Module parse failed:\s*(.+)/gi,
        framework: 'webpack',
        type: 'syntax',
        severity: 'error',
        extract: (m) => ({ message: m[1].trim() }),
    },

    // ─────────────────────────────────────────────────────────
    // Python
    // ─────────────────────────────────────────────────────────
    {
        // Python traceback: File "main.py", line 10
        pattern: /File\s+"([^"]+)",\s*line\s+(\d+)(?:,\s*in\s+\w+)?\n\s*.+\n(\w+Error):\s*(.+)/gi,
        framework: 'python',
        type: 'runtime',
        severity: 'error',
        extract: (m) => ({
            file: m[1],
            line: parseInt(m[2]),
            message: `${m[3]}: ${m[4]}`,
        }),
    },
    {
        // Python simple error: TypeError: ...
        pattern: /^((?:Type|Value|Attribute|Import|Key|Index|Name|Syntax|Runtime)Error):\s*(.+)/gim,
        framework: 'python',
        type: 'runtime',
        severity: 'error',
        extract: (m) => ({ message: `${m[1]}: ${m[2]}` }),
    },

    // ─────────────────────────────────────────────────────────
    // Go
    // ─────────────────────────────────────────────────────────
    {
        // Go: ./main.go:15:2: undefined: varName
        pattern: /\.\/(\S+\.go):(\d+):(\d+):\s*(.+)/gi,
        framework: 'go',
        type: 'build',
        severity: 'error',
        extract: (m) => ({
            file: m[1],
            line: parseInt(m[2]),
            column: parseInt(m[3]),
            message: m[4].trim(),
        }),
    },

    // ─────────────────────────────────────────────────────────
    // Rust
    // ─────────────────────────────────────────────────────────
    {
        // Rust: error[E0425]: cannot find value `x` in this scope
        pattern: /error\[E(\d+)\]:\s*(.+?)(?:\n\s*-->\s*(\S+):(\d+):(\d+))?/gi,
        framework: 'rust',
        type: 'build',
        severity: 'error',
        extract: (m) => ({
            message: `E${m[1]}: ${m[2].trim()}`,
            file: m[3],
            line: m[4] ? parseInt(m[4]) : undefined,
            column: m[5] ? parseInt(m[5]) : undefined,
        }),
    },

    // ─────────────────────────────────────────────────────────
    // Java
    // ─────────────────────────────────────────────────────────
    {
        // Java Stack Trace: at com.example.MyClass.method(MyClass.java:15)
        pattern: /^\s*at\s+(?:[\w$.]+\/)?((?:[\w$]+\.)+[\w$]+)\(([^:]+):(\d+)\)/gm,
        framework: 'java',
        type: 'runtime',
        severity: 'error',
        extract: (m) => ({
            message: `Runtime error at ${m[1]}`,
            file: m[2],
            line: parseInt(m[3]),
        }),
    },
    {
        // Java Compiler: MyClass.java:15: error: cannot find symbol
        pattern: /^([a-zA-Z]?:?[^:]+\.java):(\d+):\s*error:\s*(.+)/gm,
        framework: 'java',
        type: 'build',
        severity: 'error',
        extract: (m) => ({
            file: m[1],
            line: parseInt(m[2]),
            message: m[3].trim(),
        }),
    },

    // ─────────────────────────────────────────────────────────
    // C# / .NET
    // ─────────────────────────────────────────────────────────
    {
        // MSBuild/CSC: Program.cs(15,5): error CS1002: ; expected
        // Also supports: File.cs(15,5): warning CS0219: ...
        pattern: /^([a-zA-Z]?:?[^:(]+\.cs)\((\d+),(\d+)\):\s*(error|warning)\s+([A-Z0-9]+):\s*(.+)/gim,
        framework: 'dotnet',
        type: 'build',
        severity: 'error', // default, extracted will override
        extract: (m) => ({
            file: m[1],
            line: parseInt(m[2]),
            column: parseInt(m[3]),
            severity: m[4].toLowerCase() as 'error' | 'warning',
            message: `${m[5]}: ${m[6].trim()}`,
        }),
    },

    // ─────────────────────────────────────────────────────────
    // C++ / C (GCC/Clang) / Swift
    // ─────────────────────────────────────────────────────────
    {
        // GCC/Clang/Swift: main.cpp:15:5: error: use of undeclared identifier
        pattern: /^([a-zA-Z]?:?[^:]+\.(?:c|cpp|h|hpp|cc|cxx|swift)):(\d+):(\d+):\s*(error|warning|note):\s*(.+)/gim,
        framework: 'cpp', // or swift
        type: 'build',
        severity: 'error',
        extract: (m) => {
            const ext = m[1].split('.').pop()?.toLowerCase();
            return {
                file: m[1],
                line: parseInt(m[2]),
                column: parseInt(m[3]),
                severity: m[4].toLowerCase() as 'error' | 'warning',
                framework: ext === 'swift' ? 'swift' : 'cpp',
                message: m[5].trim(),
            };
        },
    },

    // ─────────────────────────────────────────────────────────
    // PHP
    // ─────────────────────────────────────────────────────────
    {
        // PHP Parse error: syntax error, significant in /path/to/file.php on line 15
        pattern: /PHP\s+(?:Parse|Fatal|Warning|Notice)\s+error:\s*(.+?)\s+in\s+(.+?)\s+on\s+line\s+(\d+)/gim,
        framework: 'php',
        type: 'runtime',
        severity: 'error',
        extract: (m) => ({
            message: m[1].trim(),
            file: m[2],
            line: parseInt(m[3]),
        }),
    },

    // ─────────────────────────────────────────────────────────
    // Ruby
    // ─────────────────────────────────────────────────────────
    {
        // Ruby: app/controllers/users_controller.rb:10:in `show': undefined method
        pattern: /^([a-zA-Z]?:?[^:]+\.rb):(\d+):in\s+`([^']+)'(?::\s*(.+))?/gim,
        framework: 'ruby',
        type: 'runtime',
        severity: 'error',
        extract: (m) => ({
            file: m[1],
            line: parseInt(m[2]),
            message: m[4] ? `${m[4].trim()} (in ${m[3]})` : `Error in ${m[3]}`,
        }),
    },

    // ─────────────────────────────────────────────────────────
    // Generic fallback patterns
    // ─────────────────────────────────────────────────────────
    {
        // Universal file:line pattern (captures many other languages)
        // e.g., anything.xy:10: error: ...
        pattern: /^([a-zA-Z]?:?[^:\n]+\.\w+):(\d+)(?::(\d+))?:\s*(error|warning|fatal):\s*(.+)/gim,
        framework: 'generic',
        type: 'build',
        severity: 'error',
        extract: (m) => ({
            file: m[1],
            line: parseInt(m[2]),
            column: m[3] ? parseInt(m[3]) : undefined,
            severity: m[4].toLowerCase().includes('warning') ? 'warning' : 'error',
            message: m[5].trim(),
        }),
    },
    {
        // Generic "error:" or "Error:" at start of line
        pattern: /^(?:error|Error):\s*(.+)/gim,
        framework: 'unknown',
        type: 'runtime',
        severity: 'error',
        extract: (m) => ({ message: m[1].trim() }),
    },
    {
        // Uncaught errors
        pattern: /Uncaught\s+(\w+Error):\s*(.+)/gi,
        framework: 'runtime',
        type: 'runtime',
        severity: 'error',
        extract: (m) => ({ message: `${m[1]}: ${m[2].trim()}` }),
    },
];

// ═══════════════════════════════════════════════════════════
// PARSER FUNCTIONS
// ═══════════════════════════════════════════════════════════

/**
 * Parse dev server output for errors
 */
export function parseDevServerOutput(output: string, framework?: string): ParsedError[] {
    const errors: ParsedError[] = [];
    const seenMessages = new Set<string>();

    for (const pattern of ERROR_PATTERNS) {
        // Reset regex lastIndex for global patterns
        pattern.pattern.lastIndex = 0;

        let match: RegExpMatchArray | null;
        while ((match = pattern.pattern.exec(output)) !== null) {
            const extracted = pattern.extract(match);
            const message = extracted.message || match[0];

            // Create dedupe key
            const dedupeKey = `${message}|${extracted.file || ''}|${extracted.line || ''}`;
            if (seenMessages.has(dedupeKey)) continue;
            seenMessages.add(dedupeKey);

            const error: ParsedError = {
                id: `${pattern.framework}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                type: extracted.type ?? pattern.type,
                severity: extracted.severity ?? pattern.severity,
                message,
                file: extracted.file,
                line: extracted.line,
                column: extracted.column,
                framework: framework || pattern.framework,
                timestamp: Date.now(),
                actionable: extracted.actionable ?? categorizeActionable(message),
                suggestion: extracted.suggestion ?? getSuggestion(message),
                rawOutput: match[0],
            };

            errors.push(error);
        }
    }

    return errors;
}

/**
 * Determine if an error is actionable (can be fixed by AI)
 */
function categorizeActionable(message: string): boolean {
    const actionablePatterns = [
        /is not defined/i,
        /cannot find/i,
        /does not exist/i,
        /is not assignable/i,
        /module not found/i,
        /import/i,
        /missing/i,
        /undefined/i,
        /no-undef/i,
    ];

    return actionablePatterns.some(p => p.test(message));
}

/**
 * Get quick fix suggestion based on error message
 */
function getSuggestion(message: string): string | undefined {
    if (/module not found|cannot find module/i.test(message)) {
        return 'Install missing dependency or fix import path';
    }
    if (/is not defined|no-undef/i.test(message)) {
        return 'Declare variable or import from module';
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
