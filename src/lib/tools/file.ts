/**
 * Atlarix File Tools
 * ==================
 * Consolidated file operations: reading, writing, listing, finding,
 * structural overview, and advanced fs operations.
 *
 * Absorbs: file-tools, advanced-file-tools, symbol-tools,
 * project-structure-tools.
 */

import * as fs from "fs";
import * as path from "path";
import fsp from "fs/promises";
import { glob } from "glob";
import {
    ToolRegistry,
    ToolCategory,
    createParameters,
    stringParam,
    booleanParam,
    numberParam,
} from "./registry";
import { type FileOperationPreview } from "./permissions/schema";
import { enrichPermissionWithBlastRadius } from "./permissions/enrich-blast-radius";
import {
    resolvePathUnderWorkspace,
    safeRelativePathUnderWorkspace,
    stripToolPathPrefixes,
} from "../../ipc/utils/safeWorkspaceRelativePath";
import { safeJoin } from "../../ipc/utils/path_utils";
import {
    loadIgnorerForProject,
    normalizeRelPath,
    isRelPathIgnored,
} from "@/lib/atlarix/atlarix-ignore";
import {
    assertReadablePath,
    ENV_SECRET_BLOCK_MESSAGE,
    isBlockedSecretBasename,
} from "@/lib/security/env-secret-paths";
import {
    logReadFileError,
    logReadFileUnexpected,
    readFileStructuredError,
    type ReadFileStructuredError,
} from "./file-read-errors";

const READ_FILE_DEFAULT_MAX_LINES = 2000;
const READ_FILE_MAX_LINES_CAP = 10_000;
const READ_FILE_DEFAULT_MAX_BYTES = 80_000;
const READ_FILE_MAX_BYTES_CAP = 200_000;

function truncateUtf8ByBytes(text: string, maxBytes: number): string {
    const buf = Buffer.from(text, "utf8");
    if (buf.length <= maxBytes) return text;
    const cut = buf.subarray(0, Math.max(0, maxBytes - 120));
    return (
        cut.toString("utf8") +
        "\n\n… [truncated: exceeded max_bytes; lower max_lines/max_bytes or use start_line/end_line]"
    );
}

// ═══════════════════════════════════════════════════════════
// SMART FILE SLICING HELPERS
// ═══════════════════════════════════════════════════════════

type SliceContext = 'full' | 'imports' | 'exports' | 'functions' | 'classes' | 'types' | 'errors';

interface SliceResult {
    text: string;
    linesShown: number;
    strategy: string;
}

function smartSliceFile(lines: string[], maxLines: number, context: SliceContext): SliceResult {
    switch (context) {
        case 'imports':
            return {
                text: lines.slice(0, Math.min(50, lines.length)).map((l, i) => `${i + 1}: ${l}`).join('\n'),
                linesShown: Math.min(50, lines.length),
                strategy: 'top-50-lines (imports)'
            };

        case 'exports':
            const exportStart = Math.max(0, lines.length - 100);
            return {
                text: lines.slice(-Math.min(100, lines.length)).map((l, i) => `${exportStart + i + 1}: ${l}`).join('\n'),
                linesShown: Math.min(100, lines.length),
                strategy: 'bottom-100-lines (exports)'
            };

        case 'functions':
        case 'classes':
            const sigPattern = context === 'functions'
                ? /^(export\s+)?(async\s+)?function\s+\w+|^(export\s+)?(const|let)\s+\w+\s*=\s*(async\s+)?\(/
                : /^(export\s+)?class\s+\w+/;
            const signatures: string[] = [];
            for (let i = 0; i < lines.length && signatures.length < maxLines; i++) {
                if (sigPattern.test(lines[i].trim())) {
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
            const types: string[] = [];
            for (let i = 0; i < lines.length; i++) {
                const trimmed = lines[i].trim();
                if (/^(export\s+)?(interface|type)\s+\w+/.test(trimmed)) {
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
        "Read file contents with smart truncation. Default ~2000 lines / 80KB; pass smaller max_lines or max_bytes to sample huge files. Use context or start_line/end_line to focus.",
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
                description: `Maximum lines to return (default: ${READ_FILE_DEFAULT_MAX_LINES}, max: ${READ_FILE_MAX_LINES_CAP}).`,
            },
            max_bytes: numberParam(
                "Max UTF-8 bytes of returned text (default 80000, max 200000).",
                READ_FILE_DEFAULT_MAX_BYTES,
                1024,
                READ_FILE_MAX_BYTES_CAP,
            ),
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
    handler: async ({
        path: pathArg,
        file_path,
        max_lines = READ_FILE_DEFAULT_MAX_LINES,
        max_bytes = READ_FILE_DEFAULT_MAX_BYTES,
        context = "full",
        start_line,
        end_line,
        workspace,
    }) => {
        let displayPath: string | undefined;
        try {
            let filePath = pathArg || file_path;

            if (!filePath) {
                const structured: ReadFileStructuredError = {
                    success: false,
                    error: "missing_path",
                    message: "Missing required parameter: path or file_path",
                };
                logReadFileError(structured);
                return structured;
            }

            try {
                displayPath = workspace
                    ? safeRelativePathUnderWorkspace(filePath)
                    : stripToolPathPrefixes(filePath);
            } catch (normErr) {
                const structured = readFileStructuredError(normErr, String(filePath));
                if (structured) {
                    logReadFileError(structured);
                    return structured;
                }
                throw normErr;
            }

            const fullPath = workspace
                ? resolvePathUnderWorkspace(workspace, filePath)
                : path.resolve(stripToolPathPrefixes(filePath));

            try {
                if (workspace) {
                    assertReadablePath(String(filePath), workspace);
                } else if (isBlockedSecretBasename(path.basename(fullPath))) {
                    throw new Error(ENV_SECRET_BLOCK_MESSAGE);
                }
            } catch (pathErr) {
                const structured = readFileStructuredError(pathErr, displayPath);
                if (structured) {
                    logReadFileError(structured);
                    return structured;
                }
                throw pathErr;
            }

            const capLines = Math.min(
                READ_FILE_MAX_LINES_CAP,
                Math.max(1, Number(max_lines) || READ_FILE_DEFAULT_MAX_LINES),
            );
            const capBytes = Math.min(
                READ_FILE_MAX_BYTES_CAP,
                Math.max(1024, Number(max_bytes) || READ_FILE_DEFAULT_MAX_BYTES),
            );

            const stat = await fs.promises.stat(fullPath);
            if (stat.isDirectory()) {
                const structured = readFileStructuredError(
                    new Error(`Path "${displayPath}" is a directory, not a file.`),
                    displayPath,
                );
                if (structured) {
                    logReadFileError(structured);
                    return structured;
                }
            }

            const content = await fs.promises.readFile(fullPath, "utf-8");
            const lines = content.split("\n");

            if (start_line !== undefined && end_line !== undefined) {
                const startIdx = Math.max(0, start_line - 1);
                const endIdx = Math.min(lines.length, end_line);
                const selectedLines = lines.slice(startIdx, endIdx);

                const numberedLines = selectedLines
                    .map((line, idx) => `${startIdx + idx + 1}: ${line}`)
                    .join("\n");

                const block = `File: ${displayPath}\nLines: ${startIdx + 1}-${endIdx} of ${lines.length}\n\n${numberedLines}`;
                return truncateUtf8ByBytes(block, capBytes);
            }

            if (lines.length <= capLines && context === "full") {
                const numberedLines = lines
                    .map((line, idx) => `${idx + 1}: ${line}`)
                    .join("\n");
                const block = `File: ${displayPath}\nLines: 1-${lines.length} (complete)\n\n${numberedLines}`;
                return truncateUtf8ByBytes(block, capBytes);
            }

            const sliced = smartSliceFile(lines, capLines, context as SliceContext);

            let result = `File: ${displayPath}\n`;
            result += `Total lines: ${lines.length} | Showing: ${sliced.linesShown} (${sliced.strategy})\n`;
            result +=
                "💡 Tip: Use start_line/end_line for specific sections, or get_file_outline for structure.\n\n";
            result += sliced.text;

            return truncateUtf8ByBytes(result, capBytes);
        } catch (error) {
            const structured = readFileStructuredError(error, displayPath);
            if (structured) {
                logReadFileError(structured);
                return structured;
            }
            logReadFileUnexpected(error, displayPath);
            return {
                success: false,
                error: "read_failed",
                path: displayPath,
                message: error instanceof Error ? error.message : String(error),
            };
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
        "Explore a directory and return structured entries (files/folders) with metadata. Default 500 entries (max 2000). Set recursive=true and max_depth (1–5) for a bounded tree walk. Respects .atlarixignore when workspace is provided.",
    cost: 1,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true,
    parameters: createParameters(
        {
            path: stringParam("Directory path to explore (relative to workspace, default '.')"),
            max_entries: {
                type: "number",
                description: "Maximum entries to return (default: 500, max: 2000)",
            },
            recursive: booleanParam(
                "When true, walk subdirectories up to max_depth (default false).",
            ),
            max_depth: numberParam(
                "Max directory depth below path when recursive (1–5, default 2).",
                2,
                1,
                5,
            ),
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
        max_entries = 500,
        recursive = false,
        max_depth = 2,
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
            throw new Error(
                `Path "${relRequestedPath}" is not a directory. Use read_file for files.`,
            );
        }

        const maxEntries = Math.min(Math.max(Number(max_entries) || 500, 1), 2000);
        const depthCap = Math.min(5, Math.max(1, Number(max_depth) || 2));
        const ig = workspace ? await loadIgnorerForProject(workspace) : null;

        const items: Array<{
            name: string;
            type: "file" | "dir";
            path: string;
            size?: number;
            modifiedAt?: string;
        }> = [];

        type QItem = { abs: string; rel: string; depth: number };
        const queue: QItem[] = [{ abs: fullPath, rel: relRequestedPath || ".", depth: 0 }];

        while (queue.length > 0 && items.length < maxEntries) {
            const { abs, rel, depth } = queue.shift()!;
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(abs, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                if (items.length >= maxEntries) break;
                const name = entry.name;
                if (!include_hidden && name.startsWith(".")) continue;
                const entryPath = path.join(abs, name);
                const displayPath = workspace
                    ? normalizeRelPath(workspace, entryPath)
                    : path.join(rel || ".", name).replace(/\\/g, "/");
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

                if (
                    recursive &&
                    entry.isDirectory() &&
                    depth + 1 < depthCap &&
                    items.length < maxEntries
                ) {
                    queue.push({ abs: entryPath, rel: displayPath, depth: depth + 1 });
                }
            }
        }

        if (sort === "size") {
            items.sort((a, b) => (b.size ?? 0) - (a.size ?? 0) || a.name.localeCompare(b.name));
        } else {
            items.sort((a, b) => a.name.localeCompare(b.name));
        }

        return {
            path: relRequestedPath || ".",
            total: items.length,
            truncated: items.length >= maxEntries,
            recursive: Boolean(recursive),
            max_depth: recursive ? depthCap : undefined,
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
    isReadOnly: false,
    parameters: createParameters(
        {
            path: stringParam("Path to the file to write (relative to workspace)"),
            content: stringParam("Content to write to the file"),
            description: stringParam("Brief description of what this file does"),
        },
        ["path", "content", "description"]
    ),
    handler: async ({ path: filePath, content, description, workspace, chatMode, agentMode, _chatSessionId, workspaceId }) => {
        if (!chatMode) {
            console.error('[write_file] chatMode is undefined - using default "build"');
        }

        if (chatMode === "ask") {
            return {
                error: "Write operations not allowed in Ask mode. Switch to Plan mode for the plan file, or Build mode to make code changes.",
                operation: "write_file",
                denied: true,
            };
        }

        const normalizedPath = safeRelativePathUnderWorkspace(filePath);

        if (chatMode === "plan") {
            const norm = normalizedPath.replace(/\\/g, "/");
            const planOk = /(^|\/)\.atlarix\/ATLARIX_PLAN\.md$/.test(norm);
            const memoryOk = /(^|\/)\.atlarix\/ATLARIX\.md$/i.test(norm);
            if (!planOk && !memoryOk) {
                return {
                    error:
                        "Plan mode may only write .atlarix/ATLARIX_PLAN.md (prefer write_implementation_plan) or .atlarix/ATLARIX.md. Switch to Build for application code.",
                    operation: "write_file",
                    denied: true,
                };
            }
        }

        let fileType: "create" | "update" = "create";
        let oldContent: string | undefined;
        if (workspace) {
            try {
                const fullPath = resolvePathUnderWorkspace(workspace, normalizedPath);
                assertReadablePath(normalizedPath, workspace);
                await fs.promises.access(fullPath);
                fileType = "update";
                oldContent = await fs.promises.readFile(fullPath, "utf-8");
            } catch {
                fileType = "create";
            }
        }

        const metadata = workspace
            ? await enrichPermissionWithBlastRadius(workspace, normalizedPath, {
                agentMode,
                chatSessionId: _chatSessionId,
                workspaceId,
            })
            : undefined;

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
            ...(metadata ? { metadata } : {}),
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
    isReadOnly: false,
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
        if (chatMode === "ask") {
            return {
                error: "Write operations not allowed in Ask mode. Switch to Build mode.",
                operation: "write_multiple_files",
                denied: true,
            };
        }

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
// PROJECT STRUCTURE LISTING (WITH STATS)
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
                const tree = buildTree(files);
                return `Project Structure (${files.length} items):\n\n${tree}`;
            }

            interface FileInfo {
                path: string;
                size: number;
                lines?: number;
            }

            const fileInfos: FileInfo[] = [];

            for (const file of files.slice(0, 100)) {
                try {
                    const filePath = path.join(fullPath, file);
                    const stat = await fs.promises.stat(filePath);

                    if (stat.isFile()) {
                        const info: FileInfo = {
                            path: file,
                            size: stat.size,
                        };

                        if (stat.size < 500000 && workspace) {
                            try {
                                assertReadablePath(file, workspace);
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

            fileInfos.sort((a, b) => (b.lines || 0) - (a.lines || 0));

            let output = `📊 **Project Structure with Stats** (${files.length} items)\n\n`;

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
    isReadOnly: true,
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
// FILE OUTLINE (symbol table of contents)
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
        interface: /$/,
        type: /$/,
        import: /^import\s+/,
        export: /^export\s+/,
    },
    python: {
        function: /^(async\s+)?def\s+(\w+)/,
        class: /^class\s+(\w+)/,
        interface: /$/,
        type: /$/,
        import: /^(from\s+\w+\s+)?import\s+/,
        export: /$/,
    },
};

function getPatternsForFile(filePath: string): LanguagePatterns {
    const ext = path.extname(filePath).toLowerCase();
    if (['.ts', '.tsx'].includes(ext)) return PATTERNS.typescript;
    if (['.js', '.jsx', '.mjs'].includes(ext)) return PATTERNS.javascript;
    if (['.py'].includes(ext)) return PATTERNS.python;
    return PATTERNS.typescript;
}

ToolRegistry.register({
    name: "get_file_outline",
    category: ToolCategory.FILE,
    description:
        "Get a table of contents for a file showing imports, exports, functions, classes, and types. Set include_stats=true for quick symbol counts (replaces a separate context scan). Use before read_file to scope large files.",
    cost: 1,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true,
    parameters: createParameters(
        {
            path: stringParam("Path to the file (relative to workspace)"),
            include_stats: booleanParam(
                "When true, append symbol counts (imports, exports, classes, functions, etc.) to the outline.",
            ),
        },
        ["path"]
    ),
    handler: async ({ path: filePath, include_stats = false, workspace }) => {
        try {
            if (!workspace) {
                throw new Error("No workspace provided");
            }

            const normalizedPath = filePath
                .replace(/^\/workspace\//, '')
                .replace(/^workspace\//, '')
                .replace(/^\/+/, '');

            assertReadablePath(normalizedPath, workspace);
            const fullPath = resolvePathUnderWorkspace(workspace, normalizedPath);

            try {
                const { ensureSymbolIndex, getSymbolsForFile } = await import("@/lib/index/ctags-index");
                const index = await ensureSymbolIndex(workspace);
                const syms = getSymbolsForFile(index, normalizedPath);
                if (syms.length > 0) {
                    const isKind = (s: { kind: string }, ...letters: string[]) =>
                        letters.some((l) => s.kind.toLowerCase() === l.toLowerCase());

                    const imports = syms.filter((s) => isKind(s, "i", "I", "p", "import"));
                    const classes = syms.filter((s) => isKind(s, "c", "class"));
                    const interfaces = syms.filter((s) => isKind(s, "i", "interface"));
                    const types = syms.filter((s) => isKind(s, "t", "type", "T"));
                    const functions = syms.filter((s) =>
                        isKind(s, "f", "function", "m", "method", "F"),
                    );

                    let lineCount = 0;
                    try {
                        const raw = await fs.promises.readFile(fullPath, "utf-8");
                        lineCount = raw.split("\n").length;
                    } catch {
                        lineCount = syms[syms.length - 1]?.line ?? 0;
                    }

                    let output = `📄 **File Outline: ${normalizedPath}** (ctags)\n`;
                    output += `**Total lines:** ${lineCount}\n\n`;

                    if (include_stats) {
                        output += `**Counts:** symbols ${syms.length}, classes ${classes.length}, interfaces ${interfaces.length}, types ${types.length}, functions ${functions.length}\n\n`;
                    }

                    if (classes.length > 0) {
                        output += `**🏛️ Classes (${classes.length}):**\n`;
                        classes.forEach((c) => {
                            output += `  - \`${c.name}\` (line ${c.line})${c.signature ? `: ${c.signature.slice(0, 60)}` : ""}\n`;
                        });
                        output += "\n";
                    }

                    if (interfaces.length > 0) {
                        output += `**📋 Interfaces (${interfaces.length}):**\n`;
                        interfaces.forEach((i) => {
                            output += `  - \`${i.name}\` (line ${i.line})\n`;
                        });
                        output += "\n";
                    }

                    if (types.length > 0) {
                        output += `**🔷 Types (${types.length}):**\n`;
                        types.forEach((t) => {
                            output += `  - \`${t.name}\` (line ${t.line})\n`;
                        });
                        output += "\n";
                    }

                    if (functions.length > 0) {
                        output += `**⚡ Functions (${functions.length}):**\n`;
                        functions.forEach((f) => {
                            output += `  - \`${f.name}\` (line ${f.line})${f.signature ? `: ${f.signature.slice(0, 60)}` : ""}\n`;
                        });
                        output += "\n";
                    }

                    const tipLine = functions[0]?.line ?? classes[0]?.line ?? 1;
                    output += `\n💡 **Tip:** Use \`read_file\` with \`start_line\`/\`end_line\` (e.g. start at line ${tipLine}) to read a specific symbol's body.`;
                    return output;
                }
            } catch {
                /* fall through to regex outline */
            }

            const content = await fs.promises.readFile(fullPath, "utf-8");
            const lines = content.split('\n');
            const patterns = getPatternsForFile(fullPath);

            const imports: string[] = [];
            const exports: string[] = [];
            const functions: { name: string; line: number; signature: string }[] = [];
            const classes: { name: string; line: number }[] = [];
            const interfaces: { name: string; line: number }[] = [];
            const types: { name: string; line: number }[] = [];

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const trimmed = line.trim();

                if (i < 30 && patterns.import.test(trimmed)) {
                    imports.push(trimmed.slice(0, 80));
                    continue;
                }

                if (patterns.export.test(trimmed) && !trimmed.includes('import')) {
                    exports.push(`Line ${i + 1}: ${trimmed.slice(0, 60)}`);
                }

                const classMatch = trimmed.match(patterns.class);
                if (classMatch) {
                    classes.push({
                        name: classMatch[2] || classMatch[1],
                        line: i + 1,
                    });
                    continue;
                }

                const interfaceMatch = trimmed.match(patterns.interface);
                if (interfaceMatch) {
                    interfaces.push({
                        name: interfaceMatch[2] || interfaceMatch[1],
                        line: i + 1,
                    });
                    continue;
                }

                const typeMatch = trimmed.match(patterns.type);
                if (typeMatch) {
                    types.push({
                        name: typeMatch[2] || typeMatch[1],
                        line: i + 1,
                    });
                    continue;
                }

                const funcMatch = trimmed.match(patterns.function);
                if (funcMatch) {
                    functions.push({
                        name: funcMatch[3] || funcMatch[2] || funcMatch[1],
                        line: i + 1,
                        signature: trimmed.slice(0, 80),
                    });
                    continue;
                }

                const arrowMatch = trimmed.match(/^(export\s+)?(const|let)\s+(\w+)\s*=\s*(async\s+)?\(/);
                if (arrowMatch) {
                    functions.push({
                        name: arrowMatch[3],
                        line: i + 1,
                        signature: trimmed.slice(0, 80),
                    });
                }
            }

            let output = `📄 **File Outline: ${normalizedPath}**\n`;
            output += `**Total lines:** ${lines.length}\n\n`;

            if (include_stats) {
                output += `**Counts:** imports ${imports.length}, exports ${exports.length}, classes ${classes.length}, interfaces ${interfaces.length}, types ${types.length}, functions ${functions.length}\n\n`;
            }

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

            output += `\n💡 **Tip:** Use \`read_file\` with \`start_line\`/\`end_line\` (e.g. start at line ${functions[0]?.line || classes[0]?.line || 1}) to read a specific symbol's body.`;

            return output;

        } catch (error) {
            throw new Error(`Failed to get file outline: ${error}`);
        }
    },
});

// ═══════════════════════════════════════════════════════════
// PROJECT STRUCTURE (FRAMEWORK DETECTION)
// ═══════════════════════════════════════════════════════════

interface FrameworkInfo {
    name: string;
    confidence: 'high' | 'medium' | 'low';
    indicators: string[];
}

function detectFramework(workspacePath: string, files: string[]): FrameworkInfo {
    const hasFile = (name: string) => files.some(f => f === name || f.endsWith('/' + name));
    const hasDir = (name: string) => files.some(f => f.startsWith(name + '/'));

    const indicators: string[] = [];

    if (hasFile('next.config.js') || hasFile('next.config.mjs') || hasFile('next.config.ts')) {
        indicators.push('next.config found');
        if (hasDir('app') || hasDir('pages')) {
            indicators.push('app/pages directory');
            return { name: 'Next.js', confidence: 'high', indicators };
        }
        return { name: 'Next.js', confidence: 'medium', indicators };
    }

    if (hasFile('vite.config.ts') || hasFile('vite.config.js')) {
        indicators.push('vite.config found');
        if (files.some(f => f.endsWith('.tsx') || f.endsWith('.jsx'))) {
            indicators.push('React components (.tsx/.jsx)');
            return { name: 'React (Vite)', confidence: 'high', indicators };
        }
        return { name: 'Vite', confidence: 'medium', indicators };
    }

    if (hasDir('src') && (hasFile('src/App.tsx') || hasFile('src/App.jsx') || hasFile('src/App.js'))) {
        indicators.push('src/App component');
        return { name: 'React', confidence: 'high', indicators };
    }

    if (hasFile('vue.config.js') || files.some(f => f.endsWith('.vue'))) {
        indicators.push('.vue files found');
        return { name: 'Vue.js', confidence: 'high', indicators };
    }

    if (hasFile('angular.json')) {
        indicators.push('angular.json found');
        return { name: 'Angular', confidence: 'high', indicators };
    }

    if (hasFile('server.js') || hasFile('server.ts') || hasFile('app.js') || hasFile('app.ts')) {
        indicators.push('server/app entry point');
        if (hasDir('routes') || hasDir('controllers')) {
            indicators.push('routes/controllers directory');
            return { name: 'Express.js', confidence: 'high', indicators };
        }
        return { name: 'Node.js Backend', confidence: 'medium', indicators };
    }

    if (hasFile('requirements.txt') || hasFile('pyproject.toml') || hasFile('setup.py')) {
        indicators.push('Python package files');
        if (hasFile('manage.py')) {
            return { name: 'Django', confidence: 'high', indicators };
        }
        if (hasFile('app.py') || hasFile('main.py')) {
            if (files.some(f => f.includes('flask'))) {
                return { name: 'Flask', confidence: 'medium', indicators };
            }
            if (files.some(f => f.includes('fastapi'))) {
                return { name: 'FastAPI', confidence: 'medium', indicators };
            }
        }
        return { name: 'Python', confidence: 'medium', indicators };
    }

    if (hasFile('electron.vite.config.ts') || hasFile('forge.config.ts')) {
        indicators.push('Electron config found');
        return { name: 'Electron', confidence: 'high', indicators };
    }

    if (hasFile('package.json')) {
        indicators.push('package.json found');
        return { name: 'Node.js', confidence: 'low', indicators };
    }

    if (hasFile('Cargo.toml')) {
        indicators.push('Cargo.toml found');
        return { name: 'Rust', confidence: 'high', indicators };
    }

    if (hasFile('go.mod')) {
        indicators.push('go.mod found');
        return { name: 'Go', confidence: 'high', indicators };
    }

    return { name: 'Unknown', confidence: 'low', indicators: [] };
}

ToolRegistry.register({
    name: "get_project_structure",
    category: ToolCategory.FILE,
    description:
        "Project overview with framework detection and file-type stats. For cold-session layout and README excerpt without parsing, prefer get_repo_overview first.",
    cost: 1,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true,
    parameters: createParameters(
        {
            max_depth: {
                type: "number",
                description: "Maximum depth to scan (default: 3, max: 5)",
            },
            include_counts: {
                type: "boolean",
                description: "Include file counts per folder (default: true)",
            },
        },
        []
    ),
    handler: async ({ max_depth = 3, include_counts = true, workspace }) => {
        try {
            if (!workspace) {
                throw new Error("No workspace path provided");
            }
            const maxDepth = Math.min(max_depth, 5);

            const files = await glob("**/*", {
                cwd: workspace,
                ignore: ["node_modules/**", ".git/**", "dist/**", "build/**", ".next/**", "venv/**", "__pycache__/**", "*.lock"],
                dot: false,
                maxDepth: maxDepth,
            });

            const framework = detectFramework(workspace, files);

            const extCounts: Record<string, number> = {};
            files.forEach(f => {
                const ext = path.extname(f).toLowerCase() || '(no ext)';
                extCounts[ext] = (extCounts[ext] || 0) + 1;
            });

            const folderCounts: Record<string, number> = {};
            files.forEach(f => {
                const parts = f.split('/');
                if (parts.length > 1) {
                    folderCounts[parts[0]] = (folderCounts[parts[0]] || 0) + 1;
                }
            });

            const keyFiles = files.filter(f =>
                /^(package\.json|tsconfig.*|vite\.config|next\.config|\.env|README|Dockerfile)/i.test(path.basename(f))
            ).slice(0, 10);

            const entryPoints = files.filter(f =>
                /(^|\/)?(main|index|app|server)\.(ts|tsx|js|jsx|py)$/i.test(f)
            ).slice(0, 5);

            let output = `# Project Overview\n\n`;
            output += `**Framework:** ${framework.name} (${framework.confidence} confidence)\n`;
            if (framework.indicators.length > 0) {
                output += `**Detected via:** ${framework.indicators.join(', ')}\n`;
            }
            output += `**Total Files:** ${files.length}\n\n`;

            output += `## Main Folders\n`;
            const sortedFolders = Object.entries(folderCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10);

            sortedFolders.forEach(([folder, count]) => {
                output += include_counts
                    ? `- 📁 ${folder}/ (${count} files)\n`
                    : `- 📁 ${folder}/\n`;
            });

            if (entryPoints.length > 0) {
                output += `\n## Entry Points\n`;
                entryPoints.forEach(f => output += `- ${f}\n`);
            }

            if (keyFiles.length > 0) {
                output += `\n## Config Files\n`;
                keyFiles.forEach(f => output += `- ${f}\n`);
            }

            output += `\n## File Types\n`;
            const sortedExts = Object.entries(extCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8);
            sortedExts.forEach(([ext, count]) => {
                output += `- ${ext}: ${count} files\n`;
            });

            output += `\n---\n💡 **Next Steps:**\n`;
            output += `- Use \`search\` with mode semantic or text to find code and features\n`;
            output += `- Use \`read_file\` to view specific files\n`;

            return output;
        } catch (error) {
            throw new Error(`Failed to get project structure: ${error}`);
        }
    },
});

// ═══════════════════════════════════════════════════════════
// RENAME FILE
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "rename_file",
    category: ToolCategory.FILE_ADVANCED,
    description: "Rename or move a file/directory",
    isReadOnly: false,
    parameters: {
        old_path: {
            type: "string",
            description: "Current file path",
            required: true,
        },
        new_path: {
            type: "string",
            description: "New file path",
            required: true,
        },
    },
    cost: 3,
    requiresWorkspace: true,
    isCore: true,
    handler: async (params: { old_path: string; new_path: string }) => {
        try {
            const newDir = path.dirname(params.new_path);
            await fsp.mkdir(newDir, { recursive: true });

            await fsp.rename(params.old_path, params.new_path);

            return {
                success: true,
                old_path: params.old_path,
                new_path: params.new_path,
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    },
});

// ═══════════════════════════════════════════════════════════
// DELETE FILE
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "delete_file",
    category: ToolCategory.FILE_ADVANCED,
    description: "Delete a file or directory (requires confirmation)",
    isReadOnly: false,
    parameters: {
        filepath: {
            type: "string",
            description: "Path to file/directory to delete",
            required: true,
        },
        recursive: {
            type: "boolean",
            description: "Delete directory recursively",
            required: false,
            default: false,
        },
    },
    cost: 5,
    handler: async (params: { filepath: string; recursive?: boolean }) => {
        try {
            const stats = await fsp.stat(params.filepath);

            if (stats.isDirectory()) {
                if (!params.recursive) {
                    return {
                        success: false,
                        error: "Cannot delete directory without recursive flag",
                    };
                }
                await fsp.rm(params.filepath, { recursive: true });
            } else {
                await fsp.unlink(params.filepath);
            }

            return {
                success: true,
                filepath: params.filepath,
                type: stats.isDirectory() ? "directory" : "file",
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    },
});

// ═══════════════════════════════════════════════════════════
// CREATE DIRECTORY
// ═══════════════════════════════════════════════════════════

function looksLikeAbsolutePathFragment(dirpath: string): boolean {
    const normalized = dirpath.replace(/^\/+/, "").replace(/\\/g, "/");
    return (
        normalized.startsWith("Users/") ||
        normalized.startsWith("home/") ||
        /^[A-Za-z]:[/\\]/.test(dirpath)
    );
}

ToolRegistry.register({
    name: "create_directory",
    category: ToolCategory.FILE_ADVANCED,
    description: "Create a new directory (path is relative to workspace root). Use paths like 'src/components', not absolute paths.",
    parameters: {
        dirpath: {
            type: "string",
            description: "Path to directory to create (relative to workspace, e.g. 'src/components/forms')",
            required: true,
        },
    },
    cost: 2,
    requiresWorkspace: true,
    handler: async (params: { dirpath: string; workspace?: string }) => {
        try {
            const dirpath = params.dirpath
                .replace(/^\/workspace\//, "")
                .replace(/^workspace\//, "")
                .replace(/^\/+/, "");

            if (looksLikeAbsolutePathFragment(dirpath)) {
                return {
                    success: false,
                    error: `Invalid path: "${params.dirpath}" looks like an absolute path. Use a path relative to the workspace root (e.g. "src/components").`,
                };
            }

            let fullPath: string;
            if (params.workspace) {
                fullPath = safeJoin(params.workspace, dirpath);
            } else {
                if (!path.isAbsolute(params.dirpath)) {
                    return {
                        success: false,
                        error: "No workspace context. Provide an absolute path or ensure a workspace is active.",
                    };
                }
                fullPath = path.resolve(params.dirpath);
            }

            await fsp.mkdir(fullPath, { recursive: true });

            return {
                success: true,
                dirpath: dirpath,
                fullPath,
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    },
});

// ═══════════════════════════════════════════════════════════
// GET FILE INFO
// ═══════════════════════════════════════════════════════════

function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

ToolRegistry.register({
    name: "get_file_info",
    category: ToolCategory.FILE_ADVANCED,
    description: "Get metadata about a file (size, modified date, permissions)",
    isReadOnly: true,
    parameters: {
        filepath: {
            type: "string",
            description: "Path to file",
            required: true,
        },
    },
    cost: 1,
    handler: async (params: { filepath: string }) => {
        try {
            const stats = await fsp.stat(params.filepath);

            return {
                success: true,
                filepath: params.filepath,
                size_bytes: stats.size,
                size_human: formatBytes(stats.size),
                created: stats.birthtime.toISOString(),
                modified: stats.mtime.toISOString(),
                accessed: stats.atime.toISOString(),
                is_directory: stats.isDirectory(),
                is_file: stats.isFile(),
                permissions: stats.mode.toString(8),
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    },
});

// ═══════════════════════════════════════════════════════════
// HELPER: BUILD DIRECTORY TREE
// ═══════════════════════════════════════════════════════════

function buildTree(files: string[], indent: string = ""): string {
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
