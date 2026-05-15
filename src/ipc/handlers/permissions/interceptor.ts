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
import { createHash } from "crypto";
import log from "electron-log";
import { EventEmitter } from "events";
import { BrowserWindow } from "electron";
import {
    decideDiagramAction,
    type ApprovedOperation,
    type DiagramDecision,
} from "../../../lib/diagram-refresh-engine";
import {
    PermissionRequest,
    PermissionResult,
    FileOperationPreview,
    CommandOperationPreview,
    DiagramUpdatePreview,
    BatchPlanPreview,
    parsePermissionRequest,
} from "../../../lib/tools/permissions/schema";
import { runShellCommand, runShellCommandStreaming, CommandResult } from "../../utils/runShellCommand";
import { resolvePathUnderWorkspace } from "../../utils/safeWorkspaceRelativePath";
import { queueCapture } from "../../../lib/diagram-timeline";
import { db } from "@/db";
import { diagrams } from "@/db/schema";
import { eq } from "drizzle-orm";
import { captureSnapshot } from "../../../lib/snapshot/snapshot-manager";
import { appendLedgerFilesWritten } from "../../../lib/tasks/task-ledger";
import {
    isAlwaysAutoApproveAtlarixRelativePath,
    isAtlarixPlanRelativePath,
} from "../../../lib/tasks/plan-sync";
import { FileUploadsState } from "../../utils/file_uploads_state";
import { clearAllConsoleBuffers } from "../console_debugger";
import { readSettings } from "../../../main/settings";
import { runDiagramRegenerateBackground } from "../diagram_regenerate_background";
import { SessionTracker, SESSION_THRESHOLDS } from "../../../lib/SessionTracker";
import {
    runHooksForTrigger,
    type HookTrigger,
} from "../../../lib/hooks/hooks-manager";
import { SubscriptionManager } from "../../../lib/SubscriptionManager";

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

    /** Per run_command operation: max UTF-8 bytes for formatted output (survives pendingOperations eviction). */
    private commandOutputMaxBytes: Map<string, number> = new Map();

    /** Skip redundant full re-seeds when the model writes the same plan twice in quick succession. */
    private static planLedgerRefreshGuard = new Map<string, { hash: string; at: number }>();

    /** Track executed operations for diagram refresh analysis */
    private executedOperations: ApprovedOperation[] = [];

    /** Workspace path for resolving file paths */
    private workspacePath: string;

    /** Workspace ID for diagram refresh */
    private workspaceId: number | null = null;

    /**
     * Assistant / turn id used as `.atlarix/snapshots/<turnId>/` directory name.
     * When unset, `maybeCaptureWorkspaceSnapshot` is a no-op (no manifest or .bak files).
     * Ephemeral Ask chats omit this (see chat_stream_handlers: PermissionInterceptor gets no turn id),
     * so those sessions never write workspace snapshots. Build uses a stable stream turn id even for
     * ephemeral workspaces, so pre-write capture can still run there.
     */
    private snapshotTurnId: string | null = null;

    /** Active chat id for plan-ledger attribution (Build / Ask stream). */
    private activeChatId: number;

    /** Cached diagram mermaid for first snapshot in this turn */
    private diagramContentCache: string | undefined | null = null;

    /** When run_command uses an absolute cwd outside workspace, we allow file ops under that path for this session */
    private allowedRoots: Set<string> = new Set();

    constructor(
        workspacePath: string,
        workspaceId?: number,
        snapshotTurnId?: string | number,
        activeChatId?: number,
    ) {
        super();
        this.workspacePath = workspacePath;
        this.workspaceId = workspaceId ?? null;
        this.activeChatId = activeChatId ?? 0;
        if (snapshotTurnId !== undefined && snapshotTurnId !== null) {
            this.snapshotTurnId = String(snapshotTurnId);
        }
        // snapshotTurnId left null → disk snapshots disabled for this interceptor instance (e.g. Ask + ephemeral).
        logger.log(`[PermissionInterceptor] Initialized for workspace: ${workspacePath} (id: ${workspaceId}, turn: ${this.snapshotTurnId ?? "none"}, chat: ${this.activeChatId})`);
    }

    /** Live chat mode from settings (never cache on the instance). */
    private getEffectiveChatMode(): string {
        return readSettings().selectedChatMode ?? "ask";
    }

    /**
     * File / batch file operations under `.atlarix/` or `.atlarixignore` auto-approve without user prompt.
     */
    shouldAlwaysAutoApprove(request: PermissionRequest): boolean {
        const checkPath = (filePath: string): boolean => {
            try {
                const rel = this.toWorkspaceRelativePosix(filePath);
                return isAlwaysAutoApproveAtlarixRelativePath(rel);
            } catch {
                return false;
            }
        };

        // v8.0.1: User-attached file uploads auto-approve (user consented by attaching)
        const checkPreApprovedPath = (filePath: string): boolean => {
            try {
                return FileUploadsState.getInstance().isPreApprovedPath(filePath);
            } catch {
                return false;
            }
        };

        switch (request.operation) {
            case "write_file":
            case "replace_code":
            case "insert_code":
            case "delete_lines":
            case "delete_file": {
                const preview = request.preview as FileOperationPreview;
                if (preview?.path && checkPreApprovedPath(preview.path)) return true;
                return Boolean(preview?.path && checkPath(preview.path));
            }
            case "rename_file": {
                const preview = request.preview as FileOperationPreview;
                if (preview?.toPath && checkPreApprovedPath(preview.toPath)) return true;
                return Boolean(
                    preview?.fromPath &&
                        preview?.toPath &&
                        checkPath(preview.fromPath) &&
                        checkPath(preview.toPath),
                );
            }
            case "write_multiple_files": {
                const previews = request.preview as FileOperationPreview[];
                if (!Array.isArray(previews) || previews.length === 0) return false;
                // If all paths are pre-approved, auto-approve
                if (previews.every((p) => p?.path && checkPreApprovedPath(p.path))) return true;
                return previews.every((p) => p?.path && checkPath(p.path));
            }
            case "batch_plan": {
                const batch = request.preview as BatchPlanPreview;
                if (!batch?.operations?.length) return false;
                for (const op of batch.operations) {
                    if ("command" in op && typeof (op as CommandOperationPreview).command === "string") {
                        return false;
                    }
                    const fp = op as FileOperationPreview;
                    if (!fp?.path || !checkPath(fp.path)) return false;
                }
                return true;
            }
            default:
                return false;
        }
    }

    /** After writing ATLARIX_PLAN.md: refresh workspace `plan:<id>` ledger without re-archiving. */
    private async refreshPlanLedgerFromWrittenFile(fullPath: string, rel: string): Promise<void> {
        if (!this.workspaceId || !isAtlarixPlanRelativePath(rel)) return;
        let content: string;
        try {
            content = await fs.readFile(fullPath, "utf8");
        } catch (e) {
            logger.warn("[refreshPlanLedgerFromWrittenFile] read failed:", e);
            return;
        }
        const digest = createHash("sha256").update(content, "utf8").digest("hex");
        const guardKey = `${this.workspaceId}:${rel.replace(/\\/g, "/")}`;
        const now = Date.now();
        const prev = PermissionInterceptor.planLedgerRefreshGuard.get(guardKey);
        if (prev?.hash === digest && now - prev.at < 450) {
            logger.log("[refreshPlanLedgerFromWrittenFile] skip duplicate plan body (debounced)");
            return;
        }
        PermissionInterceptor.planLedgerRefreshGuard.set(guardKey, { hash: digest, at: now });

        const { parsePlanToSteps, extractPlanTitle } = await import("@/lib/tasks/atlarix-plan-steps");
        const steps = parsePlanToSteps(content);
        if (steps.length === 0) return;

        const {
            planLedgerTurnId,
            getLedger,
            createLedger,
            setLedgerSteps,
            persistLedgerToDisk,
        } = await import("@/lib/tasks/task-ledger");
        const { syncPlanFile } = await import("@/lib/tasks/plan-sync");
        const planTurnId = planLedgerTurnId(this.workspaceId);
        if (planTurnId == null) return;
        const taskHead = extractPlanTitle(content, "Implementation plan");

        const existing = getLedger(planTurnId);
        if (existing) {
            await setLedgerSteps(planTurnId, steps, { archive: false });
            const L = getLedger(planTurnId);
            if (L) {
                L.chatId = this.activeChatId;
                await persistLedgerToDisk(L);
                await syncPlanFile(this.workspacePath, L);
            }
        } else {
            createLedger({
                turnId: planTurnId,
                chatId: this.activeChatId,
                originalTask: taskHead,
                chatType: "workspace",
                workspacePath: this.workspacePath,
                stepDescriptions: steps,
            });
            const L = getLedger(planTurnId);
            if (L) await syncPlanFile(this.workspacePath, L);
        }
    }

    private async runAdvisoryHooks(
        trigger: HookTrigger,
        extraEnv: Record<string, string>,
    ): Promise<void> {
        await runHooksForTrigger({
            trigger,
            workspacePath: this.workspacePath,
            workspaceId: this.workspaceId,
            extraEnv,
        });
    }

    /**
     * Emit operation status to all windows for queue UI updates
     */
    private emitStatus(
        operationId: string,
        status: 'pending' | 'queued' | 'running' | 'completed' | 'failed',
        progress?: number,
        duration?: number,
        error?: string
    ): void {
        const payload = { operationId, status, progress, duration, error };
        for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('operation-status', payload);
        }
        logger.log(`[emitStatus] ${operationId} -> ${status}${error ? ` (${error})` : ''}`);
    }

    /**
     * Emit diagram staleness event based on SessionTracker thresholds
     * v0.9.16: Part of AI's mini-git system
     */
    private emitDiagramStaleness(
        severity: 'minor' | 'major',
        changedFileCount: number
    ): void {
        const payload = {
            diagramId: this.workspaceId,
            isStale: true,
            severity: severity === 'major' ? 'major' : 'moderate',
            reason: `${changedFileCount} file(s) changed this session`,
            recommendation: severity === 'major' ? 'force-refresh' : 'suggest-refresh',
            source: 'session-tracker',
        };

        for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('diagram:staleness-detected', payload);
        }
        logger.log(`[SessionTracker] Diagram staleness: ${severity} (${changedFileCount} files)`);
    }

    /**
     * Set workspace ID (if not known at construction time)
     */
    setWorkspaceId(id: number): void {
        this.workspaceId = id;
    }

    /**
     * Update workspace path and ID (e.g. after create_workspace in same turn).
     * Ensures subsequent run_command/write_file in this session use the new project root.
     */
    setWorkspace(path: string, id?: number): void {
        this.workspacePath = path;
        if (id != null) this.workspaceId = id;
        logger.log(`[PermissionInterceptor] Workspace updated to: ${path} (id: ${id})`);
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
     * @param silent When true, do not emit permission-request (autonomous auto-approve path).
     */
    bufferOperation(operationId: string, request: PermissionRequest, silent = false): void {
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

        const silentOut = silent || this.shouldAlwaysAutoApprove(request);
        if (!silentOut) {
            // Emit event for frontend to pick up
            this.emit('permission-request', {
                operationId,
                request,
                timestamp: Date.now(),
            });
        }
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
     * Get count of all executed operations (for agentic loop tracking)
     */
    getExecutedOperationsCount(): number {
        return Array.from(this.pendingOperations.values())
            .filter(op => op.status === 'executed' || op.status === 'failed')
            .length;
    }

    /**
     * Get count of all operations (any status)
     */
    getAllOperationsCount(): number {
        return this.pendingOperations.size;
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

            // Emit running status for queue UI
            this.emitStatus(operationId, 'running');

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
                // Surgical edit tools - they all produce preview.content with full file
                case "replace_code":
                case "insert_code":
                case "delete_lines":
                    await this.executeWriteFile(request);
                    break;
                // AI-controlled diagram update
                case "update_diagram":
                    await this.executeUpdateDiagram(request);
                    break;
                // Parent-aggregated: execute each sub-operation in order (v2.2)
                case "batch_plan":
                    await this.executeBatchPlan(operationId, request);
                    break;
                case "revert_project_snapshot":
                    await this.executeRevertProjectSnapshot(request);
                    break;
                default:
                    throw new Error(`Unknown operation: ${request.operation}`);
            }

            // Mark as executed
            operation.status = 'executed';

            // Emit completed status - frontend will clear all errors (todo approach)
            this.emitStatus(operationId, 'completed');

            logger.log(`[executeOperation] Executed ${operationId}: ${request.operation}`);

            // Track operation for diagram refresh analysis
            const preview = request.preview as FileOperationPreview;
            const cmdPreview = request.preview as CommandOperationPreview;
            this.executedOperations.push({
                type: request.operation as ApprovedOperation['type'],
                path: preview?.path,
                command: cmdPreview?.command,
                isNewFile: preview?.type === 'create',
            });

            // ═══════════════════════════════════════════════════════════════
            // SESSION TRACKER: Record file changes for AI awareness (v0.9.16)
            // Session tracker feeds git_status session summary when workspaceId is passed
            // NOTE: Staleness emission happens in executeAllOperations (batch-aware)
            // ═══════════════════════════════════════════════════════════════
            if (this.workspaceId && preview?.path) {
                const tracker = SessionTracker.getInstance(this.workspaceId);
                if (!tracker.isInitialized) {
                    tracker.initialize(this.workspacePath).catch(() => { });
                }

                const changeType = preview.type === 'create' ? 'added'
                    : request.operation === 'delete_file' ? 'deleted'
                        : 'modified';
                tracker.recordChange(preview.path, changeType);
                // Per-file emission removed - staleness checked after batch completes
            }

            if (this.workspaceId && (request.operation === "write_file" || request.operation === "write_multiple_files")) {
                const previews = Array.isArray(request.preview)
                    ? (request.preview as FileOperationPreview[])
                    : preview?.path
                        ? [preview as FileOperationPreview]
                        : [];
                let sawPlanWrite = false;
                let sawIgnoreWrite = false;
                for (const p of previews) {
                    const norm = String(p.path || "").replace(/\\/g, "/");
                    if (!norm) continue;
                    if (
                        norm === ".atlarix/ATLARIX_PLAN.md" ||
                        norm.endsWith("/.atlarix/ATLARIX_PLAN.md") ||
                        norm === "ATLARIX_PLAN.md" ||
                        norm.endsWith("/ATLARIX_PLAN.md")
                    ) {
                        sawPlanWrite = true;
                    }
                    if (norm === ".atlarixignore" || norm.endsWith("/.atlarixignore")) {
                        sawIgnoreWrite = true;
                    }
                }
                if (sawPlanWrite) {
                    const { recordPlanUpdateSnapshot } = await import("@/lib/project-memory/service");
                    void recordPlanUpdateSnapshot(this.workspaceId, this.workspacePath);
                }
                // Pass 7: Blueprint cache no longer exists; .atlarixignore writes don't need invalidation here.
                void sawIgnoreWrite;
            }

            // Queue timeline capture for file operations
            if (request.operation === 'write_file' || request.operation === 'write_multiple_files' ||
                request.operation === 'delete_file' || request.operation === 'rename_file') {
                const reqData = (request as { data?: { files?: { path: string }[]; path?: string; appId?: number } }).data;
                const filesChanged = request.operation === 'write_multiple_files'
                    ? (reqData?.files || []).map((f: { path: string }) => f.path)
                    : reqData?.path ? [reqData.path] : [];
                if (filesChanged.length > 0 && reqData?.appId) {
                    // Queue with 5 minute debounce - multiple rapid edits get one snapshot
                    queueCapture(reqData.appId, filesChanged);
                }
            }

            // Resolve approval AFTER execution completes
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

            // Emit failed status for queue UI
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.emitStatus(operationId, 'failed', undefined, undefined, errorMessage);

            logger.error(`[executeOperation] Failed ${operationId}:`, error);

            // Resolve with false on error so AI knows it failed
            this.resolveApproval(operationId, false);

            return {
                operationId,
                approved: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /**
     * Pass 7: when the AI runs `git commit ...` in a Workforce workspace,
     * append a structured suggestion to the result so the model can ask the
     * user "would you also like a Blueprint snapshot?". No side-effect, no
     * automation — the AI calls `commit_blueprint` only if the user agrees.
     */
    private maybeAttachBlueprintSuggestion(
        command: string | undefined,
        success: boolean,
        base: Record<string, unknown>,
    ): Record<string, unknown> {
        if (!success) return base;
        if (!command || !/git\s+commit/.test(command)) return base;
        try {
            if (SubscriptionManager.getEffectiveTier() !== "workforce") return base;
        } catch {
            return base;
        }
        return {
            ...base,
            blueprintSuggestion: true,
            blueprintSuggestionMessage:
                "Commit successful. You can also call `commit_blueprint` to save a `.atlarix/blueprint.json` snapshot so your team gets the current architecture state. Ask the user before running it.",
        };
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
        blueprintSuggestion?: boolean;
        blueprintSuggestionMessage?: string;
    } {
        const operation = this.pendingOperations.get(operationId);

        // CRITICAL FIX: If operation was deleted from pendingOperations 
        // (which happens after executeAllOperations), still check commandOutputs
        // This ensures command failures are correctly identified vs user rejections
        if (!operation) {
            const cmdResult = this.commandOutputs.get(operationId);
            if (cmdResult) {
                const maxB = this.getMaxOutputBytesForCommand(operationId, null);
                // Command was executed - return result with exitCode
                const base = {
                    success: cmdResult.success,
                    output: this.formatCommandOutput(
                        cmdResult.stdout,
                        cmdResult.stderr,
                        maxB,
                    ),
                    exitCode: cmdResult.exitCode,
                    error: cmdResult.success ? undefined : cmdResult.stderr.slice(0, 500) || 'Command failed',
                };
                // We do not have the command string here, so we cannot attach the
                // Blueprint suggestion in this code path. The hot path (operation
                // still in pendingOperations) handles git-commit detection below.
                return base;
            }
            // Truly not found - this is a user rejection or timeout
            return { success: false, error: `Operation ${operationId} not found` };
        }

        const maxOutBytes = this.getMaxOutputBytesForCommand(operationId, operation);

        if (operation.status === 'executed') {
            // Include command output for run_command operations
            if (operation.request.operation === 'run_command') {
                const cmdResult = this.commandOutputs.get(operationId);
                if (cmdResult) {
                    const cmdPreview = operation.request.preview as { command?: string } | undefined;
                    const base = {
                        success: cmdResult.success,
                        output: this.formatCommandOutput(
                            cmdResult.stdout,
                            cmdResult.stderr,
                            maxOutBytes,
                        ),
                        exitCode: cmdResult.exitCode,
                        error: cmdResult.success ? undefined : cmdResult.stderr.slice(0, 500),
                    };
                    return this.maybeAttachBlueprintSuggestion(
                        cmdPreview?.command,
                        cmdResult.success,
                        base,
                    ) as ReturnType<PermissionInterceptor['getExecutionResult']>;
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
                    output: this.formatCommandOutput(
                        cmdResult.stdout,
                        cmdResult.stderr,
                        maxOutBytes,
                    ),
                    exitCode: cmdResult.exitCode,
                    error: cmdResult.stderr.slice(0, 500) || 'Command failed',
                };
            }
            return { success: false, error: 'Execution failed' };
        }

        return { success: false, error: `Operation status: ${operation.status}` };
    }

    private getMaxOutputBytesForCommand(
        operationId: string,
        operation: BufferedOperation | null | undefined,
    ): number {
        const fromMap = this.commandOutputMaxBytes.get(operationId);
        if (fromMap != null) return fromMap;
        if (operation?.request?.operation === "run_command") {
            const p = operation.request.preview as CommandOperationPreview;
            const raw = (p as { max_output_bytes?: number }).max_output_bytes;
            return Math.min(300_000, Math.max(1024, Number(raw) || 80_000));
        }
        return 80_000;
    }

    /**
     * Format command output with smart truncation for AI context.
     * Priority: Errors > Warnings > First 5 lines > Last 5 lines; then UTF-8 byte cap.
     */
    private formatCommandOutput(
        stdout: string,
        stderr: string,
        maxOutputBytes: number,
    ): string {
        const hasOut = Boolean(stdout?.trim());
        const hasErr = Boolean(stderr?.trim());
        let combined: string;
        if (hasOut && hasErr) {
            combined = `=== STDOUT ===\n${stdout}\n\n=== STDERR ===\n${stderr}`;
        } else {
            combined = stdout || stderr || "";
        }

        if (!combined.trim()) {
            return "(no output)";
        }

        const utf8ByteLength = (s: string): number => Buffer.byteLength(s, "utf8");

        const truncateUtf8 = (s: string, maxBytes: number): string => {
            const buf = Buffer.from(s, "utf8");
            if (buf.length <= maxBytes) return s;
            const cut = buf.subarray(0, Math.max(0, maxBytes - 80));
            return (
                cut.toString("utf8") +
                "\n\n… [truncated: output exceeded max_output_bytes; pass a higher max_output_bytes or a narrower command]"
            );
        };

        if (utf8ByteLength(combined) <= maxOutputBytes) {
            return combined;
        }

        const lines = combined.split("\n");
        const errors = lines.filter(
            (l) =>
                l.toLowerCase().includes("error") ||
                l.toLowerCase().includes("failed") ||
                l.includes("\u2717") ||
                l.includes("ERR!"),
        );
        const warnings = lines.filter(
            (l) => l.toLowerCase().includes("warn") || l.includes("\u26a0"),
        );

        let summary = "";

        if (errors.length > 0) {
            summary += "=== ERRORS ===\n" + errors.slice(0, 10).join("\n") + "\n\n";
        }

        if (warnings.length > 0) {
            summary += "=== WARNINGS ===\n" + warnings.slice(0, 5).join("\n") + "\n\n";
        }

        summary +=
            "=== FIRST 5 LINES ===\n" +
            lines.slice(0, 5).join("\n") +
            "\n\n";
        summary += "=== LAST 5 LINES ===\n" + lines.slice(-5).join("\n");

        return truncateUtf8(summary, maxOutputBytes);
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

        // ════════════════════════════════════════════════════════════════════
        // POST-SEQUENCE DIAGRAM REFRESH
        // Evaluate operations and refresh diagram if structural changes detected
        // ════════════════════════════════════════════════════════════════════
        if (this.workspaceId && this.executedOperations.length > 0) {
            await this.evaluateDiagramRefresh();
        }

        // ═══════════════════════════════════════════════════════════════
        // SESSION TRACKER: Batch-complete staleness check (v0.9.16)
        // Emit staleness ONCE after all operations complete, not per-file
        // ═══════════════════════════════════════════════════════════════
        if (this.workspaceId && this.getEffectiveChatMode() !== "ask") {
            const tracker = SessionTracker.getInstance(this.workspaceId);
            const status = tracker.getDiagramStatus();
            if (status !== 'current') {
                this.emitDiagramStaleness(
                    status === 'major_drift' ? 'major' : 'minor',
                    tracker.changeCount
                );
                logger.log(`[SessionTracker] Batch complete: ${status} (${tracker.changeCount} files, ${(tracker.getChangePercentage() * 100).toFixed(1)}%)`);
            }
        }

        // Clear executed operations for next sequence
        this.executedOperations = [];

        // ════════════════════════════════════════════════════════════════════
        // FIX 2 (v0.9.15): Clear CDP console buffers to prevent stale errors
        // This sends Console.clearMessages via CDP and notifies renderer
        // ════════════════════════════════════════════════════════════════════
        clearAllConsoleBuffers();

        return results;
    }

    /**
     * Evaluate whether diagram needs refresh after operation sequence.
     * Called automatically after executeAllOperations completes.
     */
    private async evaluateDiagramRefresh(): Promise<void> {
        if (!this.workspaceId) return;
        if (this.getEffectiveChatMode() === "ask") {
            logger.log("[Diagram Refresh] Skipped: Ask mode (no auto regen or staleness IPC)");
            return;
        }

        try {
            const decision = await decideDiagramAction(this.workspaceId, this.executedOperations);

            logger.log(`[Diagram Refresh] Decision: ${decision.action} - ${decision.reason} (confidence: ${decision.confidence.toFixed(2)})`);

            if (decision.action === 'generate' || decision.action === 'refresh') {
                // Emit event for frontend notification (EventEmitter for internal use)
                this.emit('diagram:refresh-needed', {
                    workspaceId: this.workspaceId,
                    action: decision.action,
                    reason: decision.reason,
                    confidence: decision.confidence,
                });

                // ═══════════════════════════════════════════════════════════════
                // CRITICAL: Send IPC to renderer for staleness banner display
                // This updates diagramStalenessAtom in the frontend
                // ═══════════════════════════════════════════════════════════════
                const stalenessPayload = {
                    diagramId: this.workspaceId, // Use workspace ID as diagram reference
                    isStale: true,
                    severity: decision.confidence > 0.7 ? 'major' : decision.confidence > 0.4 ? 'moderate' : 'minor' as const,
                    reason: decision.reason,
                    recommendation: decision.action === 'generate' ? 'force-refresh' : 'suggest-refresh' as const,
                };

                for (const win of BrowserWindow.getAllWindows()) {
                    win.webContents.send('diagram:staleness-detected', stalenessPayload);
                }
                logger.log(`[Diagram Staleness] Sent to renderer: ${stalenessPayload.severity} - ${stalenessPayload.reason}`);

                // Trigger background diagram regeneration
                // Uses setImmediate to not block the permission response
                const workspaceId = this.workspaceId;
                setImmediate(async () => {
                    try {
                        logger.log(`[Diagram Refresh] Triggering background regeneration for workspace ${workspaceId}`);
                        await runDiagramRegenerateBackground(workspaceId);
                    } catch (err) {
                        logger.error('[Diagram Refresh] Background regeneration failed:', err);
                    }
                });
            }
        } catch (error) {
            logger.error('[Diagram Refresh] Error evaluating:', error);
        }
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

    /**
     * Resolve a file path so it is under this.workspacePath or under an allowed root (from run_command absolute cwd).
     * - Relative paths: joined with workspacePath (current behavior).
     * - Absolute paths: allowed if inside workspacePath or inside any allowedRoot; otherwise throws.
     */
    private resolvePathWithinWorkspace(filePath: string): string {
        const normalizedWorkspace = path.resolve(this.workspacePath);
        if (!path.isAbsolute(filePath)) {
            return resolvePathUnderWorkspace(this.workspacePath, filePath);
        }
        const normalizedPath = path.resolve(filePath);
        const relativeToWorkspace = path.relative(normalizedWorkspace, normalizedPath);
        if (!relativeToWorkspace.startsWith("..") && !path.isAbsolute(relativeToWorkspace)) {
            return normalizedPath;
        }
        for (const root of this.allowedRoots) {
            const relativeToRoot = path.relative(root, normalizedPath);
            if (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot)) {
                return normalizedPath;
            }
        }
        throw new Error(
            `Path is outside workspace: ${filePath}. Import this folder as the project or use "Create app" with a target folder so files and commands use the same location.`
        );
    }

    private toWorkspaceRelativePosix(filePath: string): string {
        const full = this.resolvePathWithinWorkspace(filePath);
        const rel = path.relative(this.workspacePath, full);
        return rel.split(path.sep).join("/");
    }

    private async getDiagramContentForSnapshot(): Promise<string | undefined> {
        if (this.diagramContentCache !== null) {
            return this.diagramContentCache ?? undefined;
        }
        if (this.workspaceId == null) {
            this.diagramContentCache = undefined;
            return undefined;
        }
        const [row] = await db
            .select({ content: diagrams.content })
            .from(diagrams)
            .where(eq(diagrams.workspaceId, this.workspaceId))
            .limit(1);
        this.diagramContentCache = row?.content ?? undefined;
        return this.diagramContentCache;
    }

    /**
     * Capture pre-write file state under `.atlarix/snapshots/<turnId>/`.
     * Requires `snapshotTurnId` (see field doc). `captureSnapshot` itself does not read chatId;
     * gating is entirely whether the stream passed a turn id into this interceptor.
     */
    private async maybeCaptureWorkspaceSnapshot(relativePaths: string[]): Promise<void> {
        if (!this.snapshotTurnId || !this.workspacePath) return;
        const paths = relativePaths.map((p) => p.split(path.sep).join("/")).filter(Boolean);
        if (paths.length === 0) return;
        try {
            const diagramBefore = await this.getDiagramContentForSnapshot();
            await captureSnapshot({
                workspacePath: this.workspacePath,
                turnId: this.snapshotTurnId,
                relativePaths: paths,
                diagramBefore,
            });
        } catch (e) {
            logger.warn("[maybeCaptureWorkspaceSnapshot] skipped:", e);
        }
    }

    private async executeRevertProjectSnapshot(request: PermissionRequest): Promise<void> {
        const preview = request.preview as { snapshotId: number; label: string; planExcerpt?: string };
        if (this.workspaceId == null) {
            throw new Error("Workspace ID required to revert project snapshot");
        }
        const { applyProjectSnapshotRevert } = await import("@/lib/project-memory/service");
        const result = await applyProjectSnapshotRevert(
            this.workspaceId,
            this.workspacePath,
            preview.snapshotId,
        );
        if (!result.success) {
            throw new Error(result.error || "Revert failed");
        }
        logger.log(`[executeRevertProjectSnapshot] id=${preview.snapshotId}`);
    }

    private async executeWriteFile(request: PermissionRequest): Promise<void> {
        const preview = request.preview as FileOperationPreview;
        await this.maybeCaptureWorkspaceSnapshot([this.toWorkspaceRelativePosix(preview.path)]);
        const fullPath = this.resolvePathWithinWorkspace(preview.path);
        const rel = this.toWorkspaceRelativePosix(preview.path);
        if (isAtlarixPlanRelativePath(rel)) {
            const { archiveCurrentPlan } = await import("@/lib/tasks/plan-sync");
            await archiveCurrentPlan(this.workspacePath, rel);
        }
        await this.runAdvisoryHooks("before_file_write", { ATLARIX_FILE_PATH: rel });

        // Ensure directory exists
        await fs.mkdir(path.dirname(fullPath), { recursive: true });

        // Write file
        await fs.writeFile(fullPath, preview.content || "", "utf-8");
        await this.runAdvisoryHooks("after_file_write", { ATLARIX_FILE_PATH: rel });
        logger.log(`Wrote file: ${fullPath}`);
        if (this.snapshotTurnId) {
            appendLedgerFilesWritten(this.snapshotTurnId, [
                this.toWorkspaceRelativePosix(preview.path),
            ]);
        }
        if (isAtlarixPlanRelativePath(rel)) {
            await this.refreshPlanLedgerFromWrittenFile(fullPath, rel);
        }
    }

    private async executeWriteMultipleFiles(request: PermissionRequest): Promise<void> {
        const previews = request.preview as FileOperationPreview[];

        await this.maybeCaptureWorkspaceSnapshot(
            previews.map((p) => this.toWorkspaceRelativePosix(p.path)),
        );

        const relPaths: string[] = [];
        for (const preview of previews) {
            const fullPath = this.resolvePathWithinWorkspace(preview.path);
            const rel = this.toWorkspaceRelativePosix(preview.path);
            if (isAtlarixPlanRelativePath(rel)) {
                const { archiveCurrentPlan } = await import("@/lib/tasks/plan-sync");
                await archiveCurrentPlan(this.workspacePath, rel);
            }
            await this.runAdvisoryHooks("before_file_write", { ATLARIX_FILE_PATH: rel });
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, preview.content || "", "utf-8");
            logger.log(`Wrote file: ${fullPath}`);
            relPaths.push(rel);
            await this.runAdvisoryHooks("after_file_write", { ATLARIX_FILE_PATH: rel });
            if (isAtlarixPlanRelativePath(rel)) {
                await this.refreshPlanLedgerFromWrittenFile(fullPath, rel);
            }
        }
        if (this.snapshotTurnId && relPaths.length > 0) {
            appendLedgerFilesWritten(this.snapshotTurnId, relPaths);
        }
    }

    private async executeDeleteFile(request: PermissionRequest): Promise<void> {
        const preview = request.preview as FileOperationPreview;
        await this.maybeCaptureWorkspaceSnapshot([this.toWorkspaceRelativePosix(preview.path)]);
        const fullPath = this.resolvePathWithinWorkspace(preview.path);

        await fs.unlink(fullPath);
        logger.log(`Deleted file: ${fullPath}`);
    }

    private async executeRenameFile(request: PermissionRequest): Promise<void> {
        const preview = request.preview as FileOperationPreview;
        if (!preview.fromPath || !preview.toPath) {
            throw new Error("Rename operation requires fromPath and toPath");
        }

        await this.maybeCaptureWorkspaceSnapshot([this.toWorkspaceRelativePosix(preview.fromPath)]);

        const fromFullPath = this.resolvePathWithinWorkspace(preview.fromPath);
        const toFullPath = this.resolvePathWithinWorkspace(preview.toPath);

        // Ensure destination directory exists
        await fs.mkdir(path.dirname(toFullPath), { recursive: true });

        await fs.rename(fromFullPath, toFullPath);
        logger.log(`Renamed file: ${fromFullPath} → ${toFullPath}`);
    }

    /**
     * Execute diagram update when user approves the AI's request.
     * Calls DiagramManager.regenerateForWorkspace with focus components.
     */
    /**
     * Execute a batch_plan: run each file or command operation in order.
     * Used for parent-aggregated permissions (one approval for full plan).
     */
    private async executeBatchPlan(operationId: string, request: PermissionRequest): Promise<void> {
        const batch = request.preview as BatchPlanPreview;
        if (!batch.operations || !Array.isArray(batch.operations)) {
            throw new Error("batch_plan requires preview.operations array");
        }
        for (let i = 0; i < batch.operations.length; i++) {
            const op = batch.operations[i];
            const subId = `${operationId}_${i}`;
            if ("command" in op && typeof op.command === "string") {
                const cmdRequest: PermissionRequest = {
                    __permission_required: true,
                    operation: "run_command",
                    preview: op as CommandOperationPreview,
                };
                await this.executeRunCommand(subId, cmdRequest);
            } else if ("path" in op && typeof op.path === "string") {
                const filePreview = op as FileOperationPreview;
                const opType = filePreview.type === "delete" ? "delete_file" : filePreview.type === "rename" ? "rename_file" : "write_file";
                const fileRequest: PermissionRequest = {
                    __permission_required: true,
                    operation: opType,
                    preview: filePreview,
                };
                if (opType === "delete_file") await this.executeDeleteFile(fileRequest);
                else if (opType === "rename_file") await this.executeRenameFile(fileRequest);
                else await this.executeWriteFile(fileRequest);
            }
        }
    }

    private async executeUpdateDiagram(request: PermissionRequest): Promise<void> {
        const preview = request.preview as DiagramUpdatePreview;

        if (!this.workspaceId) {
            throw new Error("Cannot update diagram: workspace ID not set");
        }

        logger.log(`[executeUpdateDiagram] Regenerating diagram for workspace ${this.workspaceId}`, {
            type: preview.type,
            components: preview.components,
            description: preview.description,
        });

        // Import DiagramManager dynamically to avoid circular dependencies
        const { DiagramManager } = await import("../../../lib/DiagramManager");

        // Regenerate diagram with focus on affected components
        await DiagramManager.regenerateForWorkspace(this.workspaceId, {
            focusComponents: preview.components,
            context: preview.description,
        });

        logger.log(`[executeUpdateDiagram] Diagram regenerated successfully`);
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
        const maxOutputBytes = Math.min(
            300_000,
            Math.max(1024, Number((preview as { max_output_bytes?: number }).max_output_bytes) || 80_000),
        );
        this.commandOutputMaxBytes.set(operationId, maxOutputBytes);
        const workingDir = preview.workingDirectory
            ? path.isAbsolute(preview.workingDirectory)
                ? preview.workingDirectory
                : path.join(this.workspacePath, preview.workingDirectory)
            : this.workspacePath;

        const normalizedWorkspace = path.resolve(this.workspacePath);
        const normalizedWorking = path.resolve(workingDir);
        if (path.isAbsolute(preview.workingDirectory || "") && normalizedWorking !== normalizedWorkspace) {
            const rel = path.relative(normalizedWorkspace, normalizedWorking);
            if (rel.startsWith("..") || path.isAbsolute(rel)) {
                this.allowedRoots.add(normalizedWorking);
            }
        }
        const cdMatch = preview.command.match(/^cd\s+([^\s;&|]+)/);
        if (cdMatch && path.isAbsolute(cdMatch[1])) {
            const cdRoot = path.resolve(workingDir, cdMatch[1]);
            const relCd = path.relative(normalizedWorkspace, cdRoot);
            if (relCd.startsWith("..") || path.isAbsolute(relCd)) {
                this.allowedRoots.add(cdRoot);
            }
        }

        // Normalize command: strip "cd /workspace && " or "cd /workspace; " so it runs in workingDir (workspace root).
        // /workspace is a generic path that often doesn't exist on the host; the shell is already in the workspace.
        let commandToRun = preview.command;
        const workspaceCdStrip = /^cd\s+\/workspace(?:\/[^\s;&|]*)?\s*(?:&&|;)\s*/;
        if (workspaceCdStrip.test(preview.command)) {
            commandToRun = preview.command.replace(workspaceCdStrip, "").trim() || "true";
            logger.log(`[executeRunCommand] Stripped 'cd /workspace' prefix (shell already in workspace); running: ${commandToRun}`);
        }

        // Dev servers get 10 seconds to start; other commands use timeout_ms from preview (default 2 min).
        const isDevServerCommand = this.isDevServerCommand(commandToRun);
        const requestedTimeout = Math.min(
            1_800_000,
            Math.max(1000, Number((preview as { timeout_ms?: number }).timeout_ms) || 120_000),
        );
        const timeoutMs = isDevServerCommand ? 10 * 1000 : requestedTimeout;
        const startTime = Date.now();

        logger.log(`[executeRunCommand] Running: ${commandToRun} in ${workingDir} (timeout: ${timeoutMs}ms${isDevServerCommand ? ', dev-server' : ''})`);

        // Audit log for dangerous commands (rm -rf, sudo, etc.)
        if (preview.isDangerous) {
            logger.warn(`[DANGEROUS-COMMAND-AUDIT] User approved dangerous command | command="${commandToRun}" | cwd="${workingDir}" | explanation="${preview.dangerExplanation ?? 'N/A'}" | timestamp=${new Date().toISOString()}`);
        }

        // Emit that command is starting (use normalized command so UI shows what actually runs)
        this.emit('terminal-output', {
            operationId,
            command: commandToRun,
            output: '',
            status: 'running' as const,
        });

        // Create timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)} seconds`));
            }, timeoutMs);
        });

        await this.runAdvisoryHooks("before_run_command", {
            ATLARIX_COMMAND: commandToRun,
            ATLARIX_WORKING_DIR: workingDir,
        });

        try {
            try {
                // Stream stdout/stderr and emit on each chunk for live tool indicator
                const result = await Promise.race([
                    runShellCommandStreaming(commandToRun, workingDir, {
                        onOutput: ({ stdout, stderr }) => {
                            const output = stdout + (stderr ? `\n${stderr}` : '');
                            this.emit('terminal-output', {
                                operationId,
                                command: commandToRun,
                                output,
                                status: 'running' as const,
                            });
                        },
                    }),
                    timeoutPromise
                ]);

                const duration = Date.now() - startTime;

                // Store output for UI display and AI feedback
                this.commandOutputs.set(operationId, {
                    ...result,
                    // Add duration to result (extending CommandResult)
                } as CommandResult);

                // Emit final output
                this.emit('terminal-output', {
                    operationId,
                    command: commandToRun,
                    output: result.stdout + (result.stderr ? `\n${result.stderr}` : ''),
                    status: result.success ? 'completed' as const : 'error' as const,
                    exitCode: result.exitCode,
                    duration,
                });

                if (result.success) {
                    logger.log(`[executeRunCommand] Success: ${commandToRun} (${(duration / 1000).toFixed(1)}s)`);
                } else {
                    logger.error(`[executeRunCommand] Failed: ${commandToRun} (exit ${result.exitCode})`);
                    if (result.stderr) {
                        logger.error(`[executeRunCommand] stderr: ${result.stderr}`);
                    }
                    // Include stderr in thrown error so user and logs see the real reason
                    const errDetail = result.stderr
                        ? `\n\n${result.stderr.slice(0, 500)}`
                        : (result.stdout ? `\n\n${result.stdout.slice(0, 200)}` : "");
                    throw new Error(`Command failed with exit code ${result.exitCode}${errDetail}`);
                }
            } catch (error) {
                const duration = Date.now() - startTime;
                const errorMessage = error instanceof Error ? error.message : String(error);
                const isTimeout = errorMessage.includes('timed out');

                // Dev server timeout = success (server is still running after 10 seconds)
                if (isDevServerCommand && isTimeout) {
                    logger.log(`[executeRunCommand] Dev server started: ${commandToRun} (running in background)`);

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
                        command: commandToRun,
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
                    command: commandToRun,
                    output: errorMessage,
                    status: 'error' as const,
                    exitCode: -1,
                    duration,
                });

                logger.error(`[executeRunCommand] Error: ${commandToRun} - ${errorMessage}`);
                throw error;
            }
        } finally {
            await this.runAdvisoryHooks("after_run_command", {
                ATLARIX_COMMAND: commandToRun,
                ATLARIX_WORKING_DIR: workingDir,
            });
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
