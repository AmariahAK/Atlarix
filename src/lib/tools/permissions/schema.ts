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
    notice: z
        .string()
        .optional()
        .describe(
            "Audit note surfaced to the model and activity card (e.g. fuzzy-match indent/EOL drift)",
        ),
    // Set at execute time: did the on-disk bytes match what we intended to
    // write? Stashed here so the (sync) getExecutionResult can report it. Used
    // by the end-of-turn self-review gate; never sent to the model on success.
    verified: z.boolean().optional(),
    // For rename operations
    fromPath: z.string().optional().describe("Original path (for rename)"),
    toPath: z.string().optional().describe("New path (for rename)"),
    isProtectedFile: z.boolean().optional(),
    isDeleteOrRename: z.boolean().optional(),
    canAlwaysAllowFile: z.boolean().optional(),
    canAlwaysAllowDirectory: z.boolean().optional(),
    canAlwaysAllowExtension: z.boolean().optional(),
    fileParentDir: z.string().optional(),
    fileExtension: z.string().optional(),
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
    dangerExplanation: z.string().optional().describe("Plain-English explanation of risks"),
    commandCategory: z.string().optional().describe("First token category for workspace terminal rules"),
    canAlwaysAllow: z.boolean().optional().describe("Whether Always allow category is offered"),
    /** Max wall-clock for the shell run (ms). Clamped in the interceptor. */
    timeout_ms: z.number().optional(),
    /** Max UTF-8 bytes for formatted output returned to the model. */
    max_output_bytes: z.number().optional(),
    /** Set by main when user checked "I understand" for dangerous commands. */
    danger_acknowledged: z.boolean().optional(),
});

export type CommandOperationPreview = z.infer<typeof CommandOperationPreviewSchema>;

export const WorkforceActionPreviewSchema = z.object({
    service: z.string().describe("Target workforce service (e.g. slack, jira, gitlab)"),
    action: z.string().describe("Action name to execute"),
    description: z.string().describe("Human-readable summary of the action"),
    payload: z.record(z.string(), z.unknown()).describe("Action payload arguments"),
});

export const ProjectRevertPreviewSchema = z.object({
    snapshotId: z.coerce.number().int().positive(),
    label: z.string(),
    planExcerpt: z.string().max(800).optional(),
});

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
    // Parent-aggregated: one approval for a full plan (v2.2)
    "batch_plan",
    // Surgical edit tools (unified edit_file + legacy names)
    "edit_file",
    "replace_code",
    "insert_code",
    "delete_lines",
    // Restore plan from SQLite snapshot (v5.0 project memory)
    "revert_project_snapshot",
]);

/** Single operation inside a batch_plan (file or command) */
export const BatchPlanItemSchema = z.union([
    FileOperationPreviewSchema,
    CommandOperationPreviewSchema,
]);

/** Preview for batch_plan: title + list of operations */
export const BatchPlanPreviewSchema = z.object({
    title: z.string().describe("Short title for the plan (e.g. 'Building auth system')"),
    summary: z.string().optional().describe("One-line summary (e.g. '3 files to create, 1 to modify')"),
    operations: z.array(BatchPlanItemSchema).describe("Ordered list of file or command operations"),
});
export type BatchPlanPreview = z.infer<typeof BatchPlanPreviewSchema>;

export type PermissionOperationType = z.infer<typeof PermissionOperationType>;

export const PermissionRequestSchema = z.object({
    __permission_required: z.literal(true),
    operation: PermissionOperationType,
    preview: z.union([
        FileOperationPreviewSchema,
        z.array(FileOperationPreviewSchema),
        CommandOperationPreviewSchema,
        WorkforceActionPreviewSchema,
        BatchPlanPreviewSchema,
        ProjectRevertPreviewSchema,
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

