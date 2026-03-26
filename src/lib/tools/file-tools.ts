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
import {
    createFilePermissionRequest,
    createBatchPermissionRequest,
    type FileOperationPreview,
} from "./permissions/schema";
import {
    resolvePathUnderWorkspace,
    safeRelativePathUnderWorkspace,
    stripToolPathPrefixes,
} from "../../ipc/utils/safeWorkspaceRelativePath";
import {
    loadIgnorerForProject,
    normalizeRelPath,
    isRelPathIgnored,
} from "@/lib/atlarix/atlarix-ignore";

// ═══════════════════════════════════════════════════════════
// FILE READING
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// SMART FILE SLICING HELPERS
// ═══════════════════════════════════════════════════════════

type SliceContext = 'full' | 'imports' | 'exports' | 'functions' | 'classes' | 'types' | 'errors';

interface SliceResult {
    text: string;
    linesShown: number;
    strategy: string;
}

/**
 * Intelligently slice file content based on context
 */
function smartSliceFile(lines: string[], maxLines: number, context: SliceContext): SliceResult {
    switch (context) {
        case 'imports':
            // First 50 lines (imports are usually at top)
            return {
                text: lines.slice(0, Math.min(50, lines.length)).map((l, i) => `${i + 1}: ${l}`).join('\n'),
                linesShown: Math.min(50, lines.length),
                strategy: 'top-50-lines (imports)'
            };

        case 'exports':
            // Last 100 lines (exports often at bottom)
            const exportStart = Math.max(0, lines.length - 100);
            return {
                text: lines.slice(-Math.min(100, lines.length)).map((l, i) => `${exportStart + i + 1}: ${l}`).join('\n'),
                linesShown: Math.min(100, lines.length),
                strategy: 'bottom-100-lines (exports)'
            };

        case 'functions':
        case 'classes':
            // Extract function/class signatures only
            const sigPattern = context === 'functions'
                ? /^(export\s+)?(async\s+)?function\s+\w+|^(export\s+)?(const|let)\s+\w+\s*=\s*(async\s+)?\(/
                : /^(export\s+)?class\s+\w+/;
            const signatures: string[] = [];
            for (let i = 0; i < lines.length && signatures.length < maxLines; i++) {
                if (sigPattern.test(lines[i].trim())) {
                    // Include signature + next 2 lines for context
                    signatures.push(
                        `${i + 1}: ${lines[i]}`,
                        lines[i + 1] ? `${i + 2}: ${lines[i + 1]}` : '',
                        lines[i + 2] ? `${i + 3}: ${lines[i + 2]}` : '',
                        ''
                    );
                }
            }
            return {
                text: signatures.join('\n'),
                linesShown: signatures.filter(s => s).length,
                strategy: `${context}-signatures`
            };

        case 'types':
            // Extract type/interface definitions
            const types: string[] = [];
            for (let i = 0; i < lines.length; i++) {
                const trimmed = lines[i].trim();
                if (/^(export\s+)?(interface|type)\s+\w+/.test(trimmed)) {
                    // Include definition + next 5 lines
                    for (let j = 0; j < 6 && i + j < lines.length; j++) {
                        types.push(`${i + j + 1}: ${lines[i + j]}`);
                        if (lines[i + j].includes('}') || lines[i + j].includes(';')) break;
                    }
                    types.push('');
                }
            }
            return {
                text: types.slice(0, maxLines).join('\n'),
                linesShown: Math.min(types.length, maxLines),
                strategy: 'type-definitions'
            };

        case 'errors':
            // Lines with error handling
            const errorLines: string[] = [];
            for (let i = 0; i < lines.length; i++) {
                if (/catch|throw|error|Error|reject|\.catch\(/.test(lines[i])) {
                    errorLines.push(`${i + 1}: ${lines[i]}`);
                }
            }
            return {
                text: errorLines.slice(0, maxLines).join('\n'),
                linesShown: Math.min(errorLines.length, maxLines),
                strategy: 'error-handling'
            };

        case 'full':
        default:
            // Head + Tail strategy (60% top, 40% bottom)
            const headLines = Math.floor(maxLines * 0.6);
            const tailLines = Math.floor(maxLines * 0.4);

            const head = lines.slice(0, headLines).map((l, i) => `${i + 1}: ${l}`);
            const tailStart = lines.length - tailLines;
            const tail = lines.slice(-tailLines).map((l, i) => `${tailStart + i + 1}: ${l}`);

            return {
                text: [
                    ...head,
                    '',
                    `... [${lines.length - headLines - tailLines} lines omitted - use line_range or get_file_outline for details] ...`,
                    '',
                    ...tail
                ].join('\n'),
                linesShown: headLines + tailLines,
                strategy: 'head-tail'
            };
    }
}

// ═══════════════════════════════════════════════════════════
// SMART FILE READING
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "read_file",
    category: ToolCategory.FILE,
    description:
        "Read file contents with smart truncation. Returns full content for small files (<500 lines), or intelligent snippets for large files. Use context parameter to focus on specific parts.",
    cost: 1,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true,
    parameters: createParameters(
        {
            path: stringParam("Path to the file to read (relative to workspace)"),
            file_path: stringParam("Alternative: Path to the file (alias for path)"),
            max_lines: {
                type: "number",
                description: "Maximum lines to return (default: 500, max: 2000). Large files are intelligently truncated.",
            },
            context: {
                type: "string",
                description: "What to focus on: 'full' (default), 'imports', 'exports', 'functions', 'classes', 'types', 'errors'. Helps prioritize relevant sections.",
                enum: ["full", "imports", "exports", "functions", "classes", "types", "errors"],
            },
            start_line: {
                type: "number",
                description: "Read from this line (1-indexed). Use with end_line for specific range.",
            },
            end_line: {
                type: "number",
                description: "Read to this line (1-indexed). Use with start_line for specific range.",
            },
        },
        ["path"]
    ),
    handler: async ({ path: pathArg, file_path, max_lines = 500, context = 'full', start_line, end_line, workspace }) => {
        try {
            let filePath = pathArg || file_path;

            if (!filePath) {
                throw new Error("Missing required parameter: path or file_path");
            }

            const displayPath = workspace
                ? safeRelativePathUnderWorkspace(filePath)
                : stripToolPathPrefixes(filePath);

            const fullPath = workspace
                ? resolvePathUnderWorkspace(workspace, filePath)
                : path.resolve(stripToolPathPrefixes(filePath));

            console.log(`[read_file] workspace: ${workspace}, filePath: ${displayPath}, context: ${context}, max_lines: ${max_lines}`);

            const stat = await fs.promises.stat(fullPath);
            if (stat.isDirectory()) {
                throw new Error(
                    `Path "${displayPath}" is a directory, not a file. Use explore_folder or list_files for directories.`
                );
            }

            const content = await fs.promises.readFile(fullPath, "utf-8");
            const lines = content.split("\n");

            // Cap max_lines
            max_lines = Math.min(max_lines, 2000);

            // Specific line range requested
            if (start_line !== undefined && end_line !== undefined) {
                const startIdx = Math.max(0, start_line - 1);
                const endIdx = Math.min(lines.length, end_line);
                const selectedLines = lines.slice(startIdx, endIdx);

                const numberedLines = selectedLines
                    .map((line, idx) => `${startIdx + idx + 1}: ${line}`)
                    .join("\n");

                return `File: ${displayPath}\nLines: ${startIdx + 1}-${endIdx} of ${lines.length}\n\n${numberedLines}`;
            }

            // Small files: return as-is
            if (lines.length <= max_lines && context === 'full') {
                const numberedLines = lines
                    .map((line, idx) => `${idx + 1}: ${line}`)
                    .join("\n");
                return `File: ${displayPath}\nLines: 1-${lines.length} (complete)\n\n${numberedLines}`;
            }

            // Large files: use smart slicing
            const sliced = smartSliceFile(lines, max_lines, context as SliceContext);

            let result = `File: ${displayPath}\n`;
            result += `Total lines: ${lines.length} | Showing: ${sliced.linesShown} (${sliced.strategy})\n`;
            result += `💡 Tip: Use start_line/end_line for specific sections, or get_file_outline for structure.\n\n`;
            result += sliced.text;

            return result;
        } catch (error) {
            console.error(`[read_file] Error:`, error);
            throw new Error(`Failed to read file: ${error}`);
        }
    },
});

// ═══════════════════════════════════════════════════════════
// FOLDER EXPLORATION (STRUCTURED, .ATLARIXIGNORE-AWARE)
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "explore_folder",
    category: ToolCategory.FILE,
    description:
        "Explore a directory and return structured entries (files/folders) with metadata. Respects .atlarixignore when workspace is provided.",
    cost: 1,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true,
    parameters: createParameters(
        {
            path: stringParam("Directory path to explore (relative to workspace, default '.')"),
            max_entries: {
                type: "number",
                description: "Maximum entries to return (default: 200, max: 1000)",
            },
            include_hidden: booleanParam("Include dotfiles/directories (default: false)"),
            include_stats: booleanParam("Include size and modifiedAt metadata (default: true)"),
            sort: {
                type: "string",
                description: "Sort entries by name or size (default: name)",
                enum: ["name", "size"],
            },
        },
        []
    ),
    handler: async ({
        path: dirArg = ".",
        max_entries = 200,
        include_hidden = false,
        include_stats = true,
        sort = "name",
        workspace,
    }) => {
        const fullPath = workspace
            ? resolvePathUnderWorkspace(workspace, dirArg || ".")
            : path.resolve(stripToolPathPrefixes(dirArg || ".") || ".");
        const relRequestedPath = workspace
            ? safeRelativePathUnderWorkspace(dirArg || ".")
            : stripToolPathPrefixes(dirArg || ".");

        const dirStat = await fs.promises.stat(fullPath);
        if (!dirStat.isDirectory()) {
            throw new Error(`Path "${relRequestedPath}" is not a directory. Use read_file for files.`);
        }

        const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });
        const maxEntries = Math.min(Math.max(Number(max_entries) || 200, 1), 1000);
        const ig = workspace ? await loadIgnorerForProject(workspace) : null;

        const items: Array<{
            name: string;
            type: "file" | "dir";
            path: string;
            size?: number;
            modifiedAt?: string;
        }> = [];

        for (const entry of entries) {
            const name = entry.name;
            if (!include_hidden && name.startsWith(".")) continue;
            const entryPath = path.join(fullPath, name);
            const displayPath = workspace
                ? normalizeRelPath(workspace, entryPath)
                : path.join(relRequestedPath || ".", name).replace(/\\/g, "/");
            if (ig && isRelPathIgnored(ig, displayPath)) continue;

            let size: number | undefined;
            let modifiedAt: string | undefined;
            if (include_stats) {
                try {
                    const st = await fs.promises.stat(entryPath);
                    size = st.size;
                    modifiedAt = st.mtime.toISOString();
                } catch {
                    // Skip metadata if stat fails, still include entry.
                }
            }

            items.push({
                name,
                type: entry.isDirectory() ? "dir" : "file",
                path: displayPath,
                size,
                modifiedAt,
            });
        }

        if (sort === "size") {
            items.sort((a, b) => (b.size ?? 0) - (a.size ?? 0) || a.name.localeCompare(b.name));
        } else {
            items.sort((a, b) => a.name.localeCompare(b.name));
        }

        return {
            path: relRequestedPath || ".",
            total: items.length,
            truncated: items.length > maxEntries,
            items: items.slice(0, maxEntries),
        };
    },
});

// ═══════════════════════════════════════════════════════════
// FILE WRITING
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "write_file",
    category: ToolCategory.FILE,
    description:
        "Create or overwrite a file in the workspace. ALWAYS use this tool to create or modify files - never describe what you would write.",
    cost: 5,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: false, // Build mode only - modifies files
    parameters: createParameters(
        {
            path: stringParam("Path to the file to write (relative to workspace)"),
            content: stringParam("Content to write to the file"),
            description: stringParam("Brief description of what this file does"),
        },
        ["path", "content", "description"]
    ),
    handler: async ({ path: filePath, content, description, workspace, chatMode }) => {
        // Validate chatMode
        if (!chatMode) {
            console.error('[write_file] chatMode is undefined - using default "build"');
            // Default to build mode behavior
        }

        // In Ask mode, deny write operations
        if (chatMode === "ask") {
            return {
                error: "Write operations not allowed in Ask mode. Switch to Build mode to make changes.",
                operation: "write_file",
                denied: true,
            };
        }

        const normalizedPath = safeRelativePathUnderWorkspace(filePath);

        // Check if file exists (to set type as update vs create)
        let fileType: "create" | "update" = "create";
        let oldContent: string | undefined;
        if (workspace) {
            try {
                const fullPath = resolvePathUnderWorkspace(workspace, normalizedPath);
                await fs.promises.access(fullPath);
                fileType = "update";
                oldContent = await fs.promises.readFile(fullPath, "utf-8");
            } catch {
                fileType = "create";
            }
        }

        // Return permission request OBJECT (not JSON string!)
        return {
            __permission_required: true,
            operation: "write_file",
            preview: {
                path: normalizedPath,
                content,
                ...(oldContent !== undefined && { oldContent }),
                description,
                type: fileType,
                lines: content.split("\n").length,
            },
            reasoning: `${fileType === "update" ? "Modifying" : "Creating"} ${normalizedPath}: ${description}`,
        };
    },
});

// ═══════════════════════════════════════════════════════════
// MULTIPLE FILE WRITING
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "write_multiple_files",
    description:
        "Create or modify multiple files at once. ALWAYS use this tool for batch file operations.",
    category: ToolCategory.FILE,
    cost: 5,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: false, // Build mode only - modifies files
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
    handler: async ({ files, workspace, chatMode }) => {
        // Validate chatMode
        if (chatMode === "ask") {
            return {
                error: "Write operations not allowed in Ask mode. Switch to Build mode.",
                operation: "write_multiple_files",
                denied: true,
            };
        }

        // Convert to FileOperationPreview array with normalized paths
        const previews: FileOperationPreview[] = files.map((f: any) => {
            const normalizedPath = safeRelativePathUnderWorkspace(String(f.path));

            return {
                path: normalizedPath,
                content: f.content,
                description: f.description,
                type: "create" as const,
                lines: f.content.split("\n").length,
            };
        });

        // Return permission request OBJECT directly
        return {
            __permission_required: true,
            operation: "write_multiple_files",
            preview: previews,
            reasoning: `Batch operation: ${files.length} file(s)`,
            affectedFiles: previews.map(p => p.path),
        };
    },
});

// ═══════════════════════════════════════════════════════════
// PROJECT STRUCTURE (WITH STATS)
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "list_files",
    category: ToolCategory.FILE,
    description:
        "List all files in the workspace or a specific directory. Use include_stats to see file sizes to help decide which files to read.",
    cost: 1,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true,
    parameters: createParameters(
        {
            path: stringParam("Path to scan (default: workspace root)"),
            directory: stringParam("Alternative: Directory to scan (alias for path)"),
            max_depth: {
                type: "number",
                description: "Maximum depth to scan (default: 3)",
            },
            include_stats: booleanParam("Include file sizes and line counts to help decide what to read (default: false)"),
        },
        []
    ),
    handler: async ({ path: pathArg, directory, max_depth = 3, include_stats = false, workspace }) => {
        try {
            const scanRaw = pathArg || directory || ".";

            const fullPath = workspace
                ? resolvePathUnderWorkspace(workspace, scanRaw)
                : path.resolve(stripToolPathPrefixes(scanRaw) || ".");

            const files = await glob("**/*", {
                cwd: fullPath,
                ignore: ["node_modules/**", ".git/**", "dist/**", "build/**", "venv/**", "__pycache__/**"],
                dot: false,
                maxDepth: max_depth,
            });

            if (!include_stats) {
                // Simple tree output
                const tree = buildTree(files);
                return `Project Structure (${files.length} items):\n\n${tree}`;
            }

            // With stats: show file info to help AI decide what to read
            interface FileInfo {
                path: string;
                size: number;
                lines?: number;
            }

            const fileInfos: FileInfo[] = [];

            for (const file of files.slice(0, 100)) { // Limit to 100 files for stats
                try {
                    const filePath = path.join(fullPath, file);
                    const stat = await fs.promises.stat(filePath);

                    if (stat.isFile()) {
                        const info: FileInfo = {
                            path: file,
                            size: stat.size,
                        };

                        // Count lines for text files
                        if (stat.size < 500000) { // Only for files < 500KB
                            try {
                                const content = await fs.promises.readFile(filePath, 'utf-8');
                                info.lines = content.split('\n').length;
                            } catch {
                                // Binary or unreadable file
                            }
                        }

                        fileInfos.push(info);
                    }
                } catch {
                    // Skip inaccessible files
                }
            }

            // Sort by lines (largest first) to help identify complex files
            fileInfos.sort((a, b) => (b.lines || 0) - (a.lines || 0));

            let output = `📊 **Project Structure with Stats** (${files.length} items)\n\n`;

            // Group by size category
            const large = fileInfos.filter(f => (f.lines || 0) > 500);
            const medium = fileInfos.filter(f => (f.lines || 0) > 100 && (f.lines || 0) <= 500);
            const small = fileInfos.filter(f => (f.lines || 0) <= 100);

            if (large.length > 0) {
                output += `**🔴 Large Files (>500 lines)** - Use get_file_outline first:\n`;
                large.slice(0, 10).forEach(f => {
                    output += `  - ${f.path} (${f.lines} lines, ${(f.size / 1024).toFixed(1)}KB)\n`;
                });
                output += '\n';
            }

            if (medium.length > 0) {
                output += `**🟡 Medium Files (100-500 lines)** - Consider using context param:\n`;
                medium.slice(0, 15).forEach(f => {
                    output += `  - ${f.path} (${f.lines} lines)\n`;
                });
                output += '\n';
            }

            if (small.length > 0) {
                output += `**🟢 Small Files (<100 lines)** - Safe to read fully:\n`;
                small.slice(0, 20).forEach(f => {
                    output += `  - ${f.path} (${f.lines || '?'} lines)\n`;
                });
                if (small.length > 20) {
                    output += `  ... and ${small.length - 20} more small files\n`;
                }
            }

            output += `\n💡 **Tip:** For large files, use \`get_file_outline\` first, then \`view_symbol\` for specific functions.`;

            return output;
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
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true, // Safe for Ask mode
    parameters: createParameters(
        {
            pattern: stringParam("File name pattern (e.g., '*.tsx', 'component*')"),
            path: stringParam("Path to search in (default: workspace root)"),
        },
        ["pattern"]
    ),
    handler: async ({ pattern, path: searchPath = ".", workspace }) => {
        try {
            const fullPath = workspace
                ? resolvePathUnderWorkspace(workspace, searchPath || ".")
                : path.resolve(stripToolPathPrefixes(searchPath || ".") || ".");
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
// CODE SEARCH (WITH CONTEXT)
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "search_code",
    category: ToolCategory.FILE,
    description:
        "Search for text/code patterns across all files in the project. Returns matches with surrounding context. Use to find where functions/classes are defined.",
    cost: 1,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true,
    parameters: createParameters(
        {
            query: stringParam("Text or code to search for"),
            pattern: stringParam("Alternative: Search pattern (alias for query)"),
            file_pattern: stringParam(
                "Optional: File pattern to search in (e.g., '*.ts')"
            ),
            case_sensitive: booleanParam("Case-sensitive search (default: false)"),
            context_lines: {
                type: "number",
                description: "Number of lines to show before/after each match (default: 2, max: 5). Set to 0 for compact results.",
            },
        },
        ["query"]
    ),
    handler: async ({ query: queryArg, pattern, file_pattern = "**/*", case_sensitive = false, context_lines = 2, workspace }) => {
        try {
            const query = queryArg || pattern;

            if (!query) {
                throw new Error("Missing required parameter: query or pattern");
            }

            // Cap context lines
            context_lines = Math.min(Math.max(0, context_lines), 5);

            const searchCwd = workspace || process.cwd();
            const files = await glob(file_pattern, {
                cwd: searchCwd,
                ignore: ["node_modules/**", ".git/**", "dist/**", "build/**", "venv/**", "__pycache__/**"],
            });

            interface Match {
                file: string;
                line: number;
                content: string;
                context: string[];
            }

            const matches: Match[] = [];
            const searchRegex = new RegExp(
                query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                case_sensitive ? "g" : "gi"
            );

            for (const file of files) {
                try {
                    const fullFilePath = path.join(searchCwd, file);
                    const content = await fs.promises.readFile(fullFilePath, "utf-8");
                    const lines = content.split("\n");

                    for (let idx = 0; idx < lines.length; idx++) {
                        if (searchRegex.test(lines[idx])) {
                            // Build context
                            const contextStart = Math.max(0, idx - context_lines);
                            const contextEnd = Math.min(lines.length, idx + context_lines + 1);
                            const contextLines: string[] = [];

                            for (let j = contextStart; j < contextEnd; j++) {
                                const prefix = j === idx ? "→ " : "  ";
                                contextLines.push(`${prefix}${j + 1}: ${lines[j]}`);
                            }

                            matches.push({
                                file,
                                line: idx + 1,
                                content: lines[idx].trim(),
                                context: contextLines,
                            });

                            if (matches.length >= 30) break; // Limit matches per file
                        }
                    }
                } catch {
                    // Skip files that can't be read
                }

                if (matches.length >= 50) break; // Total limit
            }

            if (matches.length === 0) {
                return `No matches found for: "${query}"\n\nTry:\n- Different spelling\n- Broader pattern\n- Different file_pattern (e.g., '*.ts')`;
            }

            // Format output with context
            let output = `Found ${matches.length} match(es) for "${query}":\n\n`;

            if (context_lines > 0) {
                // With context: show grouped by file
                const byFile = new Map<string, Match[]>();
                matches.forEach(m => {
                    if (!byFile.has(m.file)) byFile.set(m.file, []);
                    byFile.get(m.file)!.push(m);
                });

                for (const [file, fileMatches] of byFile) {
                    output += `📄 **${file}**\n`;
                    fileMatches.slice(0, 5).forEach(m => {
                        output += m.context.join("\n") + "\n\n";
                    });
                    if (fileMatches.length > 5) {
                        output += `  ... and ${fileMatches.length - 5} more in this file\n\n`;
                    }
                }
            } else {
                // Compact: just file:line: content
                matches.forEach(m => {
                    output += `${m.file}:${m.line}: ${m.content}\n`;
                });
            }

            if (matches.length >= 50) {
                output += `\n(Limited to 50 matches. Use file_pattern to narrow search.)`;
            }

            output += `\n\n💡 **Tip:** Use \`view_symbol('${query}')\` to see the full function/class, or \`read_file\` with \`start_line/end_line\` for specific ranges.`;

            return output;
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
