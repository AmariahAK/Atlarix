/**
 * Permission Interceptor
 * ======================
 * Intercepts tool results, buffers permission requests, and executes approved operations.
 * Modeled after StackSense's PermissionHandler + Claude Code's blocking approval.
 * 
 * v0.9.1 Update: Added async waitForApproval() blocking mechanism
 */

import * as fs from "fs/promises";
import * as fsSync from "node:fs";
import * as path from "path";
import { assertRealpathContained as assertRealpathContainedShared } from "@/lib/security/realpath-contain";
import { recordMutationOutcome } from "@/lib/agent/mutation-verify";
import { wrapUntrustedData } from "@/lib/streaming/untrusted-data";
import log from "electron-log";
import { EventEmitter } from "events";
import { BrowserWindow } from "electron";
import {
    PermissionRequest,
    PermissionResult,
    FileOperationPreview,
    CommandOperationPreview,
    BatchPlanPreview,
    parsePermissionRequest,
} from "../../../lib/tools/permissions/schema";
import {
    runShellCommandStreaming,
    CommandResult,
    type SandboxRunOptions,
} from "../../utils/runShellCommand";
import type { ChildProcess } from "child_process";
import { resolvePathUnderWorkspace } from "../../utils/safeWorkspaceRelativePath";
import {
    listSandboxWritablePaths,
    upsertSandboxWritablePath,
} from "@/lib/file-permissions-store";
import {
    parseSandboxDenialsFromOutput,
    sandboxGrantPath,
} from "@/lib/sandbox/wrap-command";
import { describeSandboxFailureContext } from "@/lib/sandbox/sandbox-failure-context";
import { formatCommandOutput, resolveMaxOutputBytes } from "./command-output";
import { targetPathsForOperation } from "./operation-targets";
import { refreshPlanLedgerFromWrittenFile } from "@/lib/tasks/plan-ledger-from-file";
import { captureSnapshotAcrossRoots } from "../../../lib/snapshot/snapshot-manager";
import { appendLedgerFilesWritten } from "../../../lib/tasks/task-ledger";
import {
    isAlwaysAutoApproveAtlarixRelativePath,
    isAtlarixPlanRelativePath,
} from "../../../lib/tasks/plan-sync";
import { FileUploadsState } from "../../utils/file_uploads_state";
import { clearAllConsoleBuffers } from "../console_debugger";
import { readSettings } from "../../../main/settings";
import { resolveEffectiveWorkMode, isReadOnlyWorkMode } from "@/lib/work-mode";
import {
  openTerminalInstance,
  resolveScopeKey,
} from "../../../lib/terminal-instance-store";
import { isAgentMemoryDisabled, memoryDirFor } from "@/lib/agent-memory";
import { isOutsidePathOnlySystemScope } from "@/lib/system-scope-commands";
import { injectAgentGitIdentity } from "../../utils/git_author";
import { hasConfiguredGitIdentity } from "../../utils/git_utils";

const logger = log.scope("permission-interceptor");

// ════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════════════════════════════════════

// v14.7: the Item-5 grace-then-park window was removed — approvals now BLOCK the
// turn mid-loop until the user decides (see waitForApproval below).

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Three-state result of waiting on a decision (Item 5). */
export type WaitOutcome = "approved" | "rejected" | "undecided";

interface PendingApproval {
    resolve: (outcome: WaitOutcome) => void;
    /** v14.7: undefined for the indefinite mid-loop block (no grace timeout). */
    timeout?: NodeJS.Timeout;
    createdAt: number;
}

interface BufferedOperation {
    id: string;
    request: PermissionRequest;
    status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
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

    /** Per run_command operation: max UTF-8 bytes for formatted output (survives pendingOperations eviction). */
    private commandOutputMaxBytes: Map<string, number> = new Map();

    /** Monotonic id suffix for mid-run sandbox-escalation approval requests. */
    private sandboxEscalationSeq = 0;

    /** Workspace path for resolving file paths */
    private workspacePath: string;

    /** Workspace ID (session tracking, snapshots, blast radius) */
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

    /** When run_command uses an absolute cwd outside workspace, we allow file ops under that path for this session */
    private allowedRoots: Set<string> = new Set();

    /**
     * This project's agent-memory directory, or null when memory is off.
     * Resolved but NOT created — see `ensureMemoryDirForWrite`.
     */
    private memoryDir: string | null = null;

    /** One mkdir per interceptor at most. */
    private memoryDirEnsured = false;

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
        // This project's agent-memory directory is writable.
        //
        // It lives OUTSIDE the repo by design (~/.atlarix/projects/<slug>/memory/)
        // so notes are per-developer and never committed — but that put it on the
        // wrong side of the outside-workspace check below, so every note the agent
        // tried to write threw "Path is outside workspace". The prompt handed it an
        // absolute path and told it to write there, and the harness hard-refused:
        // memory was readable and un-writable, which is exactly the kind of thing
        // the harness must not do silently.
        //
        // Scoped to THIS workspace's slug, so a turn cannot reach another project's
        // notes, and the ordinary approval gate fires — the user sees the diff like
        // any other write. (That last part was NOT true when this was first written:
        // the memory path's relative form contains `/.atlarix/`, which the blanket
        // `.atlarix/**` allowance in shouldAlwaysAutoApprove matched, so notes were
        // landing silently. Fixed there by refusing to auto-approve anything whose
        // relative path leaves the workspace.)
        try {
            if (workspacePath && !isAgentMemoryDisabled()) {
                // NOT created here. The directory is made on the first write that
                // actually targets it (`ensureMemoryDirForWrite`).
                //
                // It used to be `mkdirSync`'d in this constructor, because the
                // realpath containment check below cannot resolve a directory that
                // does not exist and would refuse the first note. But an interceptor
                // is constructed for every workspace path the app ever sees —
                // including the temp workspaces the test suite builds — so this line
                // created 435 empty `…atlarix-grant-XXXXXX…` directories in the
                // developer's real ~/.atlarix/projects. "An empty directory costs
                // nothing" was true per directory and wrong in aggregate: it made the
                // project count meaningless and wrote into a user's home from tests.
                this.memoryDir = path.resolve(memoryDirFor(workspacePath));
                this.allowedRoots.add(this.memoryDir);
            }
        } catch {
            // Memory is optional; never block a turn on it.
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
                // NOTHING outside the workspace is ever blanket auto-approved,
                // whatever it is named.
                //
                // The `.atlarix/**` allowance below is scoped to THIS project's
                // own agent files, but it matched on the substring `/.atlarix/`
                // — and a path outside the workspace renders as `../…`, so
                // `../other-repo/.atlarix/hooks/hooks.json` matched too. A
                // granted directory would therefore have carried silent write
                // access to ANOTHER project's agent config. The same bug already
                // applied to the agent-memory directory, whose relative form is
                // `../../../../.atlarix/projects/<slug>/memory/…`: those writes
                // were landing with no approval card at all, contradicting the
                // interceptor's own claim that the ordinary gate still fires.
                if (rel.startsWith("../") || rel === "..") return false;
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
            case "edit_file":
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
        // Structured object format (the contract — v12 0.4-C1: the legacy
        // "__PERMISSION_REQUIRED__" text fallback was deleted; its last main-
        // process producer, run_tests, now emits the structured envelope).
        if (typeof result === 'object' && result !== null) {
            return (result as any).__permission_required === true;
        }

        // JSON-string form (structured envelope serialized by the registry).
        if (typeof result === 'string') {
            try {
                const parsed = JSON.parse(result);
                return parsed.__permission_required === true;
            } catch {
                return false;
            }
        }

        return false;
    }

    /**
     * Parse and validate a permission request from tool result
     */
    parsePermissionRequest(result: unknown): PermissionRequest | null {
        // Object format (the contract)
        if (typeof result === 'object' && result !== null && (result as any).__permission_required) {
            logger.log('[parsePermissionRequest] Parsed object format');
            return result as PermissionRequest;
        }

        // JSON-string form
        if (typeof result === 'string') {
            const parsed = parsePermissionRequest(result);
            if (parsed) {
                logger.log('[parsePermissionRequest] Parsed JSON string format');
                return parsed;
            }
        }

        return null;
    }


    // ════════════════════════════════════════════════════════════════════════════
    // BUFFERING
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * Generate unique operation ID
     */
    generateOperationId(): string {
        return `op_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    }

    /** Pre-execute writes for batch auto-allow paths (file scope preflight). */
    async preExecuteWritePreviews(previews: FileOperationPreview[]): Promise<void> {
        if (!previews.length) return;
        await this.executeWriteMultipleFiles({
            __permission_required: true,
            operation: "write_multiple_files",
            preview: previews,
        });
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
        for (const [, approval] of this.pendingApprovals) {
            clearTimeout(approval.timeout);
            approval.resolve("rejected"); // Auto-reject on clear
        }
        this.pendingApprovals.clear();
        this.pendingOperations.clear();
        logger.log('[PermissionInterceptor] Cleared all pending operations');
    }

    // ════════════════════════════════════════════════════════════════════════════
    // BLOCKING APPROVAL MECHANISM (NEW in v0.9.1)
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * v14.7 — BLOCK the turn mid-loop until the user decides (Claude-Code model).
     * The wait is **indefinite** (no grace/park): the tool's `execute` stays
     * suspended, so the turn remains one live `streamText` round — the Stop button
     * shows, the model can't emit a premature "done", and on decision the loop
     * continues with the real result. Safe re: connections: the upstream model
     * response already closed at `finish`, so nothing is held open during the wait
     * (see plan Step 0). Resolved by `executeOperation`/`rejectOperation` →
     * `resolveApproval`. Cancelled by the turn's abort signal (Stop), which
     * rejects with the abort reason so `streamText` unwinds cleanly.
     *
     * NOTE: this is the HUMAN-approval gate only — machine waits (sub-agents,
     * `run_command`) keep their own timeouts and are NOT made unbounded here.
     */
    async waitForApproval(
        operationId: string,
        opts?: { abortSignal?: AbortSignal },
    ): Promise<WaitOutcome> {
        return new Promise((resolve, reject) => {
            const abortSignal = opts?.abortSignal;
            const onAbort = () => {
                this.pendingApprovals.delete(operationId);
                reject(
                    abortSignal?.reason instanceof Error
                        ? abortSignal.reason
                        : new DOMException("Approval wait aborted", "AbortError"),
                );
            };
            if (abortSignal) {
                if (abortSignal.aborted) {
                    onAbort();
                    return;
                }
                abortSignal.addEventListener("abort", onAbort, { once: true });
            }
            this.pendingApprovals.set(operationId, {
                resolve: (outcome) => {
                    if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
                    resolve(outcome);
                },
                // No grace timeout — indefinite block.
                createdAt: Date.now(),
            });
            logger.log(`[waitForApproval] Blocking (indefinite) for user response on ${operationId}`);
        });
    }

    /**
     * Resolve an approval (called when user clicks Approve/Reject). No-op if the
     * grace window already expired (the op parked) — the decision is then handled
     * by the IPC handler executing/rejecting the still-pending op directly.
     */
    private resolveApproval(operationId: string, approved: boolean): void {
        const pending = this.pendingApprovals.get(operationId);
        if (pending) {
            if (pending.timeout) clearTimeout(pending.timeout);
            pending.resolve(approved ? "approved" : "rejected");
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
    async executeOperation(
        operationId: string,
        options?: { overrideContent?: string },
    ): Promise<PermissionResult> {
        const operation = this.pendingOperations.get(operationId);
        if (!operation) {
            return {
                operationId,
                approved: false,
                error: `Operation ${operationId} not found`,
            };
        }

        const request = operation.request;

        // v10 per-hunk approval: the user accepted only some hunks — write the
        // composed partial content instead of the full proposal. Persisted on
        // the preview so result reporting + per-turn revert reflect what was
        // actually written.
        const CONTENT_WRITE_OPS = new Set([
            "write_file",
            "edit_file",
            "replace_code",
            "insert_code",
            "delete_lines",
        ]);
        if (
            typeof options?.overrideContent === "string" &&
            CONTENT_WRITE_OPS.has(request.operation)
        ) {
            const preview = request.preview as FileOperationPreview;
            if (preview && typeof preview === "object") {
                preview.content = options.overrideContent;
                logger.log(
                    `[executeOperation] per-hunk override applied for ${operationId} (${request.operation})`,
                );
            }
        }

        // NOTE: Do NOT resolve approval here! We wait until execution completes.
        // This ensures the AI doesn't continue until the command is done.

        try {
            operation.status = 'approved';

            // Emit running status for queue UI
            this.emitStatus(operationId, 'running');

            // Cross-workspace writes: ask ONCE for the folder, then proceed.
            //
            // This used to throw here — after the user had already read and
            // approved the diff — telling them to re-import the folder as the
            // project. Commands have had escalate-and-grant since v14.15.0; file
            // edits just never got it, so `edit_file`'s own description promising
            // absolute paths "including outside the workspace" was a claim the
            // harness refused to honour.
            await this.ensureOutsideTargetsGranted(
                operationId,
                targetPathsForOperation(request),
            );

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
                case "edit_file":
                case "replace_code":
                case "insert_code":
                case "delete_lines":
                    await this.executeWriteFile(request);
                    break;
                // Parent-aggregated: execute each sub-operation in order (v2.2)
                case "batch_plan":
                    await this.executeBatchPlan(operationId, request);
                    break;
                case "revert_project_snapshot":
                    await this.executeRevertProjectSnapshot(request);
                    break;
                case "sandbox_escalation":
                    // No execution: approving only unblocks waitForApproval so the
                    // originating command can grant the denied path + retry (see
                    // maybeEscalateSandboxDenial). resolveApproval(true) fires below.
                    break;
                default:
                    throw new Error(`Unknown operation: ${request.operation}`);
            }

            // Mark as executed
            operation.status = 'executed';

            // Emit completed status - frontend will clear all errors (todo approach)
            this.emitStatus(operationId, 'completed');

            logger.log(`[executeOperation] Executed ${operationId}: ${request.operation}`);

            // Edit-file verifier (B1): the write landed. Clear any prior mutation
            // failure for the turn so the completion gate (mutation-verify) won't
            // hold the model back. Failures are recorded in the catch below.
            if (this.snapshotTurnId && CONTENT_WRITE_OPS.has(request.operation)) {
              recordMutationOutcome(this.snapshotTurnId, true);
            }

            const preview = request.preview as FileOperationPreview;

            // v13.8: write_file folded into edit_file (operation:"write"), so the
            // ATLARIX_PLAN.md / .atlarixignore detection keys off any content write.
            if (this.workspaceId && (CONTENT_WRITE_OPS.has(request.operation) || request.operation === "write_multiple_files")) {
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
                    if (
                        norm === ".atlarix/.atlarixignore" ||
                        norm.endsWith("/.atlarix/.atlarixignore") ||
                        norm === ".atlarixignore" ||
                        norm.endsWith("/.atlarixignore")
                    ) {
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

            // Edit-file verifier (B1): the write genuinely failed — record it so
            // the completion gate refuses to finish on an unapplied edit
            // (bounded; the model is nudged to fix and retry first).
            if (this.snapshotTurnId && CONTENT_WRITE_OPS.has(request.operation)) {
              recordMutationOutcome(
                this.snapshotTurnId,
                false,
                `Your ${request.operation} did not apply (${errorMessage}). Re-check the file/path and retry the edit before finishing.`,
              );
            }

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
        operation?: string;
        oldContent?: string;
        newContent?: string;
        command?: string;
        verified?: boolean;
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
                    // Model-facing only (no UI consumer of getExecutionResult):
                    // command output is untrusted — frame it as data. Harness control
                    // messages (e.g. a background-job start notice) are trusted → not wrapped.
                    output: cmdResult.harnessMessage
                        ? formatCommandOutput(cmdResult.stdout, cmdResult.stderr, maxB)
                        : wrapUntrustedData(
                              "command-output",
                              formatCommandOutput(cmdResult.stdout, cmdResult.stderr, maxB),
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
                    // Carry the command string so the chat thread can render a
                    // PERSISTENT command+output+exit card (not just transient output).
                    const cmdPreview = operation.request.preview as { command?: string } | undefined;
                    const base = {
                        success: cmdResult.success,
                        command: typeof cmdPreview?.command === "string" ? cmdPreview.command : undefined,
                        // Untrusted command output framed as data so the MODEL treats it
                        // as data, not instructions. This same string is persisted and
                        // reaches the UI; the chat display path strips the envelope
                        // (stripUntrustedDataEnvelope) so the user sees only the output.
                        // A harness control message (bg-job start notice) is trusted → not wrapped.
                        output: cmdResult.harnessMessage
                            ? formatCommandOutput(cmdResult.stdout, cmdResult.stderr, maxOutBytes)
                            : wrapUntrustedData(
                                  "command-output",
                                  formatCommandOutput(cmdResult.stdout, cmdResult.stderr, maxOutBytes),
                              ),
                        exitCode: cmdResult.exitCode,
                        error: cmdResult.success ? undefined : cmdResult.stderr.slice(0, 500),
                    };
                    return base;
                }
            }

            const preview = operation.request.preview as FileOperationPreview | undefined;
            const path = preview?.path;
            const fileOps = new Set([
                "write_file",
                "write_multiple_files",
                "edit_file",
                "replace_code",
                "insert_code",
                "delete_lines",
            ]);
            if (path && fileOps.has(operation.request.operation)) {
                const opType =
                    preview.type === "create"
                        ? "create"
                        : preview.type === "delete"
                          ? "delete"
                          : "update";
                return {
                    success: true,
                    path,
                    operation: opType,
                    oldContent: preview.oldContent ?? "",
                    newContent: preview.content ?? "",
                    // Did the on-disk bytes match what we intended (set in
                    // executeWriteFile)? Consumed by the self-review gate.
                    ...(typeof preview.verified === "boolean" ? { verified: preview.verified } : {}),
                    // Audit note (e.g. edit_file fuzzy-match drift) — flows to
                    // the model via jsonAfterSuccessfulExec's `output`.
                    ...(preview.notice ? { output: preview.notice } : {}),
                };
            }
            if (path) {
                return { success: true, path };
            }
            return { success: true };
        }

        if (operation.status === 'rejected') {
            return {
                success: false,
                error:
                    'Permission denied by user. Do not retry the same operation — adjust the approach, or use ask_user to clarify what the user wants instead.',
            };
        }

        if (operation.status === 'failed') {
            // Include command error output if available
            const cmdResult = this.commandOutputs.get(operationId);
            if (cmdResult) {
                return {
                    success: false,
                    output: formatCommandOutput(
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
            return resolveMaxOutputBytes(
                (p as { max_output_bytes?: number }).max_output_bytes,
            );
        }
        return resolveMaxOutputBytes(undefined);
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
        // FIX 2 (v0.9.15): Clear CDP console buffers to prevent stale errors
        // This sends Console.clearMessages via CDP and notifies renderer
        // ════════════════════════════════════════════════════════════════════
        clearAllConsoleBuffers();

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

    /** Absolute targets a file operation is about to touch (empty for non-file ops). */
    /**
     * For every target outside the workspace, ask the user once for its PARENT
     * DIRECTORY and persist the grant. Throws if they decline.
     *
     * Directory granularity (not per file) is the whole point — it is what every
     * comparable harness does, and per-file prompting was the actual complaint.
     * The grant lands in the same store the command sandbox reads, so one answer
     * covers both lanes.
     */
    private async ensureOutsideTargetsGranted(
        operationId: string,
        targets: readonly string[],
    ): Promise<void> {
        if (targets.length === 0) return;

        const workspaceReal = path.resolve(this.workspacePath);
        const isOutside = (abs: string): boolean => {
            const rel = path.relative(workspaceReal, abs);
            return rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel));
        };
        const alreadyGranted = (abs: string): boolean =>
            this.writableRoots().some((root) => {
                const rel = path.relative(root, abs);
                return !rel.startsWith("..") && !path.isAbsolute(rel);
            });

        // De-duplicate by grant directory so a 12-file batch in one folder asks once.
        const needed = new Map<string, string>();
        for (const raw of targets) {
            if (!path.isAbsolute(raw)) continue;
            const abs = path.resolve(raw);
            if (!isOutside(abs) || alreadyGranted(abs)) continue;
            // A DIRECTORY target (a command's cwd) is granted as itself; a FILE
            // target is granted via its parent so sibling files in the same folder
            // do not each raise their own prompt. `sandboxGrantPath` handles the
            // broad-root case, narrowing to the exact path rather than handing
            // over all of `$HOME`.
            let isDir = false;
            try {
                isDir = fsSync.statSync(abs).isDirectory();
            } catch {
                // Doesn't exist yet — a file about to be created. Parent it is.
            }
            const grantPath = isDir ? abs : sandboxGrantPath(abs);
            if (!needed.has(grantPath)) needed.set(grantPath, abs);
        }
        if (needed.size === 0) return;

        for (const [grantPath, example] of needed) {
            const escalationId = `${operationId}:dir:${++this.sandboxEscalationSeq}`;
            this.bufferOperation(escalationId, {
                __permission_required: true,
                operation: "sandbox_escalation",
                preview: {
                    kind: "file",
                    deniedPath: example,
                    grantPath,
                    description: `Give Atlarix write access to ${grantPath} for this workspace?`,
                    // Automations already hard-deny on systemScope, naming
                    // "outside-workspace write" as the reason — so an unattended
                    // run can never grant itself a new folder.
                    systemScope: true,
                },
            } as unknown as PermissionRequest);

            let outcome: WaitOutcome;
            try {
                outcome = await this.waitForApproval(escalationId);
            } catch {
                this.pendingOperations.delete(escalationId);
                throw new Error(`Write to ${example} cancelled.`);
            }
            this.pendingOperations.delete(escalationId);
            if (outcome !== "approved") {
                throw new Error(
                    `Write to ${example} declined — ${grantPath} is outside this workspace and was not granted.`,
                );
            }
            if (this.workspaceId != null) {
                upsertSandboxWritablePath(this.workspaceId, grantPath);
            } else {
                // No workspace row to persist against (ephemeral/headless): keep
                // the grant for this session only rather than dropping it.
                this.allowedRoots.add(grantPath);
            }
        }
    }

    /**
     * Resolve a file path so it is under this.workspacePath or under an allowed root (from run_command absolute cwd).
     * - Relative paths: joined with workspacePath (current behavior).
     * - Absolute paths: allowed if inside workspacePath or inside any allowedRoot; otherwise throws.
     */
    private resolvePathWithinWorkspace(filePath: string): string {
        const normalizedWorkspace = path.resolve(this.workspacePath);
        let resolved: string;
        if (!path.isAbsolute(filePath)) {
            resolved = resolvePathUnderWorkspace(this.workspacePath, filePath);
        } else {
            resolved = path.resolve(filePath);
            const relativeToWorkspace = path.relative(normalizedWorkspace, resolved);
            const inWorkspace =
                !relativeToWorkspace.startsWith("..") && !path.isAbsolute(relativeToWorkspace);
            const inAllowedRoot = this.writableRoots().some((root) => {
                const relativeToRoot = path.relative(root, resolved);
                return !relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot);
            });
            if (!inWorkspace && !inAllowedRoot) {
                throw new Error(
                    `Path is outside workspace: ${filePath}. Grant this folder from Settings → Workflow, or the agent can ask for it when it needs one.`
                );
            }
        }
        // The memory directory is created on demand, right before the containment
        // check that needs it to exist (it realpaths every allowed root and SKIPS
        // the ones it cannot resolve, which would silently refuse the first note).
        this.ensureMemoryDirForWrite(resolved);
        // A9/M-2: the string containment above is symlink-blind. Verify the REAL
        // target (resolving symlinks in the path) still lands inside the real
        // workspace/allowed roots — else a symlink committed into the repo could
        // point edit_file/write_file/delete at `~/.zshrc` while the card shows an
        // in-workspace path. Both sides are realpath'd so macOS /var→/private/var
        // symlinks don't cause false rejections; any realpath error fails OPEN.
        this.assertRealpathContained(resolved, normalizedWorkspace, filePath);
        return resolved;
    }

    /**
     * Create this project's memory directory the first time a write actually targets
     * it — never for a workspace whose agent simply never wrote a note.
     */
    private ensureMemoryDirForWrite(resolved: string): void {
        if (!this.memoryDir || this.memoryDirEnsured) return;
        const rel = path.relative(this.memoryDir, resolved);
        if (rel.startsWith("..") || path.isAbsolute(rel)) return;
        try {
            fsSync.mkdirSync(this.memoryDir, { recursive: true });
            this.memoryDirEnsured = true;
        } catch {
            // Memory is optional; never block a turn on it.
        }
    }

    /** Reject when the real (symlink-resolved) target escapes the workspace.
     * Delegates to the shared helper so reads (read_file/glob) and writes agree. */
    private assertRealpathContained(
        resolved: string,
        normalizedWorkspace: string,
        original: string,
    ): void {
        assertRealpathContainedShared(resolved, normalizedWorkspace, this.writableRoots(), original);
    }

    /**
     * Every root this workspace may write outside itself: session-scoped roots
     * (agent memory, an approved system-scope `cd`) UNION the user's persisted
     * folder grants.
     *
     * Read from the DB on each call rather than cached at construction, so a
     * revoke in Settings takes effect on the very next write instead of the next
     * session. Only reached when a path already failed the in-workspace check, so
     * the query does not run on ordinary edits.
     *
     * This is also what makes commands and file edits agree: `buildRunCommandSandbox`
     * already feeds the same rows into `extraWritablePaths`. Before this, the two
     * lanes kept disjoint lists — a folder granted to a command was still refused
     * to `edit_file`, and vice versa.
     */
    private writableRoots(): string[] {
        const roots = [...this.allowedRoots];
        if (this.workspaceId == null) return roots;
        try {
            for (const p of listSandboxWritablePaths(this.workspaceId)) {
                if (p) roots.push(path.resolve(p));
            }
        } catch (e) {
            logger.warn(
                `[writable-roots] could not read granted folders: ${e instanceof Error ? e.message : String(e)}`,
            );
        }
        return roots;
    }

    private toWorkspaceRelativePosix(filePath: string): string {
        const full = this.resolvePathWithinWorkspace(filePath);
        const rel = path.relative(this.workspacePath, full);
        return rel.split(path.sep).join("/");
    }

    /**
     * Capture pre-write file state for this turn, in the workspace AND in any granted
     * folder it touched.
     *
     * Requires `snapshotTurnId` (see field doc). `captureSnapshot` itself does not read
     * chatId; gating is entirely whether the stream passed a turn id into this interceptor.
     *
     * Outside paths used to be DROPPED here, because `captureSnapshot` stages a batch with
     * one `git add -f --` at `cwd = workspace` and git aborts the entire invocation on a
     * path outside its work-tree — so a single granted-folder file in a multi-file write
     * destroyed the pre-write snapshot of every in-workspace file beside it, and Revert
     * then reported success having restored fewer files than it claimed. Dropping them
     * fixed that, at the cost of cross-repo edits silently having no Revert.
     *
     * `captureSnapshotAcrossRoots` removes the cost: each root is snapshotted against its
     * OWN work-tree, so no path is ever outside the repo git is being asked about. Only
     * granted roots are eligible — a path outside every grant could not have been written
     * by an approved edit, and is dropped as before.
     */
    private async maybeCaptureWorkspaceSnapshot(relativePaths: string[]): Promise<void> {
        if (!this.snapshotTurnId || !this.workspacePath) return;
        const paths = relativePaths
            .map((p) => p.split(path.sep).join("/"))
            .filter(Boolean);
        if (paths.length === 0) return;
        try {
            await captureSnapshotAcrossRoots({
                workspacePath: this.workspacePath,
                turnId: this.snapshotTurnId,
                paths,
                grantedRoots: this.writableRoots(),
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
        // Ensure directory exists
        await fs.mkdir(path.dirname(fullPath), { recursive: true });

        // Write file
        const intended = preview.content || "";
        await fs.writeFile(fullPath, intended, "utf-8");
        logger.log(`Wrote file: ${fullPath}`);
        // Self-recheck: re-read the bytes we just wrote and confirm they landed.
        // Near-always true, but catches a truncated/failed write that didn't
        // throw. Silent on success; a false here is surfaced ONLY at the
        // end-of-turn task_complete gate (no per-edit token cost).
        try {
            const onDisk = await fs.readFile(fullPath, "utf-8");
            preview.verified = onDisk === intended;
        } catch {
            preview.verified = false;
        }
        if (this.snapshotTurnId) {
            appendLedgerFilesWritten(this.snapshotTurnId, [
                this.toWorkspaceRelativePosix(preview.path),
            ]);
        }
        if (isAtlarixPlanRelativePath(rel)) {
            await refreshPlanLedgerFromWrittenFile({
                workspaceId: this.workspaceId,
                workspacePath: this.workspacePath,
                activeChatId: this.activeChatId,
                fullPath,
                rel,
            });
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
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, preview.content || "", "utf-8");
            logger.log(`Wrote file: ${fullPath}`);
            relPaths.push(rel);
            if (isAtlarixPlanRelativePath(rel)) {
                await refreshPlanLedgerFromWrittenFile({
                workspaceId: this.workspaceId,
                workspacePath: this.workspacePath,
                activeChatId: this.activeChatId,
                fullPath,
                rel,
            });
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

    /**
     * Build the per-OS sandbox options for an agent run_command, or undefined to
     * run unsandboxed. Default ON; disabled by `sandboxRunCommand: false` in
     * settings or the `ATLARIX_DISABLE_SANDBOX` env var. Confines writes to the
     * workspace + caches; the wrapper itself falls back gracefully if the OS tool
     * is missing (unless `enforce`).
     */
    private buildRunCommandSandbox(preview?: CommandOperationPreview): SandboxRunOptions | undefined {
        if (process.env.ATLARIX_DISABLE_SANDBOX === "1") return undefined;
        // A human-approved system-scope command runs UNSANDBOXED — but only when
        // it is system-scope for a reason the sandbox cannot express.
        //
        // An installer (`brew install`, `npm -g`, `sudo …`) writes places nobody
        // can enumerate up front, so the boundary genuinely has to come off. A
        // command that is system-scope ONLY because it touches a path outside the
        // workspace is a different thing entirely: that path is known, the user
        // now grants it explicitly per directory, and it reaches the sandbox via
        // `extraWritablePaths` below. Dropping the sandbox for that case handed an
        // approved outside-path command unrestricted write access to the whole
        // disk — far more than the card asked for. Codex widens `writable_roots`
        // rather than disabling its sandbox; this is the same move.
        if (
            preview?.systemScopeInteractive === true &&
            !(
                preview.command &&
                this.workspacePath &&
                isOutsidePathOnlySystemScope(preview.command, this.workspacePath)
            )
        ) {
            return undefined;
        }
        const settings = readSettings();
        if (settings.sandboxRunCommand === false) return undefined;
        if (!this.workspacePath) return undefined;
        const cfg = settings.sandboxRunCommandConfig;
        // Read-only work modes (Explore/Plan/Review) run commands in a read-only
        // sandbox — the OS denies workspace-source writes, replacing the old
        // command-string mutation classifier. Build/Debug get workspace-write.
        const workMode = resolveEffectiveWorkMode({
            intentMode: settings.intentMode,
            workModePreference: settings.workModePreference,
            selectedChatMode: settings.selectedChatMode ?? "ask",
        });
        // Global settings paths + per-workspace paths the user granted via
        // escalation-on-denial (stored on workspaceFilePermissions/sandbox_path).
        const workspaceGranted =
            this.workspaceId != null ? listSandboxWritablePaths(this.workspaceId) : [];
        const extraWritablePaths = [
            ...(cfg?.extraWritablePaths ?? []),
            ...workspaceGranted,
        ];
        return {
            workspacePath: this.workspacePath,
            extraWritablePaths: extraWritablePaths.length > 0 ? extraWritablePaths : undefined,
            enforce: cfg?.enforce === true,
            readOnly: isReadOnlyWorkMode(workMode),
        };
    }

    /** Run one sandboxed attempt of a command, streaming output to `operationId`. */
    private runSandboxedOnce(
        command: string,
        workingDir: string,
        sandbox: SandboxRunOptions,
        operationId: string,
    ): Promise<CommandResult> {
        return runShellCommandStreaming(command, workingDir, {
            sandbox,
            onOutput: ({ stdout, stderr }) => {
                this.emit("terminal-output", {
                    operationId,
                    command,
                    output: stdout + (stderr ? `\n${stderr}` : ""),
                    status: "running" as const,
                    background: false,
                });
            },
        })
            .then((r) => r as CommandResult)
            .catch((err) => ({
                stdout: "",
                stderr: err instanceof Error ? err.message : String(err),
                exitCode: -1,
                success: false,
            }));
    }

    /**
     * Escalation-on-denial: when a sandboxed command failed on a WRITE the OS
     * denied to a path outside the writable set (e.g. an unlisted toolchain's
     * cache), raise an approval card; if the user grants it, persist the path for
     * this workspace and RE-RUN the command — still sandboxed. Returns the retried
     * result, or null when there is nothing to escalate / the user declined.
     * Bounded so a command that keeps hitting new denials can't loop forever.
     */
    private async maybeEscalateSandboxDenial(
        result: CommandResult,
        ctx: {
            commandToRun: string;
            workingDir: string;
            sandboxOpts: SandboxRunOptions | undefined;
            operationId: string;
        },
    ): Promise<CommandResult | null> {
        const { commandToRun, workingDir, sandboxOpts, operationId } = ctx;
        if (!sandboxOpts) return null; // no sandbox applied → nothing to grant

        const granted = new Set(sandboxOpts.extraWritablePaths ?? []);
        const workspaceReal = this.workspacePath;
        const isSkippable = (p: string): boolean =>
            granted.has(p) ||
            !!(workspaceReal && (p === workspaceReal || p.startsWith(workspaceReal + path.sep)));

        let queue = parseSandboxDenialsFromOutput(
            `${result.stderr ?? ""}\n${result.stdout ?? ""}`,
        ).filter((d) => !isSkippable(d.grantPath));
        if (queue.length === 0) return null;

        let current = sandboxOpts;
        let retried: CommandResult | null = null;
        const MAX_ESCALATIONS = 5;

        for (let i = 0; i < MAX_ESCALATIONS && queue.length > 0; i++) {
            const denial = queue.shift() as { deniedPath: string; grantPath: string };
            if (isSkippable(denial.grantPath)) continue;

            const escalationId = `${operationId}:sbx:${++this.sandboxEscalationSeq}`;
            this.bufferOperation(escalationId, {
                __permission_required: true,
                operation: "sandbox_escalation",
                preview: {
                    command: commandToRun,
                    deniedPath: denial.deniedPath,
                    grantPath: denial.grantPath,
                    description: `The command sandbox blocked a write to ${denial.deniedPath}. Grant it write access to ${denial.grantPath} for this workspace and retry?`,
                    workingDirectory: workingDir,
                },
            });

            let outcome: WaitOutcome;
            try {
                outcome = await this.waitForApproval(escalationId);
            } catch {
                this.pendingOperations.delete(escalationId);
                return retried; // turn stopped mid-wait
            }
            this.pendingOperations.delete(escalationId);
            if (outcome !== "approved") return retried; // user declined this path

            if (this.workspaceId != null) {
                try {
                    upsertSandboxWritablePath(this.workspaceId, denial.grantPath);
                } catch (e) {
                    logger.warn(
                        `[sandbox-escalation] persist failed: ${e instanceof Error ? e.message : String(e)}`,
                    );
                }
            }
            granted.add(denial.grantPath);
            current = {
                ...current,
                extraWritablePaths: [...(current.extraWritablePaths ?? []), denial.grantPath],
            };

            retried = await this.runSandboxedOnce(commandToRun, workingDir, current, operationId);
            if (retried.success) return retried;

            // Still failing — queue any genuinely NEW denials for the next round.
            const fresh = parseSandboxDenialsFromOutput(
                `${retried.stderr ?? ""}\n${retried.stdout ?? ""}`,
            ).filter((d) => !isSkippable(d.grantPath));
            queue = fresh;
        }
        return retried;
    }

    /**
     * Execute a shell command and store output.
     * Emits 'terminal-output' event for UI updates.
     * Includes timeout protection and progress updates for long-running commands.
     */
    private async executeRunCommand(operationId: string, request: PermissionRequest): Promise<void> {
        const preview = request.preview as CommandOperationPreview;
        const maxOutputBytes = Math.min(
            1_000_000,
            Math.max(1024, Number((preview as { max_output_bytes?: number }).max_output_bytes) || 80_000),
        );
        this.commandOutputMaxBytes.set(operationId, maxOutputBytes);
        const workingDir = preview.workingDirectory
            ? path.isAbsolute(preview.workingDirectory)
                ? preview.workingDirectory
                : path.join(this.workspacePath, preview.workingDirectory)
            : this.workspacePath;

        // DELETED: inferring write scope from a `cd` prefix or an absolute cwd.
        //
        // This regex-matched `^cd <abs>` in the model's own command string and
        // added that directory to `allowedRoots` — an implicit, invisible,
        // permanent-for-the-session grant derived from text the MODEL wrote. No
        // comparable harness does this. Claude Code changes the working directory
        // only through the user's `/cd`, grants roots only through `/add-dir`, and
        // explicitly tells the model a `cd` did not take effect. opencode parses
        // the command and raises its `external_directory` permission for any
        // outside path a `cd`/`rm`/`cp`/… touches. Codex lets the OS sandbox hold
        // the line wherever the command chdir's to. Cursor uses configured
        // workspace roots. In every one of them, a `cd` grants nothing.
        //
        // It is also redundant here twice over: writes are confined by the OS
        // sandbox, and folders outside the workspace now have an explicit,
        // per-directory, revocable grant (Settings → Workflow) that both file
        // edits and commands read. Scope comes from the user, never from a string
        // the model emitted.
        const normalizedWorkspace = path.resolve(this.workspacePath);
        const normalizedWorking = path.resolve(workingDir);

        // An explicit cwd OUTSIDE the workspace goes through the same
        // per-directory grant a cross-repo `edit_file` does: asked once, stored
        // once, revocable in one place. Same answer as opencode's
        // `external_directory` ask and Claude Code's `/add-dir`, reached through
        // the machinery already here rather than a second private path.
        {
            const rel = path.relative(normalizedWorkspace, normalizedWorking);
            if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
                await this.ensureOutsideTargetsGranted(operationId, [normalizedWorking]);
                // Grant recorded (or the user declined and this threw) — the
                // command still runs sandboxed; the granted dir reaches the
                // sandbox through extraWritablePaths in buildRunCommandSandbox.
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


        // Commits are authored by the user's own git config (Atlarix is credited
        // via the co-author trailer only). Fall back to attributing a bare
        // `git commit` to the agent identity ONLY when the machine has no git
        // identity configured, so the commit still succeeds instead of failing.
        if (
            /\bgit\s+commit\b/.test(commandToRun) &&
            !(await hasConfiguredGitIdentity(workingDir))
        ) {
            const withAgentIdentity = injectAgentGitIdentity(commandToRun);
            if (withAgentIdentity !== commandToRun) {
                logger.log(`[executeRunCommand] No git identity configured — injected agent identity into commit command`);
                commandToRun = withAgentIdentity;
            }
        }

        // NOTE: there is no longer a "dangerous command" hard-floor throw here.
        // Danger is handled entirely by the regular permission gate up front
        // (resolveRunCommandPermissionGate): a dangerous command without an
        // explicit always-allow returns `prompt`, so it can only reach this point
        // via a user approval or a user-set always-allow (keyed by its danger
        // pattern). Reaching execute means it was consented to.

        // v14 pt3: NO kill-timeout. A command still running at PROMOTE_AFTER_MS is
        // MOVED to the background (kept alive, tracked, cancellable) — not killed.
        // `background:true` promotes immediately. Dev servers are no longer
        // special-cased; the timer subsumes the old 10s/120s paths so any
        // long-running command (server, watcher, big build) persists.
        const PROMOTE_AFTER_MS = 15_000;
        const startTime = Date.now();
        const explicitBackground =
            (preview as { background?: boolean }).background === true;
        // v14.8.10: opt-in wake condition (wake when the job's output matches).
        const wakeOn = (
            preview as { wake_on?: { pattern: string; regex?: boolean } }
        ).wake_on;
        const allowStalled =
            (preview as { allow_stalled?: boolean }).allow_stalled === true;

        logger.log(
            `[executeRunCommand] Running: ${commandToRun} in ${workingDir}` +
            (explicitBackground ? " (background)" : ` (promote after ${PROMOTE_AFTER_MS}ms)`),
        );

        const scopeKey = resolveScopeKey(this.activeChatId, this.workspaceId);
        // Foreground commands share one tab; a detached job gets its own so its
        // output doesn't interleave into the session the agent is reading.
        //
        // No longer returns a failure: dropping the 3-agent-terminal cap removed
        // the only way this could refuse. That cap used to reject the fourth
        // terminal and the rejection was discarded here, so the command ran with
        // nowhere to show its output.
        openTerminalInstance(scopeKey, {
          owner: "agent",
          operationId,
          commandHint: commandToRun,
          background: explicitBackground,
          // Explicit target from run_command({terminal:"…"}) — created once under
          // that name, reused on every later call.
          terminal: (preview as { terminal?: string }).terminal,
        });

        // Audit log for dangerous commands (rm -rf, sudo, etc.)
        if (preview.isDangerous) {
            logger.warn(`[DANGEROUS-COMMAND-AUDIT] User approved dangerous command | command="${commandToRun}" | cwd="${workingDir}" | explanation="${preview.dangerExplanation ?? 'N/A'}" | timestamp=${new Date().toISOString()}`);
        }
        if (preview.systemScopeInteractive === true) {
            logger.warn(`[SYSTEM-SCOPE-AUDIT] User approved a system-scope command (runs unsandboxed) | command="${commandToRun}" | cwd="${workingDir}" | explanation="${preview.systemScopeExplanation ?? 'N/A'}" | timestamp=${new Date().toISOString()}`);
        }

        // Per-OS write-confining sandbox (workspace + caches writable, network on).
        // Applies to agent run_command only — never the user's PTY tabs.
        // An interactively-approved system-scope command runs unsandboxed (see builder).
        const sandboxOpts = this.buildRunCommandSandbox(preview);

        this.emit('terminal-output', {
            operationId,
            command: commandToRun,
            output: '',
            status: 'running' as const,
            background: explicitBackground,
        });

        const chatIdForBg = this.activeChatId;
        const bg = await import("@/lib/agent/background-commands");

        let proc: ChildProcess | null = null;
        let accOutput = '';
        let promoted = false;
        let finished = false;
        let thrownError: Error | null = null;
        let resolveExec: () => void = () => {};
        const execDone = new Promise<void>((res) => { resolveExec = res; });

        // Move a still-running command to the background: keep the process alive,
        // register it as a cancellable background job, and resolve the model's
        // tool call now with the job id. Its eventual exit is delivered via the
        // background-result path (prepareStep mid-turn / auto-wake when idle).
        const promote = (reason: 'explicit' | 'timer') => {
            if (promoted || finished) return;
            promoted = true;
            if (chatIdForBg != null) {
                bg.recordBackgroundCommandStart(chatIdForBg, operationId, commandToRun, startTime, wakeOn, allowStalled);
                if (proc) bg.registerBackgroundProc(chatIdForBg, operationId, proc);
                // No longer a foreground (cancel-on-turn-stop) child.
                bg.clearForegroundProc(chatIdForBg, operationId);
                bg.updateBackgroundOutput(chatIdForBg, operationId, accOutput);
            }
            const head = reason === 'explicit'
                ? `Background command started (job_id: ${operationId}): ${commandToRun}`
                : `Still running after ${PROMOTE_AFTER_MS / 1000}s — moved to the background (job_id: ${operationId}): ${commandToRun}`;
            this.commandOutputs.set(operationId, {
                stdout: `${head}\nYou'll receive its result automatically when it exits — continue other work; do not poll. Check or stop it with background_jobs({operation:"output"|"cancel", job_id:"${operationId}"}).`,
                stderr: '',
                exitCode: 0,
                success: true,
                // Harness control text (not captured output) — don't frame as untrusted.
                harnessMessage: true,
            });
            this.emit('terminal-output', {
                operationId,
                command: commandToRun,
                output: accOutput,
                status: 'running' as const,
                background: true,
            });
            resolveExec();
        };

        const promoteTimer = explicitBackground
            ? null
            : setTimeout(() => promote('timer'), PROMOTE_AFTER_MS);

        runShellCommandStreaming(commandToRun, workingDir, {
            sandbox: sandboxOpts,
            onSpawn: (p) => {
                proc = p;
                if (promoted && chatIdForBg != null) {
                    bg.registerBackgroundProc(chatIdForBg, operationId, p);
                } else if (chatIdForBg != null) {
                    // Foreground (blocking) child — track it so a user cancel can
                    // actually terminate it (Fix 4). Promotion to background
                    // migrates it to the background registry below.
                    bg.registerForegroundProc(chatIdForBg, operationId, p);
                }
            },
            onOutput: ({ stdout, stderr }) => {
                accOutput = stdout + (stderr ? `\n${stderr}` : '');
                if (promoted && chatIdForBg != null) {
                    bg.updateBackgroundOutput(chatIdForBg, operationId, accOutput);
                }
                this.emit('terminal-output', {
                    operationId,
                    command: commandToRun,
                    output: accOutput,
                    status: 'running' as const,
                    background: promoted,
                });
            },
        })
            .then(async (resultIn) => {
                let result = resultIn as CommandResult;
                // Stop the promote timer now so the escalation wait below can't be
                // mistaken for a long-running command (denials fail fast anyway).
                finished = true;
                if (promoteTimer) clearTimeout(promoteTimer);
                // Escalation-on-denial: a foreground command that failed on a
                // sandbox WRITE denial may be granted the path + retried (still
                // sandboxed) with the user's approval. Background/promoted runs
                // resolve async and are skipped.
                if (!result.success && !promoted && !explicitBackground) {
                    try {
                        const retried = await this.maybeEscalateSandboxDenial(result, {
                            commandToRun,
                            workingDir,
                            sandboxOpts,
                            operationId,
                        });
                        if (retried) result = retried;
                    } catch (e) {
                        logger.warn(
                            `[sandbox-escalation] ${e instanceof Error ? e.message : String(e)}`,
                        );
                    }
                }
                if (chatIdForBg != null) bg.clearForegroundProc(chatIdForBg, operationId);
                const duration = Date.now() - startTime;
                this.emit('terminal-output', {
                    operationId,
                    command: commandToRun,
                    output: result.stdout + (result.stderr ? `\n${result.stderr}` : ''),
                    status: result.success ? 'completed' as const : 'error' as const,
                    exitCode: result.exitCode,
                    duration,
                    background: promoted,
                });
                if (promoted) {
                    if (chatIdForBg != null) {
                        bg.recordBackgroundCommandResult(chatIdForBg, operationId, {
                            command: commandToRun,
                            exitCode: result.exitCode,
                            output: result.stdout + (result.stderr ? `\n${result.stderr}` : ''),
                            durationMs: duration,
                        });
                    }
                    return;
                }
                this.commandOutputs.set(operationId, result as CommandResult);
                if (result.success) {
                    logger.log(`[executeRunCommand] Success: ${commandToRun} (${(duration / 1000).toFixed(1)}s)`);
                } else {
                    logger.error(`[executeRunCommand] Failed: ${commandToRun} (exit ${result.exitCode})`);
                    const errDetail = result.stderr
                        ? `\n\n${result.stderr.slice(0, 500)}`
                        : (result.stdout ? `\n\n${result.stdout.slice(0, 200)}` : "");
                    // State that the sandbox was there. Nothing more.
                    //
                    // By here the escalation pass has run and found no attributable path
                    // (`maybeEscalateSandboxDenial` returned null, so `result` is the
                    // original failure), which means the model is about to receive a bare
                    // non-zero exit with no hint that Atlarix itself constrained the
                    // process — a boundary it cannot reason about because nobody told it.
                    //
                    // Facts only: no attempt to work out whether this failure WAS a
                    // denial. The output is already in the error; the model reads it
                    // better than a heuristic here could, and a wrong guess would send the
                    // user a grant request for an unrelated folder.
                    const sandboxNote = describeSandboxFailureContext({
                        sandboxed: !!sandboxOpts,
                        workingDir,
                        writableRoots: [
                            ...(sandboxOpts && !sandboxOpts.readOnly
                                ? [sandboxOpts.workspacePath]
                                : []),
                            ...(sandboxOpts?.extraWritablePaths ?? []),
                        ],
                        ...(sandboxOpts?.readOnly ? { readOnly: true } : {}),
                        exitCode: result.exitCode,
                        alreadyAttributed:
                            parseSandboxDenialsFromOutput(
                                `${result.stderr ?? ""}\n${result.stdout ?? ""}`,
                            ).length > 0,
                    });
                    thrownError = new Error(
                        `Command failed with exit code ${result.exitCode}${errDetail}` +
                            (sandboxNote ? `\n\n${sandboxNote}` : ""),
                    );
                }
                resolveExec();
            })
            .catch((err) => {
                finished = true;
                if (promoteTimer) clearTimeout(promoteTimer);
                if (chatIdForBg != null) bg.clearForegroundProc(chatIdForBg, operationId);
                const duration = Date.now() - startTime;
                const errMsg = err instanceof Error ? err.message : String(err);
                this.emit('terminal-output', {
                    operationId,
                    command: commandToRun,
                    output: errMsg,
                    status: 'error' as const,
                    exitCode: -1,
                    duration,
                    background: promoted,
                });
                if (promoted) {
                    if (chatIdForBg != null) {
                        bg.recordBackgroundCommandResult(chatIdForBg, operationId, {
                            command: commandToRun,
                            exitCode: -1,
                            output: errMsg,
                            durationMs: duration,
                        });
                    }
                    return;
                }
                this.commandOutputs.set(operationId, { stdout: '', stderr: errMsg, exitCode: -1, success: false });
                thrownError = new Error(errMsg);
                resolveExec();
            });

        if (explicitBackground) promote('explicit');

        await execDone;
        if (thrownError) throw thrownError;
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
}
