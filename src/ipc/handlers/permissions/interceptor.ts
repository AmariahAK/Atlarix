/**
 * Permission Interceptor
 * ======================
 * Intercepts tool results, buffers permission requests, and executes approved operations.
 * Modeled after StackSense's PermissionHandler.
 */

import * as fs from "fs/promises";
import * as path from "path";
import log from "electron-log";
import {
    PermissionRequest,
    PermissionResult,
    FileOperationPreview,
    parsePermissionRequest,
} from "../../../lib/tools/permissions/schema";

const logger = log.scope("permission-interceptor");

export class PermissionInterceptor {
    /** Map of operation ID to pending permission request */
    private pendingOperations: Map<string, PermissionRequest> = new Map();

    /** Workspace path for resolving file paths */
    private workspacePath: string;

    constructor(workspacePath: string) {
        this.workspacePath = workspacePath;
    }

    // ════════════════════════════════════════════════════════════════════════════
    // DETECTION & PARSING
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * Check if a tool result string is a permission request
     */
    isPermissionRequest(result: string): boolean {
        try {
            const parsed = JSON.parse(result);
            return parsed.__permission_required === true;
        } catch {
            // Also check for legacy __PERMISSION_REQUIRED__ string pattern
            return result.includes("__PERMISSION_REQUIRED__");
        }
    }

    /**
     * Parse and validate a permission request from tool result
     */
    parsePermissionRequest(result: string): PermissionRequest | null {
        // Try JSON format first
        const parsed = parsePermissionRequest(result);
        if (parsed) {
            return parsed;
        }

        // Fallback: parse legacy __PERMISSION_REQUIRED__ format
        if (result.includes("__PERMISSION_REQUIRED__")) {
            return this.parseLegacyPermissionRequest(result);
        }

        return null;
    }

    /**
     * Parse legacy __PERMISSION_REQUIRED__ string format (backward compatibility)
     */
    private parseLegacyPermissionRequest(result: string): PermissionRequest | null {
        try {
            // Extract content after __PERMISSION_REQUIRED__
            const content = result.replace("__PERMISSION_REQUIRED__\n", "").trim();

            // Try to detect operation type from content
            if (content.includes("Create/Modify File:")) {
                const pathMatch = content.match(/Create\/Modify File: (.+)/);
                const filePath = pathMatch?.[1] || "unknown";

                // Extract content between "Content (X lines):" and "[Approve]"
                const contentMatch = content.match(/Content \(\d+ lines\):\n([\s\S]*?)\n\n\[Approve\]/);
                const fileContent = contentMatch?.[1] || "";

                return {
                    __permission_required: true,
                    operation: "write_file",
                    preview: {
                        path: filePath,
                        content: fileContent,
                        description: "File operation",
                        type: "create",
                        lines: fileContent.split("\n").length,
                    },
                };
            }

            if (content.includes("Run Command:")) {
                const cmdMatch = content.match(/Command: `(.+)`/);
                const command = cmdMatch?.[1] || "unknown";

                return {
                    __permission_required: true,
                    operation: "run_command",
                    preview: {
                        command,
                        description: "Command execution",
                        isDangerous: command.includes("rm ") || command.includes("sudo"),
                    },
                };
            }

            // Generic fallback
            return {
                __permission_required: true,
                operation: "write_file",
                preview: {
                    path: "unknown",
                    content: content,
                    description: "Pending operation",
                    type: "create",
                },
            };
        } catch (error) {
            logger.error("Failed to parse legacy permission request:", error);
            return null;
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // BUFFERING
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * Generate unique operation ID
     */
    generateOperationId(): string {
        return `op_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Buffer an operation for batch approval
     */
    bufferOperation(operationId: string, request: PermissionRequest): void {
        this.pendingOperations.set(operationId, request);
        logger.log(`Buffered operation ${operationId}: ${request.operation}`);
    }

    /**
     * Get all pending operations for UI display
     */
    getPendingOperations(): Array<{ id: string; request: PermissionRequest }> {
        return Array.from(this.pendingOperations.entries()).map(([id, request]) => ({
            id,
            request,
        }));
    }

    /**
     * Check if there are pending operations
     */
    hasPendingOperations(): boolean {
        return this.pendingOperations.size > 0;
    }

    /**
     * Clear all pending operations
     */
    clearPendingOperations(): void {
        this.pendingOperations.clear();
    }

    // ════════════════════════════════════════════════════════════════════════════
    // EXECUTION
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * Execute a single approved operation
     */
    async executeOperation(operationId: string): Promise<PermissionResult> {
        const request = this.pendingOperations.get(operationId);
        if (!request) {
            return {
                operationId,
                approved: false,
                error: `Operation ${operationId} not found`,
            };
        }

        try {
            switch (request.operation) {
                case "write_file":
                    await this.executeWriteFile(request);
                    break;
                case "write_multiple_files":
                    await this.executeWriteMultipleFiles(request);
                    break;
                case "delete_file":
                    await this.executeDeleteFile(request);
                    break;
                case "rename_file":
                    await this.executeRenameFile(request);
                    break;
                case "run_command":
                    // Commands are handled separately via terminal
                    break;
                default:
                    throw new Error(`Unknown operation: ${request.operation}`);
            }

            // Remove from pending after successful execution
            this.pendingOperations.delete(operationId);

            logger.log(`Executed operation ${operationId}: ${request.operation}`);

            return {
                operationId,
                approved: true,
                executedAt: Date.now(),
            };
        } catch (error) {
            logger.error(`Failed to execute operation ${operationId}:`, error);
            return {
                operationId,
                approved: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /**
     * Execute all pending operations (batch approval)
     */
    async executeAllOperations(): Promise<PermissionResult[]> {
        const results: PermissionResult[] = [];

        for (const [operationId] of this.pendingOperations) {
            const result = await this.executeOperation(operationId);
            results.push(result);
        }

        return results;
    }

    /**
     * Reject a single operation
     */
    rejectOperation(operationId: string): PermissionResult {
        const request = this.pendingOperations.get(operationId);
        if (!request) {
            return {
                operationId,
                approved: false,
                error: `Operation ${operationId} not found`,
            };
        }

        this.pendingOperations.delete(operationId);
        logger.log(`Rejected operation ${operationId}: ${request.operation}`);

        return {
            operationId,
            approved: false,
        };
    }

    /**
     * Reject all pending operations
     */
    rejectAllOperations(): PermissionResult[] {
        const results: PermissionResult[] = [];

        for (const [operationId] of this.pendingOperations) {
            results.push(this.rejectOperation(operationId));
        }

        return results;
    }

    // ════════════════════════════════════════════════════════════════════════════
    // FILE OPERATIONS
    // ════════════════════════════════════════════════════════════════════════════

    private async executeWriteFile(request: PermissionRequest): Promise<void> {
        const preview = request.preview as FileOperationPreview;
        const fullPath = path.join(this.workspacePath, preview.path);

        // Ensure directory exists
        await fs.mkdir(path.dirname(fullPath), { recursive: true });

        // Write file
        await fs.writeFile(fullPath, preview.content || "", "utf-8");
        logger.log(`Wrote file: ${fullPath}`);
    }

    private async executeWriteMultipleFiles(request: PermissionRequest): Promise<void> {
        const previews = request.preview as FileOperationPreview[];

        for (const preview of previews) {
            const fullPath = path.join(this.workspacePath, preview.path);
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, preview.content || "", "utf-8");
            logger.log(`Wrote file: ${fullPath}`);
        }
    }

    private async executeDeleteFile(request: PermissionRequest): Promise<void> {
        const preview = request.preview as FileOperationPreview;
        const fullPath = path.join(this.workspacePath, preview.path);

        await fs.unlink(fullPath);
        logger.log(`Deleted file: ${fullPath}`);
    }

    private async executeRenameFile(request: PermissionRequest): Promise<void> {
        const preview = request.preview as FileOperationPreview;
        if (!preview.fromPath || !preview.toPath) {
            throw new Error("Rename operation requires fromPath and toPath");
        }

        const fromFullPath = path.join(this.workspacePath, preview.fromPath);
        const toFullPath = path.join(this.workspacePath, preview.toPath);

        // Ensure destination directory exists
        await fs.mkdir(path.dirname(toFullPath), { recursive: true });

        await fs.rename(fromFullPath, toFullPath);
        logger.log(`Renamed file: ${fromFullPath} → ${toFullPath}`);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // CONVERSION TO PROPOSAL FORMAT
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * Convert pending operations to CodeProposal format for FileDiffPanel
     */
    toCodeProposal(): {
        type: "code-proposal";
        title: string;
        filesChanged: Array<{
            name: string;
            path: string;
            summary: string;
            type: "write" | "rename" | "delete";
            content?: string;
        }>;
    } {
        const filesChanged: Array<{
            name: string;
            path: string;
            summary: string;
            type: "write" | "rename" | "delete";
            content?: string;
        }> = [];

        for (const [, request] of this.pendingOperations) {
            const previews = Array.isArray(request.preview)
                ? request.preview
                : [request.preview];

            for (const preview of previews) {
                if ("path" in preview) {
                    const filePreview = preview as FileOperationPreview;
                    filesChanged.push({
                        name: path.basename(filePreview.path),
                        path: filePreview.path,
                        summary: filePreview.description,
                        type: filePreview.type === "delete" ? "delete" :
                            filePreview.type === "rename" ? "rename" : "write",
                        content: filePreview.content,
                    });
                }
            }
        }

        return {
            type: "code-proposal",
            title: this.pendingOperations.size === 1
                ? "Proposed File Change"
                : `Proposed Changes (${this.pendingOperations.size} operations)`,
            filesChanged,
        };
    }
}
