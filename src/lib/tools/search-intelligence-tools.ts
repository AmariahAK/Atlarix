/**
 * Search Intelligence Tools
 * =========================
 * Semantic search, deep search, and intelligent code discovery
 */

import { ToolRegistry, ToolCategory } from "./registry";
import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import {
    resolveWorkspaceIdFromRoot,
    searchBlueprintBm25,
} from "@/lib/search/bm25_semantic_index";

const execAsync = promisify(exec);

type SemanticSearchLineResult = {
    file: string;
    line: number;
    content: string;
    score: number;
    contextBefore: string[];
    contextAfter: string[];
};

async function runSemanticSearchFileFallback(options: {
    workspace: string;
    maxResults: number;
    keywords: string[];
}): Promise<{
    results: SemanticSearchLineResult[];
    total_matches: number;
    files_searched: number;
}> {
    const { workspace, maxResults, keywords } = options;
    const results: SemanticSearchLineResult[] = [];
    const files = await getAllCodeFiles(workspace);

    for (const file of files) {
        try {
            const content = await fs.readFile(file, "utf-8");
            const lines = content.split("\n");
            lines.forEach((line, index) => {
                const relevanceScore = calculateRelevance(line, keywords);
                if (relevanceScore > 0) {
                    results.push({
                        file,
                        line: index + 1,
                        content: line.trim(),
                        score: relevanceScore,
                        contextBefore: lines.slice(Math.max(0, index - 3), index),
                        contextAfter: lines.slice(index + 1, Math.min(lines.length, index + 4)),
                    });
                }
            });
        } catch {
            /* skip unreadable files */
        }
    }

    results.sort((a, b) => b.score - a.score);
    return {
        results: results.slice(0, maxResults),
        total_matches: results.length,
        files_searched: files.length,
    };
}

// ============================================
// SEMANTIC SEARCH
// ============================================

/**
 * AI-powered semantic code search
 * Uses embeddings or LLM to find conceptually similar code
 */
ToolRegistry.register({
    name: "semantic_search",
    category: ToolCategory.SEARCH_INTELLIGENCE,
    description: "Search code using natural language (AI-powered semantic search)",
    parameters: {
        query: {
            type: "string",
            description: "Natural language description of what to find",
            required: true,
        },
        workspace: {
            type: "string",
            description: "Workspace path to search in",
            required: false,
        },
        max_results: {
            type: "number",
            description: "Maximum number of results",
            required: false,
            default: 10,
        },
    },
    cost: 10,
    handler: async (params: {
        query: string;
        workspace?: string;
        max_results?: number;
    }) => {
        try {
            const rawWorkspace = params.workspace || process.cwd();
            const workspace = path.isAbsolute(rawWorkspace) ? path.normalize(rawWorkspace) : path.resolve(process.cwd(), rawWorkspace);
            const maxResults = params.max_results || 10;

            try {
                const stat = await fs.stat(workspace);
                if (!stat.isDirectory()) {
                    return { success: false, error: `Workspace path is not a directory: ${workspace}` };
                }
            } catch {
                return {
                    success: false,
                    error: `Workspace not found: ${workspace}. Check that the project path is correct.`,
                };
            }

            let keywords = extractKeywords(params.query);
            if (keywords.length === 0 && params.query.trim().length > 0) {
                keywords = [params.query.trim().toLowerCase()];
            }

            const formatTopResults = (topResults: Array<{
                file: string;
                line: number;
                content: string;
                score: number;
                contextBefore?: string[];
                contextAfter?: string[];
            }>) =>
                topResults
                    .map((r) => {
                        const relPath = workspace ? path.relative(workspace, r.file) : path.basename(r.file);
                        const ctxBefore = r.contextBefore || [];
                        const ctxAfter = r.contextAfter || [];
                        const lineNum = r.line;
                        const block = [
                            ...ctxBefore.map((l: string, i: number) => `  ${lineNum - ctxBefore.length + i}| ${l}`),
                            `> ${lineNum}| ${r.content}`,
                            ...ctxAfter.map((l: string, i: number) => `  ${lineNum + i + 1}| ${l}`),
                        ].join("\n");
                        return `${relPath}:${lineNum}\n${block}`;
                    })
                    .join("\n\n---\n\n");

            const workspaceId = await resolveWorkspaceIdFromRoot(workspace);
            if (workspaceId != null) {
                const bm25 = await searchBlueprintBm25(
                    workspaceId,
                    workspace,
                    params.query,
                    maxResults,
                );
                if (bm25 && bm25.hits.length > 0) {
                    const topResults = bm25.hits.map((h) => ({
                        file: h.file,
                        line: h.line,
                        content: h.content,
                        score: h.score,
                        contextBefore: h.contextBefore,
                        contextAfter: h.contextAfter,
                    }));
                    return {
                        success: true,
                        query: params.query,
                        results: topResults,
                        total_matches: bm25.totalMatches,
                        formatted_with_context: formatTopResults(topResults) || "No matches found.",
                        files_searched: bm25.filesIndexed,
                        workspace_path: workspace,
                    };
                }
            }

            const fallback = await runSemanticSearchFileFallback({
                workspace,
                maxResults,
                keywords,
            });

            if (fallback.files_searched === 0) {
                return {
                    success: false,
                    error: `No code files found in workspace (${workspace}). Check that the project contains .ts, .tsx, .js, .jsx, or .py files.`,
                };
            }

            const topResults = fallback.results;
            const formatted = formatTopResults(topResults);

            return {
                success: true,
                query: params.query,
                results: topResults,
                total_matches: fallback.total_matches,
                formatted_with_context: formatted || "No matches found.",
                files_searched: fallback.files_searched,
                workspace_path: workspace,
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
// FIND RELATED CODE
// ============================================

/**
 * Find code that depends on or is related to a given file/function
 */
ToolRegistry.register({
    name: "find_related_code",
    category: ToolCategory.SEARCH_INTELLIGENCE,
    description: "Find code related to a file or function (imports, dependencies, usage)",
    parameters: {
        target: {
            type: "string",
            description: "File path or function name to find relations for",
            required: true,
        },
        workspace: {
            type: "string",
            description: "Workspace path",
            required: false,
        },
    },
    cost: 8,
    handler: async (params: { target: string; workspace?: string }) => {
        try {
            const workspace = params.workspace || process.cwd();
            const results: {
                imports_this: string[];
                imported_by_this: string[];
                references: Array<{ file: string; line: number; content: string }>;
            } = {
                imports_this: [],
                imported_by_this: [],
                references: [],
            };

            // Check if target is a file
            const isFile = params.target.includes("/") || params.target.includes("\\");

            if (isFile) {
                // Find files that import this file
                const importPattern = params.target.replace(/\\/g, "/");
                const { stdout } = await execAsync(
                    `rg "import.*${path.basename(importPattern, path.extname(importPattern))}" "${workspace}" -l`,
                    { maxBuffer: 10 * 1024 * 1024 }
                );

                results.imported_by_this = stdout.trim().split("\n").filter(Boolean);

                // Find imports in this file
                try {
                    const content = await fs.readFile(params.target, "utf-8");
                    const importRegex = /import\s+.*from\s+['"]([^'"]+)['"]/g;
                    let match;

                    while ((match = importRegex.exec(content)) !== null) {
                        results.imports_this.push(match[1]);
                    }
                } catch (error) {
                    // File might not exist locally
                }
            } else {
                // Find references to a function/class name
                const { stdout } = await execAsync(
                    `rg "\\b${params.target}\\b" "${workspace}" -n`,
                    { maxBuffer: 10 * 1024 * 1024 }
                );

                const lines = stdout.trim().split("\n");
                results.references = lines.map(line => {
                    const [file, lineNum, ...content] = line.split(":");
                    return {
                        file,
                        line: parseInt(lineNum),
                        content: content.join(":").trim(),
                    };
                });
            }

            return {
                success: true,
                target: params.target,
                ...results,
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
// DEEP SEARCH
// ============================================

/**
 * Multi-source search combining local code, web, and memory
 * Inspired by Perplexica
 */
ToolRegistry.register({
    name: "deep_search",
    category: ToolCategory.SEARCH_INTELLIGENCE,
    description: "Deep search across code, web, and memory (multi-source synthesis)",
    parameters: {
        query: {
            type: "string",
            description: "Search query",
            required: true,
        },
        sources: {
            type: "array",
            description: "Sources to search: ['code', 'web', 'memory']",
            required: false,
            default: ["code", "web", "memory"],
        },
        workspace: {
            type: "string",
            description: "Workspace path",
            required: false,
        },
    },
    cost: 15,
    handler: async (params: {
        query: string;
        sources?: string[];
        workspace?: string;
    }) => {
        try {
            const sources = params.sources || ["code", "web", "memory"];
            const results = {
                code: [],
                web: [],
                memory: [],
                synthesis: "",
            };

            // Search Code
            if (sources.includes("code")) {
                const codeSearch = await ToolRegistry.execute("semantic_search", {
                    query: params.query,
                    workspace: params.workspace,
                });
                results.code = codeSearch.results || [];
            }

            // Search Web
            if (sources.includes("web")) {
                const webSearch = await ToolRegistry.execute("web_search", {
                    query: params.query,
                });
                results.web = webSearch.results || [];
            }

            // Search Memory
            if (sources.includes("memory")) {
                const memorySearch = await ToolRegistry.execute("search_memory", {
                    query: params.query,
                });
                results.memory = memorySearch.results || [];
            }

            // Synthesize results
            results.synthesis = synthesizeResults(results, params.query);

            return {
                success: true,
                query: params.query,
                sources_searched: sources,
                ...results,
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
// ENHANCED GREP SEARCH
// ============================================

/**
 * Enhanced version of search_code with context and filtering
 */
ToolRegistry.register({
    name: "grep_search",
    category: ToolCategory.SEARCH_INTELLIGENCE,
    description: "Advanced grep search with context lines and filtering",
    parameters: {
        pattern: {
            type: "string",
            description: "Search pattern (supports regex)",
            required: true,
        },
        workspace: {
            type: "string",
            description: "Directory to search in",
            required: false,
        },
        context_lines: {
            type: "number",
            description: "Number of context lines to show",
            required: false,
            default: 2,
        },
        file_pattern: {
            type: "string",
            description: "File pattern to include (e.g., '*.ts')",
            required: false,
        },
        case_sensitive: {
            type: "boolean",
            description: "Case-sensitive search",
            required: false,
            default: false,
        },
    },
    cost: 5,
    handler: async (params: {
        pattern: string;
        workspace?: string;
        context_lines?: number;
        file_pattern?: string;
        case_sensitive?: boolean;
    }) => {
        try {
            const workspace = params.workspace || process.cwd();
            const contextLines = params.context_lines || 2;
            const caseFlag = params.case_sensitive ? "" : "-i";
            const filePattern = params.file_pattern || "";

            let command = `rg "${params.pattern}" "${workspace}" -n -C ${contextLines} ${caseFlag}`;
            if (filePattern) {
                command += ` -g "${filePattern}"`;
            }

            const { stdout } = await execAsync(command, {
                maxBuffer: 10 * 1024 * 1024,
            });

            const matches = parseGrepOutput(stdout);

            return {
                success: true,
                pattern: params.pattern,
                matches,
                total_matches: matches.length,
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

function extractKeywords(query: string): string[] {
    // Remove common words and extract meaningful keywords (natural language: "where is X", "find Y")
    const stopWords = new Set([
        "the", "a", "an", "in", "on", "at", "to", "for", "of", "with",
        "where", "is", "are", "find", "get", "show", "me", "my", "that", "this",
        "and", "or", "it", "can", "how", "what", "which", "from", "by",
    ]);
    return query
        .toLowerCase()
        .split(/\s+/)
        .filter(word => word.length > 2 && !stopWords.has(word));
}

function calculateRelevance(line: string, keywords: string[]): number {
    let score = 0;
    const lowerLine = line.toLowerCase();

    keywords.forEach(keyword => {
        if (lowerLine.includes(keyword)) {
            score += 1;
            // Bonus for exact word match
            if (new RegExp(`\\b${keyword}\\b`).test(lowerLine)) {
                score += 0.5;
            }
        }
    });

    return score;
}

function getContext(lines: string[], index: number, contextSize: number): string[] {
    const start = Math.max(0, index - contextSize);
    const end = Math.min(lines.length, index + contextSize + 1);
    return lines.slice(start, end);
}

/** Format search result for display with ±3 lines of context */
export function formatSearchResultForDisplay(result: {
    file: string;
    line: number;
    content: string;
    contextBefore?: string[];
    contextAfter?: string[];
}): string {
    const relPath = result.file.includes(process.cwd())
        ? path.relative(process.cwd(), result.file)
        : result.file;
    const before = (result.contextBefore || []).map((l, i) => `  ${result.line - (result.contextBefore!.length - i)}| ${l}`).join("\n");
    const match = `> ${result.line}| ${result.content}`;
    const after = (result.contextAfter || []).map((l, i) => `  ${result.line + i + 1}| ${l}`).join("\n");
    return `${relPath}:${result.line}\n${before}\n${match}\n${after}`;
}

async function getAllCodeFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    const codeExtensions = [".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".go", ".rs"];

    async function scan(directory: string) {
        const entries = await fs.readdir(directory, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(directory, entry.name);

            // Skip node_modules, .git, etc.
            if (entry.name.startsWith(".") || entry.name === "node_modules") {
                continue;
            }

            if (entry.isDirectory()) {
                await scan(fullPath);
            } else if (codeExtensions.some(ext => entry.name.endsWith(ext))) {
                files.push(fullPath);
            }
        }
    }

    await scan(dir);
    return files;
}

function parseGrepOutput(output: string): any[] {
    const matches = [];
    const lines = output.split("\n");
    let currentMatch: any = null;

    for (const line of lines) {
        if (line.includes(":")) {
            const [file, lineNum, ...content] = line.split(":");
            if (lineNum && !isNaN(parseInt(lineNum))) {
                if (currentMatch && currentMatch.file !== file) {
                    matches.push(currentMatch);
                    currentMatch = null;
                }

                if (!currentMatch) {
                    currentMatch = {
                        file,
                        matches: [],
                    };
                }

                currentMatch.matches.push({
                    line: parseInt(lineNum),
                    content: content.join(":").trim(),
                });
            }
        }
    }

    if (currentMatch) {
        matches.push(currentMatch);
    }

    return matches;
}

function synthesizeResults(results: any, query: string): string {
    const parts = [];

    if (results.code.length > 0) {
        parts.push(`Found ${results.code.length} matches in codebase`);
    }

    if (results.web.length > 0) {
        parts.push(`${results.web.length} web results`);
    }

    if (results.memory.length > 0) {
        parts.push(`${results.memory.length} related memories`);
    }

    return parts.length > 0
        ? `Deep search for "${query}": ${parts.join(", ")}`
        : `No results found for "${query}"`;
}
