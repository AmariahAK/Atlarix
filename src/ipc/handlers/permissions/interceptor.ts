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
import { queueCapture } from "../../../lib/diagram-timeline";

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
    status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
    createdAt: number;
}

/** Result of command execution with full details for AI context */
interface CommandExecutionResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    duration: number;
    timestamp: number;
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

        // NOTE: Do NOT resolve approval here! We wait until execution completes.
        // This ensures the AI doesn't continue until the command is done.

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

            // Queue timeline capture for file operations
            if (request.operation === 'write_file' || request.operation === 'write_multiple_files' ||
                request.operation === 'delete_file' || request.operation === 'rename_file') {
                const filesChanged = request.operation === 'write_multiple_files'
                    ? (request.data?.files || []).map((f: any) => f.path)
                    : request.data?.path ? [request.data.path] : [];
                if (filesChanged.length > 0 && request.data?.appId) {
                    // Queue with 5 minute debounce - multiple rapid edits get one snapshot
                    queueCapture(request.data.appId, filesChanged);
                }
            }

            // ✅ Resolve approval AFTER execution completes
            // This is the key fix - AI now waits for command to finish
            this.resolveApproval(operationId, true);

            return {
                operationId,
                approved: true,
                executedAt: Date.now(),
            };
        } catch (error) {
            // Mark as failed
            operation.status = 'failed';

            logger.error(`[executeOperation] Failed ${operationId}:`, error);

            // ✅ Resolve with false on error so AI knows it failed
            this.resolveApproval(operationId, false);

            return {
                operationId,
                approved: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /**
     * Get the execution result for an operation (for returning to AI)
     * For run_command, includes formatted terminal output with smart truncation
     */
    getExecutionResult(operationId: string): {
        success: boolean;
        path?: string;
        error?: string;
        output?: string;
        exitCode?: number;
        duration?: number;
    } {
        const operation = this.pendingOperations.get(operationId);
        if (!operation) {
            return { success: false, error: `Operation ${operationId} not found` };
        }

        if (operation.status === 'executed') {
            // Include command output for run_command operations
            if (operation.request.operation === 'run_command') {
                const cmdResult = this.commandOutputs.get(operationId);
                if (cmdResult) {
                    return {
                        success: cmdResult.success,
                        output: this.formatCommandOutput(cmdResult.stdout, cmdResult.stderr),
                        exitCode: cmdResult.exitCode,
                        error: cmdResult.success ? undefined : cmdResult.stderr.slice(0, 500),
                    };
                }
            }

            const path = (operation.request.preview as any)?.path;
            return { success: true, path };
        }

        if (operation.status === 'rejected') {
            return { success: false, error: 'Permission denied by user' };
        }

        if (operation.status === 'failed') {
            // Include command error output if available
            const cmdResult = this.commandOutputs.get(operationId);
            if (cmdResult) {
                return {
                    success: false,
                    output: this.formatCommandOutput(cmdResult.stdout, cmdResult.stderr),
                    exitCode: cmdResult.exitCode,
                    error: cmdResult.stderr.slice(0, 500) || 'Command failed',
                };
            }
            return { success: false, error: 'Execution failed' };
        }

        return { success: false, error: `Operation status: ${operation.status}` };
    }

    /**
     * Format command output with smart truncation for AI context.
     * Priority: Errors > Warnings > First 5 lines > Last 5 lines
     */
    private formatCommandOutput(stdout: string, stderr: string): string {
        const MAX_OUTPUT = 1500; // Conservative limit for context
        const output = stdout || stderr;

        if (!output) {
            return '(no output)';
        }

        if (output.length <= MAX_OUTPUT) {
            return output;
        }

        // Extract key information with priority slicing
        const lines = output.split('\n');
        const errors = lines.filter(l =>
            l.toLowerCase().includes('error') ||
            l.toLowerCase().includes('failed') ||
            l.includes('\u2717') || // ✗
            l.includes('ERR!')
        );
        const warnings = lines.filter(l =>
            l.toLowerCase().includes('warn') ||
            l.includes('\u26a0') // ⚠
        );

        let summary = '';

        if (errors.length > 0) {
            summary += '=== ERRORS ===\n' + errors.slice(0, 10).join('\n') + '\n\n';
        }

        if (warnings.length > 0) {
            summary += '=== WARNINGS ===\n' + warnings.slice(0, 5).join('\n') + '\n\n';
        }

        summary += '=== FIRST 5 LINES ===\n' + lines.slice(0, 5).join('\n') + '\n\n';
        summary += '=== LAST 5 LINES ===\n' + lines.slice(-5).join('\n');

        return summary.slice(0, MAX_OUTPUT); // Hard cap
    }

    /**
     * Execute all pending operations (batch approval)
     * All operations now run sequentially to ensure proper ordering.
     * Commands wait for completion before the next operation starts.
     */
    async executeAllOperations(): Promise<PermissionResult[]> {
        const results: PermissionResult[] = [];
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

        logger.log(`[executeAllOperations] Processing ${operationsToExecute.length} pending operations sequentially`);

        // Execute all operations sequentially - this ensures commands complete before next starts
        for (const [operationId] of operationsToExecute) {
            const result = await this.executeOperation(operationId);
            results.push(result);

            // Log progress for long-running command sequences
            logger.log(`[executeAllOperations] Completed ${result.operationId}: ${result.approved ? 'success' : 'failed'}`);
        }

        // Clear executed operations from pending map
        for (const [operationId] of operationsToExecute) {
            this.pendingOperations.delete(operationId);
        }

        logger.log(`[executeAllOperations] Completed all ${operationsToExecute.length} operations`);

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
     * Detect if a command is a dev server that runs indefinitely.
     * These commands should be treated as "started successfully" after a short time.
     */
    private isDevServerCommand(command: string): boolean {
        // FIRST: Explicitly exclude install commands (common false positive)
        const excludePatterns = [
            /npm\s+install/i,
            /npm\s+i\s/i,
            /npm\s+ci/i,
            /yarn\s+add/i,
            /yarn\s+install/i,
            /pnpm\s+add/i,
            /pnpm\s+install/i,
            /pnpm\s+i\s/i,
        ];

        if (excludePatterns.some(pattern => pattern.test(command))) {
            return false;
        }

        // Dev server patterns - commands that run indefinitely
        const devServerPatterns = [
            /npm\s+run\s+dev/i,
            /npm\s+run\s+start/i,
            /npm\s+start$/i,  // Exact end to avoid matching "npm start ..."
            /yarn\s+dev$/i,
            /yarn\s+start$/i,
            /pnpm\s+(run\s+)?dev$/i,
            /pnpm\s+(run\s+)?start$/i,
            /npx\s+vite(\s|$)/i,
            /vite\s*(dev|serve)?$/i,
            /next\s+dev/i,
            /remix\s+dev/i,
            /astro\s+dev/i,
        ];

        return devServerPatterns.some(pattern => pattern.test(command));
    }

    /**
     * Execute a shell command and store output.
     * Emits 'terminal-output' event for UI updates.
     * Includes timeout protection and progress updates for long-running commands.
     */
    private async executeRunCommand(operationId: string, request: PermissionRequest): Promise<void> {
        const preview = request.preview as CommandOperationPreview;
        const workingDir = preview.workingDirectory
            ? path.isAbsolute(preview.workingDirectory)
                ? preview.workingDirectory
                : path.join(this.workspacePath, preview.workingDirectory)
            : this.workspacePath;

        // Detect dev server commands that run indefinitely
        const isDevServerCommand = this.isDevServerCommand(preview.command);

        // Dev servers get 10 seconds to start; regular commands get 5 minutes
        const timeoutMs = isDevServerCommand
            ? 10 * 1000  // 10 seconds for dev servers
            : ((preview as any).timeout || 5 * 60 * 1000);
        const startTime = Date.now();

        logger.log(`[executeRunCommand] Running: ${preview.command} in ${workingDir} (timeout: ${timeoutMs}ms${isDevServerCommand ? ', dev-server' : ''})`);

        // Emit that command is starting
        this.emit('terminal-output', {
            operationId,
            command: preview.command,
            output: '',
            status: 'running' as const,
        });

        // Progress interval - update UI every 2 seconds for long commands
        const progressInterval = setInterval(() => {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            this.emit('terminal-output', {
                operationId,
                command: preview.command,
                output: `Running... ${elapsed}s`,
                status: 'running' as const,
            });
        }, 2000);

        // Create timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)} seconds`));
            }, timeoutMs);
        });

        try {
            // Race between command execution and timeout
            const result = await Promise.race([
                runShellCommand(preview.command, workingDir),
                timeoutPromise
            ]);

            clearInterval(progressInterval);
            const duration = Date.now() - startTime;

            // Store output for UI display and AI feedback
            this.commandOutputs.set(operationId, {
                ...result,
                // Add duration to result (extending CommandResult)
            } as CommandResult);

            // Emit final output
            this.emit('terminal-output', {
                operationId,
                command: preview.command,
                output: result.stdout + (result.stderr ? `\n${result.stderr}` : ''),
                status: result.success ? 'completed' as const : 'error' as const,
                exitCode: result.exitCode,
                duration,
            });

            if (result.success) {
                logger.log(`[executeRunCommand] Success: ${preview.command} (${(duration / 1000).toFixed(1)}s)`);
            } else {
                logger.error(`[executeRunCommand] Failed: ${preview.command} (exit ${result.exitCode})`);
                if (result.stderr) {
                    logger.error(`[executeRunCommand] stderr: ${result.stderr}`);
                }
                // Throw error so executeOperation marks it as failed
                throw new Error(`Command failed with exit code ${result.exitCode}`);
            }
        } catch (error) {
            clearInterval(progressInterval);
            const duration = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : String(error);
            const isTimeout = errorMessage.includes('timed out');

            // Dev server timeout = success (server is still running after 10 seconds)
            if (isDevServerCommand && isTimeout) {
                logger.log(`[executeRunCommand] Dev server started: ${preview.command} (running in background)`);

                // Store success result for AI context
                this.commandOutputs.set(operationId, {
                    stdout: `Dev server started successfully and is running in background`,
                    stderr: '',
                    exitCode: 0,
                    success: true,
                });

                // Emit success for dev server
                this.emit('terminal-output', {
                    operationId,
                    command: preview.command,
                    output: 'Dev server started successfully (running in background)',
                    status: 'completed' as const,
                    exitCode: 0,
                    duration,
                });

                return; // Don't throw - treat as success
            }

            // Regular timeout or error - store error result for AI context
            this.commandOutputs.set(operationId, {
                stdout: '',
                stderr: errorMessage,
                exitCode: -1,
                success: false,
            });

            // Emit error output
            this.emit('terminal-output', {
                operationId,
                command: preview.command,
                output: errorMessage,
                status: 'error' as const,
                exitCode: -1,
                duration,
            });

            logger.error(`[executeRunCommand] Error: ${preview.command} - ${errorMessage}`);
            throw error;
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
