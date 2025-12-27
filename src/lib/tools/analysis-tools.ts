/**
 * Code Analysis Tools
 * ==================
 * AST parsing, dependency analysis, and code health checks
 */

import { ToolRegistry, ToolCategory } from "./registry";
import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// ============================================
// ANALYZE CONTEXT
// ============================================

/**
 * Extract code structure (classes, functions, imports)
 * Uses simple pattern matching (can be enhanced with AST later)
 */
ToolRegistry.register({
    name: "analyze_context",
    category: ToolCategory.CODE,
    description: "Analyze code structure (classes, functions, imports, exports)",
    parameters: {
        filepath: {
            type: "string",
            description: "File to analyze",
            required: true,
        },
    },
    cost: 5,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true, // Safe for Ask mode - only analyzes code
    handler: async (params: { filepath: string }) => {
        try {
            const content = await fs.readFile(params.filepath, "utf-8");
            const lines = content.split("\n");

            const context = {
                filepath: params.filepath,
                language: detectLanguage(params.filepath),
                imports: [] as string[],
                exports: [] as string[],
                classes: [] as Array<{ name: string; line: number; methods: string[] }>,
                functions: [] as Array<{ name: string; line: number; params: string[] }>,
                variables: [] as Array<{ name: string; line: number; type: string }>,
                total_lines: lines.length,
                code_lines: 0,
                comment_lines: 0,
            };

            // Simple pattern-based extraction
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();

                // Skip empty lines
                if (!line) continue;

                // Count code vs comments
                if (line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) {
                    context.comment_lines++;
                } else {
                    context.code_lines++;
                }

                // Imports (JS/TS)
                if (line.startsWith("import ") || line.includes("require(")) {
                    const importMatch = line.match(/from ['"]([^'"]+)['"]/);
                    if (importMatch) {
                        context.imports.push(importMatch[1]);
                    }
                }

                // Exports
                if (line.startsWith("export ")) {
                    context.exports.push(line);
                }

                // Classes
                const classMatch = line.match(/class\s+(\w+)/);
                if (classMatch) {
                    const className = classMatch[1];
                    const methods: string[] = [];

                    // Find methods (simple approach)
                    for (let j = i + 1; j < Math.min(i + 100, lines.length); j++) {
                        const methodMatch = lines[j].match(/(\w+)\s*\([^)]*\)\s*{/);
                        if (methodMatch) {
                            methods.push(methodMatch[1]);
                        }
                        if (lines[j].includes("}") && lines[j].trim() === "}") {
                            break; // End of class
                        }
                    }

                    context.classes.push({
                        name: className,
                        line: i + 1,
                        methods,
                    });
                }

                // Functions
                const funcMatch = line.match(/function\s+(\w+)\s*\(([^)]*)\)/);
                const arrowMatch = line.match(/const\s+(\w+)\s*=\s*\(([^)]*)\)\s*=>/);

                if (funcMatch) {
                    context.functions.push({
                        name: funcMatch[1],
                        line: i + 1,
                        params: funcMatch[2].split(",").map(p => p.trim()).filter(Boolean),
                    });
                } else if (arrowMatch) {
                    context.functions.push({
                        name: arrowMatch[1],
                        line: i + 1,
                        params: arrowMatch[2].split(",").map(p => p.trim()).filter(Boolean),
                    });
                }

                // Variables (const/let/var)
                const varMatch = line.match(/(const|let|var)\s+(\w+)/);
                if (varMatch && !line.includes("function") && !line.includes("=>")) {
                    context.variables.push({
                        name: varMatch[2],
                        line: i + 1,
                        type: varMatch[1],
                    });
                }
            }

            return {
                success: true,
                ...context,
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    },
});

// ============================================
// GET CHANGE IMPACT
// ============================================

/**
 * Analyze what files depend on a given file
 */
ToolRegistry.register({
    name: "get_change_impact",
    category: ToolCategory.CODE,
    description: "Analyze dependencies and impact of changing a file",
    parameters: {
        filepath: {
            type: "string",
            description: "File to analyze",
            required: true,
        },
        workspace: {
            type: "string",
            description: "Workspace path",
            required: false,
        },
    },
    cost: 8,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true, // Safe for Ask mode - only analyzes impact
    handler: async (params: { filepath: string; workspace?: string }) => {
        try {
            const workspace = params.workspace || process.cwd();
            const fileName = path.basename(params.filepath, path.extname(params.filepath));

            // Find files that import this file
            const { stdout } = await execAsync(
                `rg "import.*${fileName}" "${workspace}" -l --type js --type ts`,
                { maxBuffer: 10 * 1024 * 1024 }
            ).catch(() => ({ stdout: "" }));

            const dependents = stdout
                .trim()
                .split("\n")
                .filter(Boolean)
                .filter(file => file !== params.filepath);

            // Analyze the target file
            const analysis = await ToolRegistry.execute("analyze_context", {
                filepath: params.filepath,
            });

            return {
                success: true,
                filepath: params.filepath,
                dependent_files: dependents,
                dependency_count: dependents.length,
                impact_level: calculateImpactLevel(dependents.length),
                file_analysis: analysis.result,
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    },
});

// ============================================
// DIAGNOSE ISSUE
// ============================================

/**
 * Run linting and basic health checks on code
 */
ToolRegistry.register({
    name: "diagnose_issue",
    category: ToolCategory.CODE,
    description: "Run linting and diagnostics on a file",
    parameters: {
        filepath: {
            type: "string",
            description: "File to diagnose",
            required: true,
        },
    },
    cost: 5,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true, // Safe for Ask mode - only runs diagnostics
    handler: async (params: { filepath: string }) => {
        try {
            const issues: Array<{ type: string; message: string; line?: number }> = [];

            // Read file
            const content = await fs.readFile(params.filepath, "utf-8");
            const lines = content.split("\n");

            // Basic checks
            // 1. Check for TODO/FIXME comments
            lines.forEach((line, index) => {
                if (line.includes("TODO") || line.includes("FIXME")) {
                    issues.push({
                        type: "todo",
                        message: line.trim(),
                        line: index + 1,
                    });
                }
            });

            // 2. Check for console.log (in production code)
            lines.forEach((line, index) => {
                if (line.includes("console.log") || line.includes("console.error")) {
                    issues.push({
                        type: "debug",
                        message: "Debug statement found",
                        line: index + 1,
                    });
                }
            });

            // 3. Check for long lines (>120 chars)
            lines.forEach((line, index) => {
                if (line.length > 120) {
                    issues.push({
                        type: "style",
                        message: `Line too long (${line.length} characters)`,
                        line: index + 1,
                    });
                }
            });

            // 4. Check for missing error handling
            const hasTryCatch = content.includes("try") && content.includes("catch");
            const hasAsync = content.includes("async");

            if (hasAsync && !hasTryCatch) {
                issues.push({
                    type: "warning",
                    message: "Async code without try-catch",
                });
            }

            return {
                success: true,
                filepath: params.filepath,
                issues,
                issue_count: issues.length,
                severity: issues.length > 10 ? "high" : issues.length > 5 ? "medium" : "low",
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    },
});

// ============================================
// HEALTH CHECK
// ============================================

/**
 * Overall project health assessment
 */
ToolRegistry.register({
    name: "health_check",
    category: ToolCategory.CODE,
    description: "Run overall project health check",
    parameters: {
        workspace: {
            type: "string",
            description: "Project directory",
            required: false,
        },
    },
    cost: 10,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true, // Safe for Ask mode - only checks project health
    handler: async (params: { workspace?: string }) => {
        try {
            const workspace = params.workspace || process.cwd();
            const health = {
                overall_score: 0,
                checks: [] as Array<{ name: string; status: string; message: string }>,
            };

            // 1. Check package.json exists
            try {
                await fs.access(path.join(workspace, "package.json"));
                health.checks.push({
                    name: "package.json",
                    status: "pass",
                    message: "Found package.json",
                });
            } catch {
                health.checks.push({
                    name: "package.json",
                    status: "fail",
                    message: "No package.json found",
                });
            }

            // 2. Check node_modules exists
            try {
                await fs.access(path.join(workspace, "node_modules"));
                health.checks.push({
                    name: "dependencies",
                    status: "pass",
                    message: "Dependencies installed",
                });
            } catch {
                health.checks.push({
                    name: "dependencies",
                    status: "warn",
                    message: "Dependencies not installed",
                });
            }

            // 3. Check for git
            try {
                await execAsync("git rev-parse --git-dir", { cwd: workspace });
                health.checks.push({
                    name: "version_control",
                    status: "pass",
                    message: "Git initialized",
                });
            } catch {
                health.checks.push({
                    name: "version_control",
                    status: "warn",
                    message: "Not a git repository",
                });
            }

            // 4. Check for README
            try {
                await fs.access(path.join(workspace, "README.md"));
                health.checks.push({
                    name: "documentation",
                    status: "pass",
                    message: "README exists",
                });
            } catch {
                health.checks.push({
                    name: "documentation",
                    status: "warn",
                    message: "No README found",
                });
            }

            // Calculate score
            const passCount = health.checks.filter(c => c.status === "pass").length;
            health.overall_score = Math.round((passCount / health.checks.length) * 100);

            return {
                success: true,
                workspace,
                ...health,
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    },
});

// ============================================
// HELPER FUNCTIONS
// ============================================

function detectLanguage(filepath: string): string {
    const ext = path.extname(filepath);
    const langMap: Record<string, string> = {
        ".js": "javascript",
        ".jsx": "javascript",
        ".ts": "typescript",
        ".tsx": "typescript",
        ".py": "python",
        ".java": "java",
        ".go": "go",
        ".rs": "rust",
        ".cpp": "cpp",
        ".c": "c",
    };
    return langMap[ext] || "unknown";
}

function calculateImpactLevel(dependencyCount: number): string {
    if (dependencyCount === 0) return "none";
    if (dependencyCount < 3) return "low";
    if (dependencyCount < 10) return "medium";
    return "high";
}
