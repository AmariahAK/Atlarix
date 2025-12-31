/**
 * Permission Interceptor
 * ======================
 * Intercepts tool results, buffers permission requests, and executes approved operations.
 * Modeled after StackSense's PermissionHandler + Claude Code's blocking approval.
 * 
 * v0.9.1 Update: Added async waitForApproval() blocking mechanism
 */

import * as fs from "fs/promises";
import * as path from "path";
import log from "electron-log";
import { EventEmitter } from "events";
import {
    PermissionRequest,
    PermissionResult,
    FileOperationPreview,
    CommandOperationPreview,
    parsePermissionRequest,
} from "../../../lib/tools/permissions/schema";
import { runShellCommand, CommandResult } from "../../utils/runShellCommand";

const logger = log.scope("permission-interceptor");

// ════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════════════════════════════════════

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes default

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

interface PendingApproval {
    resolve: (approved: boolean) => void;
    timeout: NodeJS.Timeout;
    createdAt: number;
}

interface BufferedOperation {
    id: string;
    request: PermissionRequest;
    status: 'pending' | 'approved' | 'rejected' | 'executed';
    createdAt: number;
}

// ════════════════════════════════════════════════════════════════════════════
// INTERCEPTOR CLASS
// ════════════════════════════════════════════════════════════════════════════

export class PermissionInterceptor extends EventEmitter {
    /** Map of operation ID to pending permission request */
    private pendingOperations: Map<string, BufferedOperation> = new Map();

    /** Map of operation ID to pending approval promise */
    private pendingApprovals: Map<string, PendingApproval> = new Map();

    /** Map of operation ID to command execution results */
    private commandOutputs: Map<string, CommandResult> = new Map();

    /** Workspace path for resolving file paths */
    private workspacePath: string;

    constructor(workspacePath: string) {
        super();
        this.workspacePath = workspacePath;
        logger.log(`[PermissionInterceptor] Initialized for workspace: ${workspacePath}`);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // DETECTION & PARSING
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * Check if a tool result is a permission request (object or string)
     */
    isPermissionRequest(result: unknown): boolean {
        // Check object format first (new style)
        if (typeof result === 'object' && result !== null) {
            return (result as any).__permission_required === true;
        }

        // Check string format (legacy)
        if (typeof result === 'string') {
            try {
                const parsed = JSON.parse(result);
                return parsed.__permission_required === true;
            } catch {
                return result.includes("__PERMISSION_REQUIRED__");
            }
        }

        return false;
    }

    /**
     * Parse and validate a permission request from tool result
     */
    parsePermissionRequest(result: unknown): PermissionRequest | null {
        // Object format (new style - preferred)
        if (typeof result === 'object' && result !== null && (result as any).__permission_required) {
            logger.log('[parsePermissionRequest] Parsed object format');
            return result as PermissionRequest;
        }

        // String format (legacy)
        if (typeof result === 'string') {
            const parsed = parsePermissionRequest(result);
            if (parsed) {
                logger.log('[parsePermissionRequest] Parsed JSON string format');
                return parsed;
            }

            if (result.includes("__PERMISSION_REQUIRED__")) {
                logger.log('[parsePermissionRequest] Parsing legacy format');
                return this.parseLegacyPermissionRequest(result);
            }
        }

        return null;
    }

    /**
     * Parse legacy __PERMISSION_REQUIRED__ string format (backward compatibility)
     */
    private parseLegacyPermissionRequest(result: string): PermissionRequest | null {
        try {
            const content = result.replace("__PERMISSION_REQUIRED__\n", "").trim();

            if (content.includes("Create/Modify File:")) {
                const pathMatch = content.match(/Create\/Modify File: (.+)/);
                const filePath = pathMatch?.[1] || "unknown";
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
        const operation: BufferedOperation = {
            id: operationId,
            request,
            status: 'pending',
            createdAt: Date.now(),
        };

        this.pendingOperations.set(operationId, operation);

        // Enhanced logging for debugging
        logger.log('[Permission Request Buffered]', {
            id: operationId,
            operation: request.operation,
            path: (request.preview as any)?.path || 'N/A',
            timestamp: new Date().toISOString(),
        });

        // Emit event for frontend to pick up
        this.emit('permission-request', {
            operationId,
            request,
            timestamp: Date.now(),
        });
    }

    /**
     * Get all pending operations for UI display
     */
    getPendingOperations(): Array<{ id: string; request: PermissionRequest }> {
        return Array.from(this.pendingOperations.values())
            .filter(op => op.status === 'pending')
            .map(op => ({ id: op.id, request: op.request }));
    }

    /**
     * Check if there are pending operations
     */
    hasPendingOperations(): boolean {
        return Array.from(this.pendingOperations.values())
            .some(op => op.status === 'pending');
    }

    /**
     * Clear all pending operations
     */
    clearPendingOperations(): void {
        // Clear any waiting approvals
        for (const [id, approval] of this.pendingApprovals) {
            clearTimeout(approval.timeout);
            approval.resolve(false); // Auto-reject on clear
        }
        this.pendingApprovals.clear();
        this.pendingOperations.clear();
        logger.log('[PermissionInterceptor] Cleared all pending operations');
    }

    // ════════════════════════════════════════════════════════════════════════════
    // BLOCKING APPROVAL MECHANISM (NEW in v0.9.1)
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * Wait for user approval of an operation.
     * This BLOCKS the chat stream until user approves or rejects.
     * 
     * @param operationId - The operation to wait for
     * @param timeoutMs - Timeout in milliseconds (default: 5 minutes)
     * @returns Promise that resolves to true if approved, false if rejected/timeout
     */
    async waitForApproval(operationId: string, timeoutMs = PERMISSION_TIMEOUT_MS): Promise<boolean> {
        return new Promise((resolve) => {
            // Set up timeout for auto-rejection
            const timeout = setTimeout(() => {
                logger.warn(`[Permission Timeout] Operation ${operationId} timed out after ${timeoutMs}ms`);
                this.pendingApprovals.delete(operationId);

                // Mark as rejected
                const op = this.pendingOperations.get(operationId);
                if (op) {
                    op.status = 'rejected';
                }

                resolve(false);
            }, timeoutMs);

            // Store the pending approval
            this.pendingApprovals.set(operationId, {
                resolve,
                timeout,
                createdAt: Date.now(),
            });

            logger.log(`[waitForApproval] Waiting for user response on ${operationId}`);
        });
    }

    /**
     * Resolve an approval (called when user clicks Approve/Reject)
     */
    private resolveApproval(operationId: string, approved: boolean): void {
        const pending = this.pendingApprovals.get(operationId);
        if (pending) {
            clearTimeout(pending.timeout);
            pending.resolve(approved);
            this.pendingApprovals.delete(operationId);
            logger.log(`[resolveApproval] ${operationId} -> ${approved ? 'APPROVED' : 'REJECTED'}`);
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // EXECUTION
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * Execute a single approved operation.
     * Called when user clicks Approve button.
     */
    async executeOperation(operationId: string): Promise<PermissionResult> {
        const operation = this.pendingOperations.get(operationId);
        if (!operation) {
            return {
                operationId,
                approved: false,
                error: `Operation ${operationId} not found`,
            };
        }

        const request = operation.request;

        // Resolve the waiting promise (unblocks chat stream)
        this.resolveApproval(operationId, true);

        try {
            operation.status = 'approved';

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
                    await this.executeRunCommand(operationId, request);
                    break;
                default:
                    throw new Error(`Unknown operation: ${request.operation}`);
            }

            // Mark as executed
            operation.status = 'executed';

            logger.log(`[executeOperation] Executed ${operationId}: ${request.operation}`);

            return {
                operationId,
                approved: true,
                executedAt: Date.now(),
            };
        } catch (error) {
            logger.error(`[executeOperation] Failed ${operationId}:`, error);
            return {
                operationId,
                approved: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /**
     * Get the execution result for an operation (for returning to AI)
     */
    getExecutionResult(operationId: string): { success: boolean; path?: string; error?: string } {
        const operation = this.pendingOperations.get(operationId);
        if (!operation) {
            return { success: false, error: `Operation ${operationId} not found` };
        }

        if (operation.status === 'executed') {
            const path = (operation.request.preview as any)?.path;
            return { success: true, path };
        }

        if (operation.status === 'rejected') {
            return { success: false, error: 'Permission denied by user' };
        }

        return { success: false, error: `Operation status: ${operation.status}` };
    }

    /**
     * Execute all pending operations (batch approval)
     * File operations run sequentially, but commands run in parallel (non-blocking)
     */
    async executeAllOperations(): Promise<PermissionResult[]> {
        const results: PermissionResult[] = [];
        const commandPromises: Promise<PermissionResult>[] = [];
        const operationsToExecute: [string, BufferedOperation][] = [];

        // Filter to only pending operations (not already executed/rejected)
        for (const [operationId, operation] of this.pendingOperations) {
            if (operation.status === 'pending') {
                operationsToExecute.push([operationId, operation]);
            }
        }

        if (operationsToExecute.length === 0) {
            logger.log('[executeAllOperations] No pending operations to execute');
            return results;
        }

        logger.log(`[executeAllOperations] Processing ${operationsToExecute.length} pending operations`);

        for (const [operationId, operation] of operationsToExecute) {
            const request = operation.request;

            if (request.operation === 'run_command') {
                // Commands run in parallel (fire-and-forget for batch mode)
                // This allows multiple commands to be approved and run without blocking
                commandPromises.push(this.executeOperation(operationId));

                // Add a placeholder result immediately (approved, will update when command finishes)
                results.push({
                    operationId,
                    approved: true,
                });
            } else {
                // File operations run sequentially
                const result = await this.executeOperation(operationId);
                results.push(result);
            }
        }

        // Wait for all commands to complete in parallel
        if (commandPromises.length > 0) {
            logger.log(`[executeAllOperations] Waiting for ${commandPromises.length} commands to complete in parallel...`);
            const commandResults = await Promise.all(commandPromises);

            // Update results with actual command results
            for (const cmdResult of commandResults) {
                const idx = results.findIndex(r => r.operationId === cmdResult.operationId);
                if (idx >= 0) {
                    results[idx] = cmdResult;
                }
            }
        }

        // Clear executed operations from pending map
        for (const [operationId] of operationsToExecute) {
            this.pendingOperations.delete(operationId);
        }

        logger.log(`[executeAllOperations] Completed, cleared ${operationsToExecute.length} operations`);

        return results;
    }

    /**
     * Reject a single operation.
     * Called when user clicks Reject button.
     */
    rejectOperation(operationId: string): PermissionResult {
        const operation = this.pendingOperations.get(operationId);
        if (!operation) {
            return {
                operationId,
                approved: false,
                error: `Operation ${operationId} not found`,
            };
        }

        // Resolve the waiting promise with false (unblocks chat stream)
        this.resolveApproval(operationId, false);

        operation.status = 'rejected';
        logger.log(`[rejectOperation] Rejected ${operationId}: ${operation.request.operation}`);

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

    /**
     * Execute a shell command and store output.
     * Emits 'terminal-output' event for UI updates.
     */
    private async executeRunCommand(operationId: string, request: PermissionRequest): Promise<void> {
        const preview = request.preview as CommandOperationPreview;
        const workingDir = preview.workingDirectory
            ? path.isAbsolute(preview.workingDirectory)
                ? preview.workingDirectory
                : path.join(this.workspacePath, preview.workingDirectory)
            : this.workspacePath;

        logger.log(`[executeRunCommand] Running: ${preview.command} in ${workingDir}`);

        // Emit that command is starting
        this.emit('terminal-output', {
            operationId,
            command: preview.command,
            output: '',
            status: 'running' as const,
        });

        const result = await runShellCommand(preview.command, workingDir);

        // Store output for UI display and AI feedback
        this.commandOutputs.set(operationId, result);

        // Emit final output
        this.emit('terminal-output', {
            operationId,
            command: preview.command,
            output: result.stdout + (result.stderr ? `\n${result.stderr}` : ''),
            status: result.success ? 'completed' as const : 'error' as const,
            exitCode: result.exitCode,
        });

        if (result.success) {
            logger.log(`[executeRunCommand] Success: ${preview.command}`);
        } else {
            logger.error(`[executeRunCommand] Failed: ${preview.command} (exit ${result.exitCode})`);
            if (result.stderr) {
                logger.error(`[executeRunCommand] stderr: ${result.stderr}`);
            }
        }
    }

    /**
     * Get command output for an operation (for returning to AI or UI)
     */
    getCommandOutput(operationId: string): CommandResult | null {
        return this.commandOutputs.get(operationId) || null;
    }
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

        for (const [, operation] of this.pendingOperations) {
            const previews = Array.isArray(operation.request.preview)
                ? operation.request.preview
                : [operation.request.preview];

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
