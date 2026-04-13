/**
 * Advanced File Operation Tools
 * ============================
 * Surgical file editing, renaming, deletion, and metadata operations
 */

import { ToolRegistry, ToolCategory } from "./registry";
import fs from "fs/promises";
import path from "path";
import { safeJoin } from "../../ipc/utils/path_utils";

// ============================================
// EDIT FILE SECTION
// ============================================

/**
 * Edit a specific function or class in a file
 * Uses AST parsing to find and replace sections
 */
ToolRegistry.register({
    name: "edit_file_section",
    category: ToolCategory.FILE_ADVANCED,
    description: "Edit a specific function, class, or code section in a file",
    isReadOnly: false,
    requiresWorkspace: true,
    parameters: {
        filepath: {
            type: "string",
            description: "Path to the file to edit",
            required: true,
        },
        section_identifier: {
            type: "string",
            description: "Function/class/variable name to find and edit",
            required: true,
        },
        new_content: {
            type: "string",
            description: "New code to replace the section with",
            required: true,
        },
        description: {
            type: "string",
            description: "What this edit accomplishes",
            required: true,
        },
    },
    cost: 5,
    handler: async (params: {
        filepath: string;
        section_identifier: string;
        new_content: string;
        description: string;
        workspace?: string;
        chatMode?: string;
    }) => {
        if (params.chatMode === "ask") {
            return {
                error: "Edit operations not allowed in Ask mode. Switch to Build mode.",
                operation: "write_file",
                denied: true,
            };
        }

        const rawPath = params.filepath
            .replace(/^\/workspace\//, "")
            .replace(/^workspace\//, "")
            .replace(/^\/+/, "");
        const normalizedPath = rawPath.split(path.sep).join("/");

        if (params.chatMode === "plan") {
            const norm = normalizedPath.replace(/\\/g, "/");
            const planOk = /(^|\/)\.atlarix\/ATLARIX_PLAN\.md$/.test(norm);
            const memoryOk = /(^|\/)\.atlarix\/ATLARIX\.md$/i.test(norm);
            if (!planOk && !memoryOk) {
                return {
                    error:
                        "Plan mode may only edit .atlarix/ATLARIX_PLAN.md or .atlarix/ATLARIX.md. Switch to Build for application code.",
                    operation: "write_file",
                    denied: true,
                };
            }
        }

        if (!params.workspace) {
            return {
                success: false,
                error: "Workspace required for edit_file_section",
            };
        }

        const fullPath = path.join(params.workspace, normalizedPath);

        let content: string;
        try {
            content = await fs.readFile(fullPath, "utf-8");
        } catch {
            return {
                success: false,
                error: `File not found: ${normalizedPath}`,
            };
        }

        const lines = content.split("\n");
        const escapedId = params.section_identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const patterns = [
            new RegExp(`function\\s+${escapedId}\\s*\\(`),
            new RegExp(`const\\s+${escapedId}\\s*=`),
            new RegExp(`class\\s+${escapedId}\\s*{`),
            new RegExp(`export\\s+function\\s+${escapedId}\\s*\\(`),
        ];

        let startLine = -1;
        let endLine = -1;

        for (let i = 0; i < lines.length; i++) {
            if (patterns.some((p) => p.test(lines[i]))) {
                startLine = i;
                let braceCount = 0;
                let inSection = false;
                for (let j = i; j < lines.length; j++) {
                    const line = lines[j];
                    for (const char of line) {
                        if (char === "{") {
                            braceCount++;
                            inSection = true;
                        } else if (char === "}") {
                            braceCount--;
                        }
                    }
                    if (inSection && braceCount === 0) {
                        endLine = j;
                        break;
                    }
                }
                break;
            }
        }

        if (startLine === -1) {
            return {
                success: false,
                error: `Section "${params.section_identifier}" not found in ${normalizedPath}`,
            };
        }

        const before = lines.slice(0, startLine);
        const after = lines.slice(endLine + 1);
        const newLines = [...before, params.new_content, ...after];
        const newContent = newLines.join("\n");

        return {
            __permission_required: true,
            operation: "write_file",
            preview: {
                path: normalizedPath,
                content: newContent,
                oldContent: content,
                description: params.description,
                type: "update" as const,
                lines: newContent.split("\n").length,
            },
            reasoning: `Section edit (${params.section_identifier}) in ${normalizedPath}: ${params.description}`,
        };
    },
});

// ============================================
// APPLY CHANGES (BATCH REFACTORING)
// ============================================

interface FileChange {
    filepath: string;
    old_content: string;
    new_content: string;
}

ToolRegistry.register({
    name: "apply_changes",
    category: ToolCategory.FILE_ADVANCED,
    description: "Apply a set of refactoring changes to multiple files",
    parameters: {
        changes: {
            type: "array",
            description: "Array of {filepath, old_content, new_content} changes",
            required: true,
        },
        description: {
            type: "string",
            description: "What these changes accomplish",
            required: true,
        },
    },
    cost: 10,
    requiresWorkspace: true,
    isCore: false, // Optional - batch refactoring
    handler: async (params: { changes: FileChange[]; description: string }) => {
        try {
            const results = [];

            for (const change of params.changes) {
                const content = await fs.readFile(change.filepath, "utf-8");

                // Replace old content with new content
                const newContent = content.replace(
                    change.old_content,
                    change.new_content
                );

                if (content === newContent) {
                    results.push({
                        filepath: change.filepath,
                        success: false,
                        error: "Pattern not found or already applied",
                    });
                } else {
                    await fs.writeFile(change.filepath, newContent, "utf-8");
                    results.push({
                        filepath: change.filepath,
                        success: true,
                    });
                }
            }

            const successCount = results.filter(r => r.success).length;

            return {
                success: successCount > 0,
                total_changes: params.changes.length,
                successful: successCount,
                failed: results.length - successCount,
                results,
                description: params.description,
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
// RENAME FILE
// ============================================

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
    isCore: true, // Core file operation
    handler: async (params: { old_path: string; new_path: string }) => {
        try {
            // Create parent directory if it doesn't exist
            const newDir = path.dirname(params.new_path);
            await fs.mkdir(newDir, { recursive: true });

            // Rename/move the file
            await fs.rename(params.old_path, params.new_path);

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

// ============================================
// DELETE FILE
// ============================================

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
            const stats = await fs.stat(params.filepath);

            if (stats.isDirectory()) {
                if (!params.recursive) {
                    return {
                        success: false,
                        error: "Cannot delete directory without recursive flag",
                    };
                }
                await fs.rm(params.filepath, { recursive: true });
            } else {
                await fs.unlink(params.filepath);
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

// ============================================
// CREATE DIRECTORY
// ============================================

/**
 * Reject paths that look like absolute paths mistakenly passed as relative
 * (e.g. "Users/amariah/Documents/..." which would create nested structure).
 */
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

            await fs.mkdir(fullPath, { recursive: true });

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

// ============================================
// GET FILE INFO
// ============================================

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
            const stats = await fs.stat(params.filepath);

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

// ============================================
// HELPER FUNCTIONS
// ============================================

function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}
