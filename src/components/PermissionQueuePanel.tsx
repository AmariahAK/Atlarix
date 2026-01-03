/**
 * Permission Queue Panel
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
    FileEdit,
    Trash2,
    Wand2,
    RotateCcw,
    X,
} from "lucide-react";
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
            color: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30'
        },
        queued: {
            icon: Clock,
            label: 'Queued',
            color: 'text-blue-400 bg-blue-500/10 border-blue-500/30'
        },
        running: {
            icon: Loader2,
            label: 'Running',
            color: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30'
        },
        completed: {
            icon: CheckCircle2,
            label: 'Completed',
            color: 'text-green-400 bg-green-500/10 border-green-500/30'
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
    const isPending = operation.status === 'pending';
    const isRunning = operation.status === 'running';
    const isFailed = operation.status === 'failed';

    const getOperationIcon = () => {
        switch (operation.operation) {
            case 'run_command':
                return <Play className="w-4 h-4 text-cyan-400" />;
            case 'write_file':
            case 'write_multiple_files':
                return <FileEdit className="w-4 h-4 text-blue-400" />;
            case 'delete_file':
                return <Trash2 className="w-4 h-4 text-red-400" />;
            default:
                return <FileEdit className="w-4 h-4 text-gray-400" />;
        }
    };

    return (
        <div className={cn(
            "border rounded-lg p-3 transition-all bg-slate-800/50",
            isPending && "border-yellow-500/30 bg-yellow-500/5",
            isRunning && "border-cyan-500/30 bg-cyan-500/5",
            isFailed && "border-red-500/30 bg-red-500/5",
            !isPending && !isRunning && !isFailed && "border-slate-700/50"
        )}>
            {/* Header */}
            <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                    {getOperationIcon()}
                    <span className="text-sm font-medium text-slate-200 truncate">
                        {operation.command || operation.path || 'Unknown operation'}
                    </span>
                </div>
                <StatusBadge status={operation.status} isRecovering={operation.isRecovering} />
            </div>

            {/* Progress Bar (for running commands) */}
            {isRunning && operation.progress !== undefined && (
                <div className="mb-2">
                    <div className="w-full bg-slate-700 rounded-full h-1.5 overflow-hidden">
                        <div
                            className="bg-cyan-500 h-full transition-all duration-300 rounded-full"
                            style={{ width: `${operation.progress}%` }}
                        />
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                        {operation.progress}% complete
                    </p>
                </div>
            )}

            {/* Duration (for completed) */}
            {operation.status === 'completed' && operation.duration && (
                <p className="text-xs text-slate-500 mb-2">
                    Completed in {(operation.duration / 1000).toFixed(1)}s
                </p>
            )}

            {/* Error Message */}
            {isFailed && operation.error && (
                <div className="mb-2 p-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-400">
                    {operation.error}
                </div>
            )}

            {/* Preview (for files) */}
            {operation.preview && (
                <pre className="text-xs bg-slate-900 text-slate-300 p-2 rounded mt-2 overflow-x-auto max-h-24 overflow-y-auto">
                    {operation.preview.split('\n').slice(0, 5).join('\n')}
                    {operation.preview.split('\n').length > 5 && '\n...'}
                </pre>
            )}

            {/* Actions */}
            {isPending && (
                <div className="flex gap-2 mt-3 pt-2 border-t border-slate-700/50">
                    <button
                        onClick={() => onApprove?.(operation.id)}
                        className="flex-1 px-3 py-1.5 bg-green-600 text-white text-xs font-medium rounded hover:bg-green-500 transition-colors"
                    >
                        Approve
                    </button>
                    <button
                        onClick={() => onReject?.(operation.id)}
                        className="flex-1 px-3 py-1.5 bg-red-600 text-white text-xs font-medium rounded hover:bg-red-500 transition-colors"
                    >
                        Reject
                    </button>
                </div>
            )}

            {/* Failed Actions */}
            {isFailed && !operation.isRecovering && (
                <div className="flex gap-2 mt-3 pt-2 border-t border-slate-700/50">
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
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 text-slate-300 text-xs font-medium rounded hover:bg-slate-600 transition-colors"
                    >
                        <X className="w-3 h-3" />
                    </button>
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
                    setQueue(q => addOperation(q, {
                        id: p.id,
                        operation: request.operation || 'unknown',
                        command: request.command,
                        path: request.path,
                        content: request.content,
                        status: 'pending',
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
            setQueue(q => addOperation(q, {
                id: payload.operationId,
                operation: request.operation || 'unknown',
                command: request.command,
                path: request.path,
                content: request.content,
                status: 'pending',
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
                <h2 className="text-lg font-semibold text-slate-100 mb-1">Permission Queue</h2>
                <p className="text-sm text-slate-400">
                    {pending.length > 0 && `${pending.length} awaiting`}
                    {pending.length > 0 && (queued.length + running.length > 0) && ' • '}
                    {(queued.length + running.length > 0) && `${queued.length + running.length} in progress`}
                    {isEmpty && 'No pending operations'}
                </p>
            </div>

            {/* Bulk Actions */}
            {pending.length > 0 && (
                <div className="border-b border-slate-700/50 p-3 bg-slate-800/30 flex gap-2">
                    <button
                        onClick={handleApproveAll}
                        className="flex-1 px-3 py-2 bg-green-600 text-white text-sm font-medium rounded hover:bg-green-500 transition-colors"
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
                    <Section title="Awaiting Approval" count={pending.length} color="text-yellow-400">
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
                    <Section title="Currently Running" count={running.length} color="text-cyan-400">
                        {running.map(op => (
                            <OperationCard key={op.id} operation={op} />
                        ))}
                    </Section>
                )}

                {/* Queued Section */}
                {queued.length > 0 && (
                    <Section title="Queued" count={queued.length} color="text-blue-400">
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
