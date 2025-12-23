/**
 * Atlarix File Tools
 * ==================
 * Tools for file operations (read, write, search, find)
 * Port from StackSense
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
// FILE READING
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "read_file",
    category: ToolCategory.FILE,
    description:
        "Read the contents of a file from the workspace. Returns the full file content or relevant sections for large files.",
    cost: 1,
    requiresWorkspace: true,
    isCore: true,
    parameters: createParameters(
        {
            path: stringParam("Path to the file to read (relative to workspace)"),
            start_line: {
                type: "number",
                description: "Optional: Starting line number (1-indexed)",
            },
            end_line: {
                type: "number",
                description: "Optional: Ending line number (1-indexed)",
            },
        },
        ["path"]
    ),
    handler: async ({ path: filePath, start_line, end_line }) => {
        try {
            const fullPath = path.resolve(filePath);
            const content = await fs.promises.readFile(fullPath, "utf-8");
            const lines = content.split("\n");

            // Apply line range if specified
            const startIdx = start_line ? start_line - 1 : 0;
            const endIdx = end_line ? end_line : lines.length;
            const selectedLines = lines.slice(startIdx, endIdx);

            // Add line numbers
            const numberedLines = selectedLines
                .map((line, idx) => `${startIdx + idx + 1}: ${line}`)
                .join("\n");

            return `File: ${filePath}\nLines: ${startIdx + 1}-${endIdx}\n\n${numberedLines}`;
        } catch (error) {
            throw new Error(`Failed to read file: ${error}`);
        }
    },
});

// ═══════════════════════════════════════════════════════════
// FILE WRITING
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "write_file",
    category: ToolCategory.FILE,
    description:
        "Create or overwrite a file in the workspace. Use this to create new files or replace entire file contents.",
    cost: 5,
    requiresWorkspace: true,
    isCore: true,
    parameters: createParameters(
        {
            path: stringParam("Path to the file to write (relative to workspace)"),
            content: stringParam("Content to write to the file"),
            description: stringParam("Brief description of what this file does"),
        },
        ["path", "content", "description"]
    ),
    handler: async ({ path: filePath, content, description }) => {
        // Return permission request signal
        // The UI will show a dialog with the file preview
        return `__PERMISSION_REQUIRED__\n📝 Create/Modify File: ${filePath}\n${description}\n\nContent (${content.split("\n").length} lines):\n${content}\n\n[Approve] [Reject]`;
    },
});

// ═══════════════════════════════════════════════════════════
// MULTIPLE FILE WRITING
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "write_multiple_files",
    description:
        "Create or modify multiple files at once. Shows permission dialog for all files.",
    category: ToolCategory.FILE,
    cost: 5,
    requiresWorkspace: true,
    isCore: true,
    parameters: createParameters(
        {
            files: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        path: stringParam("File path"),
                        content: stringParam("File content"),
                        description: stringParam("What this file does"),
                    },
                    required: ["path", "content", "description"],
                },
                description: "Array of files to create/modify",
            },
        },
        ["files"]
    ),
    handler: async ({ files }) => {
        const fileList = files
            .map(
                (f: any, idx: number) =>
                    `${idx + 1}. ${f.path} (${f.content.split("\n").length} lines)\n   ${f.description}`
            )
            .join("\n");

        return `__PERMISSION_REQUIRED__\n📝 Create/Modify ${files.length} File(s):\n\n${fileList}\n\n[Approve All] [Reject]`;
    },
});

// ═══════════════════════════════════════════════════════════
// PROJECT STRUCTURE
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "list_files",
    category: ToolCategory.FILE,
    description:
        "List all files in the workspace or a specific directory. Returns file paths and basic metadata.",
    cost: 1,
    requiresWorkspace: true,
    isCore: true,
    parameters: createParameters(
        {
            path: stringParam("Path to scan (default: workspace root)"),
            max_depth: {
                type: "number",
                description: "Maximum depth to scan (default: 3)",
            },
        },
        []
    ),
    handler: async ({ path: scanPath = ".", max_depth = 3 }) => {
        try {
            const fullPath = path.resolve(scanPath);

            // Use glob to get all files
            const files = await glob("**/*", {
                cwd: fullPath,
                ignore: ["node_modules/**", ".git/**", "dist/**", "build/**"],
                dot: false,
                maxDepth: max_depth,
            });

            // Build tree structure
            const tree = buildTree(files);
            return `Project Structure (${files.length} items):\n\n${tree}`;
        } catch (error) {
            throw new Error(`Failed to scan project: ${error}`);
        }
    },
});

// ═══════════════════════════════════════════════════════════
// FILE FINDING
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "find_file",
    description: "Find files by name pattern (supports wildcards like *.ts)",
    category: ToolCategory.FILE,
    cost: 1,
    parameters: createParameters(
        {
            pattern: stringParam("File name pattern (e.g., '*.tsx', 'component*')"),
            path: stringParam("Path to search in (default: workspace root)"),
        },
        ["pattern"]
    ),
    handler: async ({ pattern, path: searchPath = "." }) => {
        try {
            const fullPath = path.resolve(searchPath);
            const files = await glob(pattern, {
                cwd: fullPath,
                ignore: ["node_modules/**", ".git/**", "dist/**"],
            });

            if (files.length === 0) {
                return `No files found matching pattern: ${pattern}`;
            }

            return `Found ${files.length} file(s):\n${files.join("\n")}`;
        } catch (error) {
            throw new Error(`Failed to find files: ${error}`);
        }
    },
});

// ═══════════════════════════════════════════════════════════
// CODE SEARCH
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "search_code",
    category: ToolCategory.FILE,
    description:
        "Search for text/code patterns across all files in the project. Returns matches with file paths and line numbers.",
    cost: 1,
    requiresWorkspace: true,
    isCore: true,
    parameters: createParameters(
        {
            query: stringParam("Text or code to search for"),
            file_pattern: stringParam(
                "Optional: File pattern to search in (e.g., '*.ts')"
            ),
            case_sensitive: booleanParam("Case-sensitive search (default: false)"),
        },
        ["query"]
    ),
    handler: async ({ query, file_pattern = "**/*", case_sensitive = false }) => {
        try {
            // Get all files matching pattern
            const files = await glob(file_pattern, {
                ignore: ["node_modules/**", ".git/**", "dist/**", "build/**"],
            });

            const matches: string[] = [];
            const searchRegex = new RegExp(
                query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                case_sensitive ? "g" : "gi"
            );

            for (const file of files) {
                try {
                    const content = await fs.promises.readFile(file, "utf-8");
                    const lines = content.split("\n");

                    lines.forEach((line, idx) => {
                        if (searchRegex.test(line)) {
                            matches.push(`${file}:${idx + 1}: ${line.trim()}`);
                        }
                    });
                } catch {
                    // Skip files that can't be read
                }
            }

            if (matches.length === 0) {
                return `No matches found for: "${query}"`;
            }

            // Limit to first 50 matches
            const displayMatches = matches.slice(0, 50);
            const truncated = matches.length > 50 ? `\n\n(${matches.length - 50} more matches not shown)` : "";

            return `Found ${matches.length} match(es):\n\n${displayMatches.join("\n")}${truncated}`;
        } catch (error) {
            throw new Error(`Search failed: ${error}`);
        }
    },
});

// ═══════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════

function buildTree(files: string[], indent: string = ""): string {
    // Group by directory
    const tree: Map<string, string[]> = new Map();

    files.forEach((file) => {
        const parts = file.split(path.sep);
        const dir = parts.length > 1 ? parts[0] : ".";
        const rest = parts.slice(1).join(path.sep);

        if (!tree.has(dir)) {
            tree.set(dir, []);
        }
        if (rest) {
            tree.get(dir)!.push(rest);
        }
    });

    let result = "";
    for (const [dir, children] of tree) {
        if (dir !== ".") {
            result += `${indent}📁 ${dir}/\n`;
            if (children.length > 0) {
                result += buildTree(children, indent + "  ");
            }
        } else {
            children.forEach((file) => {
                result += `${indent}📄 ${file}\n`;
            });
        }
    }

    return result;
}
