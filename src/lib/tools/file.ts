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
import { recordFileRead, resolveReadScope } from "./file-read-log";
import { truncateUtf8ByBytes } from "@/lib/truncate";
import * as path from "path";


import {
    ToolRegistry,
    createParameters,
    stringParam,
    numberParam,
} from "./registry";

import {
    resolvePathUnderWorkspace,
    resolveToolTargetPath,
    safeRelativePathUnderWorkspace,
    stripToolPathPrefixes,
} from "../../ipc/utils/safeWorkspaceRelativePath";

import { assertReadablePath } from "@/lib/security/env-secret-paths";
import { assertRealpathContained } from "@/lib/security/realpath-contain";
import {
    enrichReadFileStructuredError,
    logReadFileError,
    logReadFileUnexpected,
    readFileStructuredError,
    type ReadFileStructuredError,
} from "./file-read-errors";
import { suggestClosestPath } from "./workspace-file-hints";
import { overlayContent } from "@/lib/agents/subagent-proposals";

const READ_FILE_DEFAULT_MAX_LINES = 2000;
const READ_FILE_MAX_LINES_CAP = 10_000;
// 50KB default page (opencode parity). read_file is exempt from the registry
// truncation envelope, so this cap directly bounds a single read; larger files
// are paged via offset/limit on the same path.
const READ_FILE_DEFAULT_MAX_BYTES = 50_000;
const READ_FILE_MAX_BYTES_CAP = 200_000;

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
                    `... [${lines.length - headLines - tailLines} lines omitted - use line_range for details] ...`,
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
    description:
        "Read file contents. Default ~2000 lines / 50KB per call; for larger files page with offset (1-based start line) + limit, repeating until the footer no longer says more lines remain. Use context or start_line/end_line to focus.",
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
            offset: {
                type: "number",
                description: "Page start line (1-indexed). With limit, reads one page; the footer says how to fetch the next page.",
            },
            limit: {
                type: "number",
                description: `Lines per page when using offset (default ${READ_FILE_DEFAULT_MAX_LINES}).`,
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
        offset,
        limit,
        workspace,
        _proposalSetId,
        // Scope for the read-before-edit record (see `file-read-log.ts`).
        _scopeSessionId,
        _scopeChatId,
        _chatSessionId,
    }) => {
        // opencode-style pagination: offset/limit map onto start/end lines.
        if (offset !== undefined && start_line === undefined) {
            const pageStart = Math.max(1, Number(offset) || 1);
            const pageLen = Math.max(
                1,
                Math.min(
                    READ_FILE_MAX_LINES_CAP,
                    Number(limit) || READ_FILE_DEFAULT_MAX_LINES,
                ),
            );
            start_line = pageStart;
            end_line = pageStart + pageLen - 1;
        }
        // Hoisted so the catch block can reference it for error reporting.
        let displayPath = "";
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

            const rawPath = String(filePath);
            const isAbsolutePath = path.isAbsolute(rawPath);

            let fullPath: string;
            if (isAbsolutePath) {
                // Explicit absolute target: reads are auto-allowed ANYWHERE. The
                // workspace is the default SCOPE, not a wall — the approval gate
                // governs WRITES, not reads. (Supersedes the narrower legacy
                // tool-output-spill allowance.) Symlinks are realpath'd inside
                // resolveToolTargetPath.
                const { absPath } = resolveToolTargetPath(
                    workspace || process.cwd(),
                    rawPath,
                );
                displayPath = absPath;
                fullPath = absPath;
            } else {
                try {
                    displayPath = workspace
                        ? safeRelativePathUnderWorkspace(filePath)
                        : stripToolPathPrefixes(filePath);
                } catch (normErr) {
                    const structured = readFileStructuredError(normErr, rawPath);
                    if (structured) {
                        logReadFileError(structured);
                        return structured;
                    }
                    throw normErr;
                }

                fullPath = workspace
                    ? resolvePathUnderWorkspace(workspace, filePath)
                    : path.resolve(stripToolPathPrefixes(filePath));

                try {
                    if (workspace) {
                        assertReadablePath(String(filePath), workspace);
                        // String checks are symlink-blind — reject a workspace
                        // symlink whose real target escapes the workspace.
                        assertRealpathContained(fullPath, workspace, [], String(filePath));
                    }
                } catch (pathErr) {
                    const structured = readFileStructuredError(pathErr, displayPath);
                    if (structured) {
                        logReadFileError(structured);
                        return structured;
                    }
                    throw pathErr;
                }
            }

            const capLines = Math.min(
                READ_FILE_MAX_LINES_CAP,
                Math.max(1, Number(max_lines) || READ_FILE_DEFAULT_MAX_LINES),
            );
            const capBytes = Math.min(
                READ_FILE_MAX_BYTES_CAP,
                Math.max(1024, Number(max_bytes) || READ_FILE_DEFAULT_MAX_BYTES),
            );

            // A writer sub-agent's edits are recorded as proposals, not written.
            // Serve its own proposed body back so it can re-read what it just
            // changed — and note a file it CREATED has nothing on disk to stat,
            // so this has to come before the stat, not after it.
            const proposedBody = overlayContent(_proposalSetId, fullPath);

            if (proposedBody === null) {
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
            }

            const content =
                proposedBody ?? (await fs.promises.readFile(fullPath, "utf-8"));
            // Remember what this read SERVED, so `edit_file` can refuse to work from a
            // stale view. The full file is hashed even for a paged/ranged read: the gate
            // asks "has the file changed since you looked?", not "did you see the region
            // you're editing" — a slice read followed by an edit elsewhere is fine as
            // long as nothing moved underneath. `proposedBody` is why the hash is of the
            // bytes returned rather than of disk: a writer sub-agent reads its own
            // overlay, and hashing disk would call every one of its edits stale.
            recordFileRead(
                resolveReadScope({
                    _proposalSetId,
                    _scopeSessionId,
                    _scopeChatId,
                    _chatSessionId,
                }),
                displayPath,
                content,
            );
            const lines = content.split("\n");

            if (start_line !== undefined && end_line !== undefined) {
                const startIdx = Math.max(0, start_line - 1);
                const endIdx = Math.min(lines.length, end_line);
                const selectedLines = lines.slice(startIdx, endIdx);

                const numberedLines = selectedLines
                    .map((line, idx) => `${startIdx + idx + 1}: ${line}`)
                    .join("\n");

                const remaining = lines.length - endIdx;
                const footer =
                    remaining > 0
                        ? `\n\n(truncated — ${remaining} more line(s); call again with offset=${endIdx + 1})`
                        : "";
                const block = `File: ${displayPath}\nLines: ${startIdx + 1}-${endIdx} of ${lines.length}\n\n${numberedLines}${footer}`;
                return truncateUtf8ByBytes(block, capBytes, { margin: 160, suffix: `\n\n… [truncated: exceeded max_bytes; page with offset/limit]` });
            }

            // Default read: LINEAR pagination, never middle-hiding (parity with
            // opencode + Claude Code; the head60/tail40 smartSlice hid the exact
            // range a model needed and drove re-read loops). The structural
            // `context` modes below are Atlarix's opt-in edge for navigating huge
            // files without dumping them.
            if (context === "full") {
                if (lines.length <= capLines) {
                    const numberedLines = lines
                        .map((line, idx) => `${idx + 1}: ${line}`)
                        .join("\n");
                    const block = `File: ${displayPath}\nLines: 1-${lines.length} (complete)\n\n${numberedLines}`;
                    return truncateUtf8ByBytes(block, capBytes, { margin: 120, suffix: "\n\n… [truncated: exceeded max_bytes; lower max_lines/max_bytes or use start_line/end_line]" });
                }
                // Over-cap: return the first page linearly + an offset footer (same
                // shape as the range path), so the model pages forward to the exact
                // lines it wants instead of getting head+tail with the middle gone.
                const pageLines = lines.slice(0, capLines);
                const numberedLines = pageLines
                    .map((line, idx) => `${idx + 1}: ${line}`)
                    .join("\n");
                const remaining = lines.length - capLines;
                const footer = `\n\n(truncated — ${remaining} more line(s); call again with offset=${capLines + 1} to page, or use context to navigate)`;
                const block = `File: ${displayPath}\nLines: 1-${capLines} of ${lines.length}\n\n${numberedLines}${footer}`;
                return truncateUtf8ByBytes(block, capBytes, { margin: 160, suffix: "\n\n… [truncated: exceeded max_bytes; page with offset/limit]" });
            }

            // Structural navigation modes (imports/exports/functions/classes/
            // types/errors) — opt-in only; these intentionally summarize.
            const sliced = smartSliceFile(lines, capLines, context as SliceContext);

            let result = `File: ${displayPath}\n`;
            result += `Total lines: ${lines.length} | Showing: ${sliced.linesShown} (${sliced.strategy})\n`;
            result +=
                "Tip: page the rest with offset (1-based start line) + limit, or use start_line/end_line for a specific range.\n\n";
            result += sliced.text;

            return truncateUtf8ByBytes(result, capBytes, { margin: 120, suffix: "\n\n… [truncated: exceeded max_bytes; lower max_lines/max_bytes or use start_line/end_line]" });
        } catch (error) {
            let structured = readFileStructuredError(error, displayPath);
            if (structured) {
                // On a missing path, offer the closest real file (rename/typo
                // recovery) so the model retries with the right path, not a
                // wasted probe. Backed by the cached workspace file list.
                if (structured.error === "file_not_found" && workspace) {
                    const suggestion = await suggestClosestPath(workspace, displayPath);
                    if (suggestion) {
                        structured = enrichReadFileStructuredError(structured, suggestion);
                    }
                }
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
// FILE WRITING
// ═══════════════════════════════════════════════════════════
// v13.8: write_file was merged into edit_file (operation:"write"). File
// creation/overwrite now lives in src/lib/tools/edit.ts so the model has one
// mutation tool. See edit.ts runWrite().
