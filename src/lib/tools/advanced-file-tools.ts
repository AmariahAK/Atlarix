/**
 * Advanced File Operation Tools
 * ============================
 * Surgical file editing, renaming, deletion, and metadata operations
 */

import { ToolRegistry, ToolCategory } from "./registry";
import fs from "fs/promises";
import path from "path";

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
    }) => {
        try {
            // Read the file
            const content = await fs.readFile(params.filepath, "utf-8");
            const lines = content.split("\n");

            // Simple pattern matching for now (can be enhanced with AST later)
            // Look for function/class declarations
            const patterns = [
                new RegExp(`function\\s+${params.section_identifier}\\s*\\(`),
                new RegExp(`const\\s+${params.section_identifier}\\s*=`),
                new RegExp(`class\\s+${params.section_identifier}\\s*{`),
                new RegExp(`export\\s+function\\s+${params.section_identifier}\\s*\\(`),
            ];

            let startLine = -1;
            let endLine = -1;

            // Find the section
            for (let i = 0; i < lines.length; i++) {
                if (patterns.some(p => p.test(lines[i]))) {
                    startLine = i;

                    // Find the end (simple brace counting)
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
                    error: `Section "${params.section_identifier}" not found in ${params.filepath}`,
                };
            }

            // Replace the section
            const before = lines.slice(0, startLine);
            const after = lines.slice(endLine + 1);
            const newLines = [...before, params.new_content, ...after];

            // Write back (this will trigger permission system)
            const newContent = newLines.join("\n");
            await fs.writeFile(params.filepath, newContent, "utf-8");

            return {
                success: true,
                filepath: params.filepath,
                section: params.section_identifier,
                lines_modified: endLine - startLine + 1,
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

ToolRegistry.register({
    name: "create_directory",
    category: ToolCategory.FILE_ADVANCED,
    description: "Create a new directory (creates parent directories if needed)",
    parameters: {
        dirpath: {
            type: "string",
            description: "Path to directory to create",
            required: true,
        },
    },
    cost: 2,
    handler: async (params: { dirpath: string }) => {
        try {
            await fs.mkdir(params.dirpath, { recursive: true });

            return {
                success: true,
                dirpath: params.dirpath,
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
