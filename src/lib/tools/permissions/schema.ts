/**
 * Permission Schema
 * =================
 * Zod schemas for structured JSON permission requests.
 * Used by write tools to request user approval before file operations.
 */

import { z } from "zod";

// ════════════════════════════════════════════════════════════════════════════
// FILE OPERATION PREVIEW
// ════════════════════════════════════════════════════════════════════════════

export const FileOperationPreviewSchema = z.object({
    path: z.string().describe("File path relative to workspace"),
    content: z.string().optional().describe("File content for create/update"),
    oldContent: z.string().optional().describe("Original content for edits"),
    description: z.string().describe("What this operation does"),
    type: z.enum(["create", "update", "delete", "rename"]),
    lines: z.number().optional().describe("Number of lines in content"),
    diff: z.string().optional().describe("Unified diff format"),
    // For rename operations
    fromPath: z.string().optional().describe("Original path (for rename)"),
    toPath: z.string().optional().describe("New path (for rename)"),
});

export type FileOperationPreview = z.infer<typeof FileOperationPreviewSchema>;

// ════════════════════════════════════════════════════════════════════════════
// COMMAND OPERATION PREVIEW
// ════════════════════════════════════════════════════════════════════════════

export const CommandOperationPreviewSchema = z.object({
    command: z.string().describe("Command to execute"),
    workingDirectory: z.string().optional().describe("Working directory"),
    description: z.string().describe("What this command does"),
    isDangerous: z.boolean().optional().describe("Whether command is risky"),
});

export type CommandOperationPreview = z.infer<typeof CommandOperationPreviewSchema>;

// ════════════════════════════════════════════════════════════════════════════
// PERMISSION METADATA
// ════════════════════════════════════════════════════════════════════════════

export const PermissionMetadataSchema = z.object({
    reasoning: z.string().optional().describe("Why this change is needed"),
    estimatedImpact: z.string().optional().describe("Impact summary"),
    affectedFiles: z.array(z.string()).optional().describe("Related files"),
});

export type PermissionMetadata = z.infer<typeof PermissionMetadataSchema>;

// ════════════════════════════════════════════════════════════════════════════
// PERMISSION REQUEST (Main Schema)
// ════════════════════════════════════════════════════════════════════════════

export const PermissionOperationType = z.enum([
    "write_file",
    "write_multiple_files",
    "delete_file",
    "rename_file",
    "run_command",
    "batch_refactor",
]);

export type PermissionOperationType = z.infer<typeof PermissionOperationType>;

export const PermissionRequestSchema = z.object({
    __permission_required: z.literal(true),
    operation: PermissionOperationType,
    preview: z.union([
        FileOperationPreviewSchema,
        z.array(FileOperationPreviewSchema),
        CommandOperationPreviewSchema,
    ]),
    metadata: PermissionMetadataSchema.optional(),
});

export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

// ════════════════════════════════════════════════════════════════════════════
// PERMISSION RESULT
// ════════════════════════════════════════════════════════════════════════════

export const PermissionResultSchema = z.object({
    operationId: z.string(),
    approved: z.boolean(),
    executedAt: z.number().optional(),
    error: z.string().optional(),
});

export type PermissionResult = z.infer<typeof PermissionResultSchema>;

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Check if a value is a permission request
 */
export function isPermissionRequest(value: unknown): value is PermissionRequest {
    try {
        PermissionRequestSchema.parse(value);
        return true;
    } catch {
        return false;
    }
}

/**
 * Parse JSON string to permission request
 */
export function parsePermissionRequest(json: string): PermissionRequest | null {
    try {
        const parsed = JSON.parse(json);
        return PermissionRequestSchema.parse(parsed);
    } catch {
        return null;
    }
}

/**
 * Create a file permission request
 */
export function createFilePermissionRequest(
    operation: "write_file" | "delete_file" | "rename_file",
    preview: FileOperationPreview,
    metadata?: PermissionMetadata
): PermissionRequest {
    return {
        __permission_required: true,
        operation,
        preview,
        metadata,
    };
}

/**
 * Create a batch permission request
 */
export function createBatchPermissionRequest(
    previews: FileOperationPreview[],
    metadata?: PermissionMetadata
): PermissionRequest {
    return {
        __permission_required: true,
        operation: "write_multiple_files",
        preview: previews,
        metadata,
    };
}

/**
 * Create a command permission request
 */
export function createCommandPermissionRequest(
    preview: CommandOperationPreview,
    metadata?: PermissionMetadata
): PermissionRequest {
    return {
        __permission_required: true,
        operation: "run_command",
        preview,
        metadata,
    };
}
