/**
 * Approval Queue Panel
 * ======================
 * Shows operations in clear status sections:
 * Pending (await approval) → Queued (approved) → Running → Completed/Failed
 */

import { useAtomValue, useSetAtom } from "jotai";
import {
    permissionQueueAtom,
    type QueuedOperation,
    type OperationStatus,
    getOperationsByStatus,
    updateOperationStatus,
    removeOperation,
} from "@/atoms/permissionQueueAtom";
import {
    Play,
    Clock,
    Loader2,
    CheckCircle2,
    XCircle,
    AlertCircle,
    ChevronRight,
    ChevronDown,
    FileEdit,
    Trash2,
    FilePlus,
    Wand2,
    RotateCcw,
    X,
    Terminal,
    Map,
    History,
} from "lucide-react";
import { SmartDiffView } from "./SmartDiffView";
import { useState, useCallback, useEffect } from "react";
import { cn } from "@/lib/utils";
import { IpcClient } from "@/ipc/ipc_client";
import { addOperation } from "@/atoms/permissionQueueAtom";

// ════════════════════════════════════════════════════════════════════════════
// STATUS BADGE
// ════════════════════════════════════════════════════════════════════════════

function StatusBadge({ status, isRecovering }: { status: OperationStatus; isRecovering?: boolean }) {
    if (isRecovering) {
        return (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs font-medium text-purple-400 bg-purple-500/10 border-purple-500/30 animate-pulse">
                <Wand2 className="w-3.5 h-3.5" />
                AI Fixing...
            </div>
        );
    }

    const configs: Record<OperationStatus, { icon: typeof AlertCircle; label: string; color: string }> = {
        pending: {
            icon: AlertCircle,
            label: 'Awaiting Approval',
            color: 'text-amber-400 bg-amber-500/10 border-amber-500/30'
        },
        queued: {
            icon: Clock,
            label: 'Queued',
            color: 'text-amber-300 bg-amber-400/10 border-amber-400/30'
        },
        running: {
            icon: Loader2,
            label: 'Running',
            color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30'
        },
        completed: {
            icon: CheckCircle2,
            label: 'Completed',
            color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30'
        },
        failed: {
            icon: XCircle,
            label: 'Failed',
            color: 'text-red-400 bg-red-500/10 border-red-500/30'
        },
    };

    const config = configs[status];
    const Icon = config.icon;

    return (
        <div className={cn(
            "flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs font-medium",
            config.color
        )}>
            <Icon className={cn("w-3.5 h-3.5", status === 'running' && 'animate-spin')} />
            {config.label}
        </div>
    );
}

// ════════════════════════════════════════════════════════════════════════════
// OPERATION CARD
// ════════════════════════════════════════════════════════════════════════════

interface OperationCardProps {
    operation: QueuedOperation;
    onApprove?: (id: string) => void;
    onReject?: (id: string) => void;
    onFixWithAI?: (op: QueuedOperation) => void;
    onRetry?: (op: QueuedOperation) => void;
    onDismiss?: (id: string) => void;
}

function OperationCard({
    operation,
    onApprove,
    onReject,
    onFixWithAI,
    onRetry,
    onDismiss,
}: OperationCardProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [dangerAcknowledged, setDangerAcknowledged] = useState(false);
    const isPending = operation.status === 'pending';
    const isDangerous = operation.isDangerous && operation.operation === 'run_command';
    const canApprove = !isDangerous || dangerAcknowledged;
    const isRunning = operation.status === 'running';
    const isFailed = operation.status === 'failed';
    const isCompleted = operation.status === 'completed';

    const getOperationIcon = () => {
        switch (operation.operation) {
            case 'run_command':
                return <Terminal className="w-4 h-4 text-cyan-400" />;
            case 'write_file':
            case 'write_multiple_files':
                return operation.path?.includes('new') || operation.content
                    ? <FilePlus className="w-4 h-4 text-emerald-400" />
                    : <FileEdit className="w-4 h-4 text-blue-400" />;
            case 'delete_file':
                return <Trash2 className="w-4 h-4 text-red-400" />;
            case 'update_diagram':
                return <Map className="w-4 h-4 text-emerald-400" />;
            case 'batch_plan':
                return <Wand2 className="w-4 h-4 text-violet-400" />;
            case 'revert_project_snapshot':
                return <History className="w-4 h-4 text-amber-400" />;
            default:
                return <FileEdit className="w-4 h-4 text-gray-400" />;
        }
    };

    // Get display name - command text or filename
    const isDiagramUpdate = operation.operation === 'update_diagram';
    const diagramPreview = isDiagramUpdate ? JSON.parse(operation.preview || '{}') : null;

    const isBatchPlan = operation.operation === 'batch_plan';
    const isRevertSnapshot = operation.operation === 'revert_project_snapshot';
    const isWriteFile =
        operation.operation === 'write_file' || operation.operation === 'write_multiple_files';
    const isEditFile = operation.operation === 'edit_file';
    const filePreview = (() => {
        try {
            const raw = operation.preview;
            if (!raw) return null;
            const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return p && typeof p === 'object' ? (p as { path?: string; lines?: number }) : null;
        } catch {
            return null;
        }
    })();
    const displayName = isDiagramUpdate
        ? 'Update diagram'
        : isRevertSnapshot
            ? (() => {
                try {
                    const p = JSON.parse(operation.preview || '{}');
                    const summary = p.planExcerpt
                        ? ` — ${String(p.planExcerpt).replace(/\s+/g, ' ').slice(0, 80)}`
                        : '';
                    return (p.label || `Revert checkpoint #${p.snapshotId ?? '?'}`) + summary;
                } catch {
                    return 'Revert checkpoint';
                }
            })()
        : isBatchPlan
            ? (operation.batchPlanTitle || 'Plan') + (operation.batchPlanOperationsCount != null ? ` (${operation.batchPlanOperationsCount} operations)` : '')
            : isWriteFile && filePreview?.path
              ? filePreview.lines != null
                  ? `Write ${filePreview.lines} lines to ${filePreview.path}`
                  : `Write to ${filePreview.path}`
              : isEditFile && filePreview?.path
                ? filePreview.lines != null
                    ? `Edit ${filePreview.lines} lines in ${filePreview.path}`
                    : `Edit ${filePreview.path}`
                : operation.command
                  ? operation.command.length > 60
                      ? operation.command.slice(0, 60) + '...'
                      : operation.command
                  : operation.path
                    ? operation.path.split('/').pop() ?? operation.path
                    : `${operation.operation} operation`;

    // Full path for tooltip
    const fullPath = operation.path || operation.command || '';

    return (
        <div className={cn(
            "border rounded-lg overflow-hidden transition-all bg-card/80",
            isPending && "border-amber-500/40 bg-amber-500/5",
            isRunning && "border-emerald-500/40 bg-emerald-500/5",
            isFailed && "border-red-500/30 bg-red-500/5",
            isCompleted && "border-emerald-500/30 bg-emerald-500/5",
            !isPending && !isRunning && !isFailed && !isCompleted && "border-border"
        )}>
            {/* Header - always visible, clickable to expand */}
            <div className="flex items-center gap-2 p-3">
                {/* Expand/Collapse button */}
                <button
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="p-1 hover:bg-muted rounded transition-colors"
                    title={isExpanded ? "Collapse" : "Expand to see details"}
                >
                    <ChevronDown className={cn(
                        "w-4 h-4 text-muted-foreground transition-transform",
                        isExpanded && "rotate-180"
                    )} />
                </button>

                {/* Icon */}
                {getOperationIcon()}

                {/* Name */}
                <span
                    className="flex-1 text-sm font-medium text-foreground truncate"
                    title={fullPath}
                >
                    {displayName}
                </span>

                {/* Inline "I understand" for dangerous commands */}
                {isPending && isDangerous && (
                    <div className="flex items-center gap-2 text-xs" onClick={(e) => e.stopPropagation()}>
                        <input
                            type="checkbox"
                            id={`danger-inline-${operation.id}`}
                            checked={dangerAcknowledged}
                            onChange={(e) => setDangerAcknowledged(e.target.checked)}
                            className="rounded border-amber-500/50"
                        />
                        <label htmlFor={`danger-inline-${operation.id}`} className="text-amber-400 whitespace-nowrap">
                            I understand
                        </label>
                    </div>
                )}

                {/* Status or Actions */}
                {isPending ? (
                    <div className="flex items-center gap-1.5">
                        <button
                            onClick={(e) => { e.stopPropagation(); canApprove && onApprove?.(operation.id); }}
                            disabled={!canApprove}
                            className={cn(
                                "px-2.5 py-1 text-xs font-medium rounded transition-colors",
                                canApprove
                                    ? "bg-emerald-600 text-white hover:bg-emerald-500"
                                    : "bg-emerald-600/50 text-white/70 cursor-not-allowed"
                            )}
                        >
                            Approve
                        </button>
                        <button
                            onClick={(e) => { e.stopPropagation(); onReject?.(operation.id); }}
                            className="px-2.5 py-1 bg-red-600/80 text-white text-xs font-medium rounded hover:bg-red-500 transition-colors"
                        >
                            Reject
                        </button>
                    </div>
                ) : (
                    <StatusBadge status={operation.status} isRecovering={operation.isRecovering} />
                )}
            </div>

            {/* Progress Bar (for running commands) */}
            {isRunning && operation.progress !== undefined && (
                <div className="px-3 pb-2">
                    <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                        <div
                            className="bg-emerald-500 h-full transition-all duration-300 rounded-full"
                            style={{ width: `${operation.progress}%` }}
                        />
                    </div>
                </div>
            )}

            {/* Expanded Content */}
            {isExpanded && (
                <div className="border-t border-border p-3 space-y-2">
                    {/* Full path for files */}
                    {operation.path && (
                        <div className="text-xs text-muted-foreground">
                            <span className="text-muted-foreground/60">Path:</span> {operation.path}
                        </div>
                    )}

                    {/* Command preview for run_command */}
                    {operation.operation === 'run_command' && operation.command && (
                        <div className="space-y-2">
                            <div className="bg-background-darkest rounded p-2 font-mono text-xs text-emerald-400 overflow-x-auto">
                                $ {operation.command}
                            </div>
                            {isDangerous && operation.dangerExplanation && (
                                <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-500/40 bg-amber-500/10">
                                    <input
                                        type="checkbox"
                                        id={`danger-ack-${operation.id}`}
                                        checked={dangerAcknowledged}
                                        onChange={(e) => { e.stopPropagation(); setDangerAcknowledged(e.target.checked); }}
                                        className="mt-0.5 rounded border-amber-500/50"
                                    />
                                    <label
                                        htmlFor={`danger-ack-${operation.id}`}
                                        className="text-sm text-amber-950 dark:text-amber-100 flex-1"
                                    >
                                        <span className="font-medium">I understand:</span> {operation.dangerExplanation}
                                    </label>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Smart diff for file operations with oldContent */}
                    {operation.content && operation.oldContent !== undefined && operation.path && (
                        <SmartDiffView
                            path={operation.path}
                            oldContent={operation.oldContent}
                            newContent={operation.content}
                            description={operation.description}
                            operation="update"
                            maxHeight="max-h-64"
                        />
                    )}
                    {/* Fallback: content preview when no diff available */}
                    {operation.content && operation.oldContent === undefined && (
                        <pre className="text-xs bg-background-darkest text-foreground/80 p-2 rounded overflow-x-auto max-h-32 overflow-y-auto">
                            {operation.content.split('\n').slice(0, 10).map((line, i) => (
                                <div key={i} className="flex">
                                    <span className="text-emerald-500 mr-2 select-none">+</span>
                                    <span>{line}</span>
                                </div>
                            ))}
                            {operation.content.split('\n').length > 10 && (
                                <div className="text-muted-foreground italic mt-1">
                                    ... {operation.content.split('\n').length - 10} more lines
                                </div>
                            )}
                        </pre>
                    )}

                    {/* JSON preview fallback */}
                    {operation.preview && !operation.content && operation.operation !== 'run_command' && operation.operation !== 'update_diagram' && (
                        <pre className="text-xs bg-background-darkest text-muted-foreground p-2 rounded overflow-x-auto max-h-24 overflow-y-auto">
                            {operation.preview}
                        </pre>
                    )}

                    {/* Batch plan preview (parent-aggregated permissions) */}
                    {isBatchPlan && (operation.batchPlanTitle || operation.batchPlanSummary) && (
                        <div className="bg-violet-500/10 border border-violet-500/30 rounded-lg p-3 space-y-2">
                            <div className="font-medium text-violet-300">{operation.batchPlanTitle || 'Plan'}</div>
                            {operation.batchPlanSummary && <p className="text-sm text-muted-foreground">{operation.batchPlanSummary}</p>}
                            {operation.batchPlanOperationsCount != null && (
                                <p className="text-xs text-muted-foreground">{operation.batchPlanOperationsCount} operation(s) — Approve to run all</p>
                            )}
                        </div>
                    )}

                    {/* Diagram update preview */}
                    {isDiagramUpdate && diagramPreview && (
                        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 space-y-2">
                            <div className="flex items-center gap-2">
                                <Map className="w-4 h-4 text-emerald-400" />
                                <span className="font-medium text-emerald-300">Diagram Regeneration</span>
                                <span className={cn(
                                    "text-xs px-2 py-0.5 rounded-full font-medium",
                                    diagramPreview.type === 'major' && "bg-amber-500/20 text-amber-400",
                                    diagramPreview.type === 'new_component' && "bg-cyan-500/20 text-cyan-400",
                                    diagramPreview.type === 'minor' && "bg-slate-500/20 text-slate-400"
                                )}>
                                    {diagramPreview.type}
                                </span>
                            </div>
                            <p className="text-sm text-muted-foreground">
                                <strong className="text-emerald-300">Affected:</strong> {diagramPreview.components?.join(', ') || 'N/A'}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                {diagramPreview.description}
                            </p>
                        </div>
                    )}

                    {/* Duration for completed */}
                    {isCompleted && operation.duration && (
                        <p className="text-xs text-emerald-500">
                            ✓ Completed in {(operation.duration / 1000).toFixed(1)}s
                        </p>
                    )}

                    {/* Error message */}
                    {isFailed && operation.error && (
                        <div className="p-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-400">
                            {operation.error}
                        </div>
                    )}

                    {/* Failed actions */}
                    {isFailed && !operation.isRecovering && (
                        <div className="flex gap-2 pt-2">
                            <button
                                onClick={() => onFixWithAI?.(operation)}
                                className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 text-white text-xs font-medium rounded hover:bg-purple-500 transition-colors"
                            >
                                <Wand2 className="w-3 h-3" />
                                Fix with AI
                            </button>
                            <button
                                onClick={() => onRetry?.(operation)}
                                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-600 text-white text-xs font-medium rounded hover:bg-slate-500 transition-colors"
                            >
                                <RotateCcw className="w-3 h-3" />
                                Retry
                            </button>
                            <button
                                onClick={() => onDismiss?.(operation.id)}
                                className="p-1.5 bg-slate-700 text-slate-300 rounded hover:bg-slate-600 transition-colors"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN PANEL
// ════════════════════════════════════════════════════════════════════════════

interface PermissionQueuePanelProps {
    chatId?: number;
    onFixWithAI?: (op: QueuedOperation) => void;
}

export function PermissionQueuePanel({ chatId, onFixWithAI }: PermissionQueuePanelProps) {
    const queue = useAtomValue(permissionQueueAtom);
    const setQueue = useSetAtom(permissionQueueAtom);
    const [showCompleted, setShowCompleted] = useState(false);

    // Load pending permissions and subscribe to new ones
    useEffect(() => {
        if (chatId === undefined) return; // Only skip if no chatId at all

        // Fetch initial pending permissions
        const loadPermissions = async () => {
            try {
                const pending = await IpcClient.getInstance().getPendingPermissions({ chatId });
                    pending.forEach((p) => {
                        const request = p.request;
                        const preview = request.preview as any;
                        setQueue(q => addOperation(q, {
                            id: p.id,
                            operation: request.operation || 'unknown',
                            command: preview?.command,
                            path: preview?.path,
                            content: preview?.content,
                            oldContent: preview?.oldContent,
                            description: preview?.description,
                            preview: JSON.stringify(request.preview, null, 2).slice(0, 500),
                            status: 'pending',
                            isDangerous: preview?.isDangerous,
                            dangerExplanation: preview?.dangerExplanation,
                            ...(request.operation === 'batch_plan' && {
                                batchPlanTitle: preview?.title,
                                batchPlanSummary: preview?.summary,
                                batchPlanOperationsCount: Array.isArray(preview?.operations) ? preview.operations.length : 0,
                            }),
                        }));
                    });
            } catch (err) {
                console.error('[PermissionQueuePanel] Failed to load permissions:', err);
            }
        };
        loadPermissions();

        // Subscribe to new permission requests
        const unsubscribe = IpcClient.getInstance().onPermissionRequest(chatId, (payload) => {
            const request = payload.request;
            const preview = request.preview as any;
            setQueue(q => addOperation(q, {
                id: payload.operationId,
                operation: request.operation || 'unknown',
                command: preview?.command,
                path: preview?.path,
                content: preview?.content,
                oldContent: preview?.oldContent,
                description: preview?.description,
                preview: JSON.stringify(request.preview, null, 2).slice(0, 500),
                status: 'pending',
                isDangerous: preview?.isDangerous,
                dangerExplanation: preview?.dangerExplanation,
                ...(request.operation === 'batch_plan' && {
                    batchPlanTitle: preview?.title,
                    batchPlanSummary: preview?.summary,
                    batchPlanOperationsCount: Array.isArray(preview?.operations) ? preview.operations.length : 0,
                }),
            }));
        });

        return () => unsubscribe();
    }, [chatId, setQueue]);

    const pending = getOperationsByStatus(queue, 'pending');
    const queued = getOperationsByStatus(queue, 'queued');
    const running = getOperationsByStatus(queue, 'running');
    const completed = getOperationsByStatus(queue, 'completed');
    const failed = getOperationsByStatus(queue, 'failed');

    const handleApprove = useCallback(async (id: string) => {
        // Optimistic update: move to queued
        setQueue(q => updateOperationStatus(q, id, { status: 'queued' }));

        // Tell backend to execute
        if (chatId) {
            await IpcClient.getInstance().executePermission({ chatId, operationId: id });
        }
    }, [chatId, setQueue]);

    const handleReject = useCallback(async (id: string) => {
        // Remove from queue
        setQueue(q => removeOperation(q, id));

        // Tell backend
        if (chatId) {
            await IpcClient.getInstance().rejectPermission({ chatId, operationId: id });
        }
    }, [chatId, setQueue]);

    const handleApproveAll = useCallback(async () => {
        // Move all pending to queued
        setQueue(q => {
            let newQueue = q;
            pending.forEach(op => {
                newQueue = updateOperationStatus(newQueue, op.id, { status: 'queued' });
            });
            return newQueue;
        });

        // Execute all
        if (chatId) {
            await IpcClient.getInstance().executeAllPermissions({ chatId });
        }
    }, [chatId, pending, setQueue]);

    const handleRejectAll = useCallback(async () => {
        // Remove all pending
        setQueue(q => {
            let newQueue = q;
            pending.forEach(op => {
                newQueue = removeOperation(newQueue, op.id);
            });
            return newQueue;
        });

        if (chatId) {
            await IpcClient.getInstance().rejectAllPermissions({ chatId });
        }
    }, [chatId, pending, setQueue]);

    const handleRetry = useCallback((op: QueuedOperation) => {
        // Move back to pending for re-approval
        setQueue(q => updateOperationStatus(q, op.id, { status: 'pending', error: undefined }));
    }, [setQueue]);

    const handleDismiss = useCallback((id: string) => {
        setQueue(q => removeOperation(q, id));
    }, [setQueue]);

    const isEmpty = queue.size === 0;

    return (
        <div className="h-full flex flex-col bg-slate-900/50">
            {/* Header */}
            <div className="border-b border-slate-700/50 p-4">
                <h2 className="text-lg font-semibold text-slate-100 mb-1">Approval Queue</h2>
                <p className="text-sm text-slate-400">
                    {pending.length > 0 && `${pending.length} awaiting`}
                    {pending.length > 0 && (queued.length + running.length > 0) && ' • '}
                    {(queued.length + running.length > 0) && `${queued.length + running.length} in progress`}
                    {isEmpty && 'No pending operations'}
                </p>
            </div>

            {/* Bulk Actions - Disable Approve All when any op is dangerous (requires individual acknowledgment) */}
            {pending.length > 0 && (
                <div className="border-b border-border p-3 bg-muted/30 flex gap-2">
                    <button
                        onClick={handleApproveAll}
                        disabled={pending.some(op => op.isDangerous)}
                        title={pending.some(op => op.isDangerous) ? "Approve dangerous commands individually after checking \"I understand\"" : undefined}
                        className={cn(
                            "flex-1 px-3 py-2 text-sm font-medium rounded transition-colors",
                            pending.some(op => op.isDangerous)
                                ? "bg-emerald-600/50 text-white/70 cursor-not-allowed"
                                : "bg-emerald-600 text-white hover:bg-emerald-500"
                        )}
                    >
                        Approve All ({pending.length})
                    </button>
                    <button
                        onClick={handleRejectAll}
                        className="flex-1 px-3 py-2 bg-red-600 text-white text-sm font-medium rounded hover:bg-red-500 transition-colors"
                    >
                        Reject All
                    </button>
                </div>
            )}

            {/* Operations List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {/* Pending Section */}
                {pending.length > 0 && (
                    <Section title="Awaiting Approval" count={pending.length} color="text-amber-400">
                        {pending.map(op => (
                            <OperationCard
                                key={op.id}
                                operation={op}
                                onApprove={handleApprove}
                                onReject={handleReject}
                            />
                        ))}
                    </Section>
                )}

                {/* Running Section */}
                {running.length > 0 && (
                    <Section title="Currently Running" count={running.length} color="text-emerald-400">
                        {running.map(op => (
                            <OperationCard key={op.id} operation={op} />
                        ))}
                    </Section>
                )}

                {/* Queued Section */}
                {queued.length > 0 && (
                    <Section title="Queued" count={queued.length} color="text-amber-300">
                        {queued.map(op => (
                            <OperationCard key={op.id} operation={op} />
                        ))}
                    </Section>
                )}

                {/* Failed Section */}
                {failed.length > 0 && (
                    <Section title="Failed" count={failed.length} color="text-red-400">
                        {failed.map(op => (
                            <OperationCard
                                key={op.id}
                                operation={op}
                                onFixWithAI={onFixWithAI}
                                onRetry={handleRetry}
                                onDismiss={handleDismiss}
                            />
                        ))}
                    </Section>
                )}

                {/* Completed Section (collapsible) */}
                {completed.length > 0 && (
                    <div>
                        <button
                            onClick={() => setShowCompleted(!showCompleted)}
                            className="flex items-center gap-2 text-xs font-semibold text-slate-500 uppercase tracking-wide hover:text-slate-400 transition-colors"
                        >
                            <ChevronRight className={cn(
                                "w-3 h-3 transition-transform",
                                showCompleted && "rotate-90"
                            )} />
                            Completed ({completed.length})
                        </button>
                        {showCompleted && (
                            <div className="space-y-2 mt-2">
                                {completed.map(op => (
                                    <OperationCard key={op.id} operation={op} />
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Empty State */}
                {isEmpty && (
                    <div className="flex flex-col items-center justify-center h-full text-slate-500">
                        <CheckCircle2 className="w-12 h-12 mb-2" />
                        <p className="text-sm">No pending operations</p>
                        <p className="text-xs text-slate-400 mt-1">You&apos;ll hear a sound when the AI requests approval.</p>
                    </div>
                )}
            </div>
        </div>
    );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION COMPONENT
// ════════════════════════════════════════════════════════════════════════════

function Section({
    title,
    count,
    color,
    children
}: {
    title: string;
    count: number;
    color: string;
    children: React.ReactNode;
}) {
    return (
        <div>
            <h3 className={cn("text-xs font-semibold uppercase tracking-wide mb-2", color)}>
                {title} ({count})
            </h3>
            <div className="space-y-2">
                {children}
            </div>
        </div>
    );
}

export default PermissionQueuePanel;
