/**
 * Atlarix Surgical Edit Tools
 * ===========================
 * Tools for precise code modifications without rewriting entire files.
 * All tools integrate with the permission system for user approval.
 * 
 * Tools:
 * - replace_code: Replace specific code snippet (find/replace)
 * - insert_code: Insert code at specific line
 * - delete_lines: Delete specific line range
 */

import * as fs from "fs";
import * as path from "path";
import {
    ToolRegistry,
    ToolCategory,
    createParameters,
    stringParam,
} from "./registry";

// ═══════════════════════════════════════════════════════════
// REPLACE CODE TOOL
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "replace_code",
    category: ToolCategory.FILE,
    description:
        `Replace a specific code snippet in a file. MUCH more efficient than write_file for small changes.
        
Use this when:
- Fixing a bug in one function
- Updating a variable value
- Changing an import statement
- Making any small, targeted change

The old_code must EXACTLY match (including whitespace). Use view_symbol or read_file first to get exact code.`,
    cost: 3,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: false,
    parameters: createParameters(
        {
            path: stringParam("Path to the file to edit (relative to workspace)"),
            old_code: stringParam("EXACT code snippet to find and replace. Must match exactly (including whitespace)."),
            new_code: stringParam("New code to replace the old code with."),
            description: stringParam("Brief description of what this change does."),
        },
        ["path", "old_code", "new_code", "description"]
    ),
    handler: async ({ path: filePath, old_code, new_code, description, workspace, chatMode }) => {
        // Check mode
        if (chatMode === "ask") {
            return {
                error: "Edit operations not allowed in Ask mode. Switch to Build mode.",
                operation: "replace_code",
                denied: true,
            };
        }

        // Normalize path
        const normalizedPath = filePath
            .replace(/^\/workspace\//, '')
            .replace(/^workspace\//, '')
            .replace(/^\/+/, '');

        const fullPath = workspace
            ? path.join(workspace, normalizedPath)
            : path.resolve(normalizedPath);

        // Read current content
        let content: string;
        try {
            content = await fs.promises.readFile(fullPath, "utf-8");
        } catch {
            return {
                error: `File not found: ${normalizedPath}`,
                operation: "replace_code",
            };
        }

        // Check if old_code exists
        if (!content.includes(old_code)) {
            // Try to help by finding similar content
            const lines = content.split('\n');
            const firstLineOfOld = old_code.split('\n')[0].trim();
            const similarLine = lines.findIndex(l => l.includes(firstLineOfOld.slice(0, 30)));

            let hint = "";
            if (similarLine !== -1) {
                hint = `\n\nSimilar code found at line ${similarLine + 1}. Use read_file with start_line=${Math.max(1, similarLine - 2)}, end_line=${similarLine + 5} to see exact content.`;
            }

            return {
                error: `Code to replace not found in ${normalizedPath}. Make sure the old_code matches EXACTLY (including whitespace).${hint}`,
                operation: "replace_code",
            };
        }

        // Check for multiple occurrences
        const occurrences = content.split(old_code).length - 1;
        if (occurrences > 1) {
            return {
                error: `Found ${occurrences} occurrences of the code. Please provide more context to make the match unique, or use line numbers.`,
                operation: "replace_code",
            };
        }

        // Return permission request with preview
        const newContent = content.replace(old_code, new_code);
        const oldLines = old_code.split('\n').length;
        const newLines = new_code.split('\n').length;

        return {
            __permission_required: true,
            operation: "replace_code",
            preview: {
                path: normalizedPath,
                content: newContent,
                description: description,
                type: "update" as const,
                lines: newContent.split('\n').length,
                diff: {
                    removed: oldLines,
                    added: newLines,
                    old_snippet: old_code.slice(0, 200) + (old_code.length > 200 ? '...' : ''),
                    new_snippet: new_code.slice(0, 200) + (new_code.length > 200 ? '...' : ''),
                },
            },
            reasoning: `Surgical edit in ${normalizedPath}: ${description} (replacing ${oldLines} lines with ${newLines} lines)`,
        };
    },
});

// ═══════════════════════════════════════════════════════════
// INSERT CODE TOOL
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "insert_code",
    category: ToolCategory.FILE,
    description:
        `Insert code at a specific line in a file. Use for adding new functions, imports, or code blocks.
        
Use this when:
- Adding a new import at the top
- Adding a new function to a file
- Inserting code between existing blocks`,
    cost: 3,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: false,
    parameters: createParameters(
        {
            path: stringParam("Path to the file to edit (relative to workspace)"),
            line: {
                type: "number",
                description: "Line number to insert AFTER (1-indexed). Use 0 to insert at the very beginning.",
            },
            code: stringParam("Code to insert."),
            description: stringParam("Brief description of what this insertion does."),
        },
        ["path", "line", "code", "description"]
    ),
    handler: async ({ path: filePath, line, code, description, workspace, chatMode }) => {
        if (chatMode === "ask") {
            return {
                error: "Edit operations not allowed in Ask mode. Switch to Build mode.",
                operation: "insert_code",
                denied: true,
            };
        }

        const normalizedPath = filePath
            .replace(/^\/workspace\//, '')
            .replace(/^workspace\//, '')
            .replace(/^\/+/, '');

        const fullPath = workspace
            ? path.join(workspace, normalizedPath)
            : path.resolve(normalizedPath);

        let content: string;
        try {
            content = await fs.promises.readFile(fullPath, "utf-8");
        } catch {
            return {
                error: `File not found: ${normalizedPath}`,
                operation: "insert_code",
            };
        }

        const lines = content.split('\n');

        // Validate line number
        if (line < 0 || line > lines.length) {
            return {
                error: `Invalid line number: ${line}. File has ${lines.length} lines. Use 0 for beginning or ${lines.length} for end.`,
                operation: "insert_code",
            };
        }

        // Insert the code
        const codeLines = code.split('\n');
        const newLines = [
            ...lines.slice(0, line),
            ...codeLines,
            ...lines.slice(line),
        ];
        const newContent = newLines.join('\n');

        return {
            __permission_required: true,
            operation: "insert_code",
            preview: {
                path: normalizedPath,
                content: newContent,
                description: description,
                type: "update" as const,
                lines: newLines.length,
                diff: {
                    inserted_at: line,
                    lines_added: codeLines.length,
                    snippet: code.slice(0, 200) + (code.length > 200 ? '...' : ''),
                },
            },
            reasoning: `Insert ${codeLines.length} lines at line ${line} in ${normalizedPath}: ${description}`,
        };
    },
});

// ═══════════════════════════════════════════════════════════
// DELETE LINES TOOL
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "delete_lines",
    category: ToolCategory.FILE,
    description:
        `Delete specific lines from a file. Use for removing code blocks, unused imports, or deprecated code.`,
    cost: 3,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: false,
    parameters: createParameters(
        {
            path: stringParam("Path to the file to edit (relative to workspace)"),
            start_line: {
                type: "number",
                description: "First line to delete (1-indexed, inclusive).",
            },
            end_line: {
                type: "number",
                description: "Last line to delete (1-indexed, inclusive).",
            },
            description: stringParam("Brief description of what is being removed."),
        },
        ["path", "start_line", "end_line", "description"]
    ),
    handler: async ({ path: filePath, start_line, end_line, description, workspace, chatMode }) => {
        if (chatMode === "ask") {
            return {
                error: "Edit operations not allowed in Ask mode. Switch to Build mode.",
                operation: "delete_lines",
                denied: true,
            };
        }

        const normalizedPath = filePath
            .replace(/^\/workspace\//, '')
            .replace(/^workspace\//, '')
            .replace(/^\/+/, '');

        const fullPath = workspace
            ? path.join(workspace, normalizedPath)
            : path.resolve(normalizedPath);

        let content: string;
        try {
            content = await fs.promises.readFile(fullPath, "utf-8");
        } catch {
            return {
                error: `File not found: ${normalizedPath}`,
                operation: "delete_lines",
            };
        }

        const lines = content.split('\n');

        // Validate line range
        if (start_line < 1 || end_line > lines.length || start_line > end_line) {
            return {
                error: `Invalid line range: ${start_line}-${end_line}. File has ${lines.length} lines.`,
                operation: "delete_lines",
            };
        }

        // Preview what will be deleted
        const deletedLines = lines.slice(start_line - 1, end_line);
        const deletedContent = deletedLines.join('\n');

        // Create new content
        const newLines = [
            ...lines.slice(0, start_line - 1),
            ...lines.slice(end_line),
        ];
        const newContent = newLines.join('\n');

        return {
            __permission_required: true,
            operation: "delete_lines",
            preview: {
                path: normalizedPath,
                content: newContent,
                description: description,
                type: "update" as const,
                lines: newLines.length,
                diff: {
                    deleted_range: `${start_line}-${end_line}`,
                    lines_removed: deletedLines.length,
                    deleted_snippet: deletedContent.slice(0, 200) + (deletedContent.length > 200 ? '...' : ''),
                },
            },
            reasoning: `Delete lines ${start_line}-${end_line} from ${normalizedPath}: ${description}`,
        };
    },
});
