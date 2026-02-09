/**
 * FileDiffPanel
 * =============
 * Right panel for code changes with:
 * - File tree with change indicators (✨ new, 📝 modified, 🗑️ deleted)
 * - Monaco diff viewer
 * - Batch approval controls
 */

import { useState, useMemo, useCallback } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import {
    pendingProposalsAtom,
    selectedProposalAtom,
    approvalStateAtom,
    type FileProposal
} from '@/atoms/sourceAtoms';
import { cn } from '@/lib/utils';
import { IpcClient } from '@/ipc/ipc_client';
import { PermissionQueuePanel } from '@/components/PermissionQueuePanel';
import {
    File,
    FilePlus,
    FileEdit,
    Trash2,
    Check,
    X,
    ChevronRight,
    CheckCircle2,
    XCircle,
    FolderOpen,
    Loader2
} from 'lucide-react';

interface FileDiffPanelProps {
    data: {
        proposals: FileProposal[];
    };
    activeTab: string;
}

export function FileDiffPanel({ data, activeTab }: FileDiffPanelProps) {
    const proposals = data?.proposals || [];
    const [selectedProposal, setSelectedProposal] = useAtom(selectedProposalAtom);
    const [approvalState, setApprovalState] = useAtom(approvalStateAtom);
    const setPendingProposals = useSetAtom(pendingProposalsAtom);
    const [isExecuting, setIsExecuting] = useState(false);

    // Get chatId from proposals (stored when permission request was received)
    // Use the first proposal's chatId since all proposals in a batch share the same chat
    const chatId = proposals[0]?.chatId;

    // Group proposals by directory (commands go in a special 'Commands' group)
    const groupedProposals = useMemo(() => {
        const groups: Record<string, FileProposal[]> = {};
        proposals.forEach(p => {
            // Commands go in a special '⚡ Commands' group
            const dir = p.operation === 'command'
                ? '⚡ Commands'
                : (p.path.split('/').slice(0, -1).join('/') || '/');
            if (!groups[dir]) groups[dir] = [];
            groups[dir].push(p);
        });
        return groups;
    }, [proposals]);

    // Approval handlers
    const handleApproveAll = useCallback(async () => {
        if (!chatId) {
            console.warn('No chatId available for permission execution');
            return;
        }

        setIsExecuting(true);
        try {
            // Call IPC to execute all permissions
            await IpcClient.getInstance().executeAllPermissions({ chatId });

            // Update local state
            setApprovalState({
                approved: proposals.map(p => p.id),
                rejected: []
            });

            // Clear pending proposals
            setPendingProposals([]);
        } catch (error) {
            console.error('Failed to execute permissions:', error);
        } finally {
            setIsExecuting(false);
        }
    }, [chatId, proposals, setApprovalState, setPendingProposals]);

    const handleRejectAll = useCallback(async () => {
        if (!chatId) {
            console.warn('No chatId available for permission rejection');
            return;
        }

        setIsExecuting(true);
        try {
            // Call IPC to reject all permissions
            await IpcClient.getInstance().rejectAllPermissions({ chatId });

            // Update local state
            setApprovalState({
                approved: [],
                rejected: proposals.map(p => p.id)
            });

            // Clear pending proposals
            setPendingProposals([]);
        } catch (error) {
            console.error('Failed to reject permissions:', error);
        } finally {
            setIsExecuting(false);
        }
    }, [chatId, proposals, setApprovalState, setPendingProposals]);

    const handleToggleApproval = (proposalId: string) => {
        setApprovalState(prev => {
            if (prev.approved.includes(proposalId)) {
                return {
                    approved: prev.approved.filter(id => id !== proposalId),
                    rejected: [...prev.rejected, proposalId]
                };
            } else {
                return {
                    approved: [...prev.approved, proposalId],
                    rejected: prev.rejected.filter(id => id !== proposalId)
                };
            }
        });
    };

    // Execute only individually selected (approved) files
    const handleExecuteSelected = useCallback(async () => {
        if (!chatId) {
            console.warn('No chatId available for permission execution');
            return;
        }

        if (approvalState.approved.length === 0) {
            console.warn('No files selected for execution');
            return;
        }

        setIsExecuting(true);
        try {
            // Execute each approved file individually
            for (const operationId of approvalState.approved) {
                await IpcClient.getInstance().executePermission({ chatId, operationId });
            }

            // Reject the rest (not selected)
            for (const operationId of approvalState.rejected) {
                await IpcClient.getInstance().rejectPermission({ chatId, operationId });
            }

            // Clear pending proposals
            setPendingProposals([]);
            console.log(`✅ Executed ${approvalState.approved.length} files, rejected ${approvalState.rejected.length}`);
        } catch (error) {
            console.error('Failed to execute selected permissions:', error);
        } finally {
            setIsExecuting(false);
        }
    }, [chatId, approvalState, setPendingProposals]);

    if (proposals.length === 0) {
        // When no proposals, still show PermissionQueuePanel for real-time queue
        return <PermissionQueuePanel chatId={chatId} />;
    }

    // Unified view - PermissionQueuePanel handles everything now
    // It shows each operation as a collapsible card with inline approve/reject
    return <PermissionQueuePanel chatId={chatId} />;
}

/**
 * Files Tab - Tree view with change indicators
 */
function FilesTab({
    groupedProposals,
    selectedProposal,
    approvalState,
    onSelectProposal,
    onToggleApproval
}: {
    groupedProposals: Record<string, FileProposal[]>;
    selectedProposal: FileProposal | null;
    approvalState: { approved: string[]; rejected: string[] };
    onSelectProposal: (p: FileProposal) => void;
    onToggleApproval: (id: string) => void;
}) {
    const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set(Object.keys(groupedProposals)));

    const toggleDir = (dir: string) => {
        setExpandedDirs(prev => {
            const next = new Set(prev);
            if (next.has(dir)) next.delete(dir);
            else next.add(dir);
            return next;
        });
    };

    // Operation icons
    const opIcons: Record<string, { icon: React.ElementType; color: string; label: string }> = {
        create: { icon: FilePlus, color: 'text-green-500', label: 'New' },
        modify: { icon: FileEdit, color: 'text-yellow-500', label: '📝' },
        delete: { icon: Trash2, color: 'text-red-500', label: '🗑️' },
        rename: { icon: FileEdit, color: 'text-blue-500', label: '📝' },
        command: { icon: ChevronRight, color: 'text-purple-500', label: '⚡' },
    };

    return (
        <div className="flex-1 overflow-y-auto p-2">
            {Object.entries(groupedProposals).map(([dir, files]) => (
                <div key={dir} className="mb-2">
                    {/* Directory Header */}
                    <button
                        onClick={() => toggleDir(dir)}
                        className="flex items-center gap-1.5 w-full px-2 py-1 text-sm text-muted-foreground hover:text-foreground hover:bg-muted rounded"
                    >
                        <ChevronRight
                            className={cn(
                                "w-3.5 h-3.5 transition-transform",
                                expandedDirs.has(dir) && "rotate-90"
                            )}
                        />
                        <FolderOpen className="w-4 h-4" />
                        <span className="truncate">{dir || '/'}</span>
                        <span className="ml-auto text-xs bg-muted px-1.5 rounded">
                            {files.length}
                        </span>
                    </button>

                    {/* Files */}
                    {expandedDirs.has(dir) && (
                        <div className="ml-4 mt-1 space-y-0.5">
                            {files.map((proposal) => {
                                const opInfo = opIcons[proposal.operation] || opIcons.create;
                                const isApproved = approvalState.approved.includes(proposal.id);
                                const isRejected = approvalState.rejected.includes(proposal.id);
                                const isSelected = selectedProposal?.id === proposal.id;
                                // For commands, show the command text; for files, show the filename
                                const displayName = proposal.operation === 'command'
                                    ? (proposal.command?.split(' ').slice(0, 3).join(' ') + '...' || 'Command')
                                    : proposal.path.split('/').pop();

                                return (
                                    <div
                                        key={proposal.id}
                                        className={cn(
                                            "flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors",
                                            isSelected
                                                ? "bg-primary/10 border border-primary/30"
                                                : "hover:bg-muted",
                                            isRejected && "opacity-50 line-through"
                                        )}
                                        onClick={() => onSelectProposal(proposal)}
                                    >
                                        {/* Operation Indicator */}
                                        <span title={proposal.operation}>
                                            {opInfo.label}
                                        </span>

                                        {/* File/Command Name */}
                                        <span className="flex-1 text-sm truncate">
                                            {displayName}
                                        </span>

                                        {/* Command Status - show Running/Queued for commands */}
                                        {proposal.operation === 'command' && !isApproved && !isRejected && (
                                            <span className="flex items-center gap-1 text-xs text-amber-400">
                                                <Loader2 className="w-3 h-3 animate-spin" />
                                                Queued
                                            </span>
                                        )}
                                        {proposal.operation === 'command' && isApproved && (
                                            <span className="flex items-center gap-1 text-xs text-emerald-400">
                                                <CheckCircle2 className="w-3 h-3" />
                                                Done
                                            </span>
                                        )}

                                        {/* Approval Status */}
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onToggleApproval(proposal.id);
                                            }}
                                            className="p-1 rounded hover:bg-muted"
                                        >
                                            {isApproved && (
                                                <CheckCircle2 className="w-4 h-4 text-green-500" />
                                            )}
                                            {isRejected && (
                                                <XCircle className="w-4 h-4 text-red-500" />
                                            )}
                                            {!isApproved && !isRejected && (
                                                <div className="w-4 h-4 rounded-full border-2 border-muted-foreground" />
                                            )}
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}

/** Context lines to show around each hunk */
const DIFF_CONTEXT_LINES = 3;

/** Max lines before offering "Expand All" (show hunks only when over this) */
const DIFF_HUNK_THRESHOLD = 50;

type DiffLineType = { type: 'context' | 'add' | 'remove' | 'header'; content: string; oldLineNum?: number; newLineNum?: number };

function DiffLineRow({ line }: { line: DiffLineType }) {
    return (
        <div
            className={cn("flex", line.type === 'header' && "bg-muted/50 border-b border-border")}
            style={{
                backgroundColor: line.type === 'add' ? 'var(--diff-add-bg)' : line.type === 'remove' ? 'var(--diff-remove-bg)' : undefined,
            }}
        >
            {line.type !== 'header' && (
                <div className="flex shrink-0 select-none">
                    <span
                        className="w-10 text-right px-1 border-r border-border/30"
                        style={{
                            color: line.type === 'add' ? 'var(--diff-add-line)' : line.type === 'remove' ? 'var(--diff-remove-line)' : 'var(--diff-context-text)',
                        }}
                    >
                        {line.type !== 'add' ? line.oldLineNum : ''}
                    </span>
                    <span
                        className="w-10 text-right px-1 border-r border-border/30"
                        style={{
                            color: line.type === 'add' ? 'var(--diff-add-line)' : line.type === 'remove' ? 'var(--diff-remove-line)' : 'var(--diff-context-text)',
                        }}
                    >
                        {line.type !== 'remove' ? line.newLineNum : ''}
                    </span>
                </div>
            )}
            <div className="flex-1 flex">
                <span
                    className="w-5 text-center select-none shrink-0 font-bold"
                    style={{
                        color: line.type === 'add' ? 'var(--diff-add-text)' : line.type === 'remove' ? 'var(--diff-remove-text)' : 'var(--diff-context-text)',
                    }}
                >
                    {line.type === 'add' && '+'}
                    {line.type === 'remove' && '-'}
                    {line.type === 'context' && ' '}
                </span>
                <pre
                    className={cn(
                        "flex-1 whitespace-pre-wrap break-words px-2 py-0.5",
                        line.type === 'header' && "text-muted-foreground italic py-1 px-3",
                    )}
                    style={{
                        color: line.type === 'add' ? 'var(--diff-add-text)' : line.type === 'remove' ? 'var(--diff-remove-text)' : line.type === 'context' ? 'var(--diff-context-text)' : undefined,
                    }}
                >
                    {line.content}
                </pre>
            </div>
        </div>
    );
}

/**
 * Diff Tab - Unified diff view with +/- line markers, hunks, Expand All, summary at top
 */
function DiffTab({ proposal }: { proposal: FileProposal | null }) {
    const [expandAll, setExpandAll] = useState(false);

    if (!proposal) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
                <File className="w-12 h-12 mb-3 opacity-50" />
                <p className="text-sm">Select a file to view changes</p>
            </div>
        );
    }

    // Generate unified diff lines
    const generateDiff = () => {
        const oldLines = (proposal.oldContent || '').split('\n');
        const newLines = (proposal.newContent || '').split('\n');

        const diffLines: { type: 'context' | 'add' | 'remove' | 'header'; content: string; oldLineNum?: number; newLineNum?: number }[] = [];

        // For create operation - all additions
        if (proposal.operation === 'create') {
            diffLines.push({ type: 'header', content: `+++ ${proposal.path} (new file)` });
            newLines.forEach((line, i) => {
                diffLines.push({ type: 'add', content: line, newLineNum: i + 1 });
            });
            return diffLines;
        }

        // For delete operation - all removals
        if (proposal.operation === 'delete') {
            diffLines.push({ type: 'header', content: `--- ${proposal.path} (deleted)` });
            oldLines.forEach((line, i) => {
                diffLines.push({ type: 'remove', content: line, oldLineNum: i + 1 });
            });
            return diffLines;
        }

        // For modify - compute simple line-by-line diff
        diffLines.push({ type: 'header', content: `--- ${proposal.path}` });
        diffLines.push({ type: 'header', content: `+++ ${proposal.path}` });

        // Simple diff: show removed and added lines
        // Find common prefix
        let prefixLen = 0;
        while (prefixLen < oldLines.length && prefixLen < newLines.length &&
            oldLines[prefixLen] === newLines[prefixLen]) {
            prefixLen++;
        }

        // Find common suffix (after prefix)
        let suffixLen = 0;
        while (suffixLen < (oldLines.length - prefixLen) &&
            suffixLen < (newLines.length - prefixLen) &&
            oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]) {
            suffixLen++;
        }

        // Context before (up to 3 lines)
        const contextBefore = Math.max(0, prefixLen - 3);
        for (let i = contextBefore; i < prefixLen; i++) {
            diffLines.push({ type: 'context', content: oldLines[i], oldLineNum: i + 1, newLineNum: i + 1 });
        }

        // Changed lines - removals first
        for (let i = prefixLen; i < oldLines.length - suffixLen; i++) {
            diffLines.push({ type: 'remove', content: oldLines[i], oldLineNum: i + 1 });
        }

        // Changed lines - additions
        for (let i = prefixLen; i < newLines.length - suffixLen; i++) {
            diffLines.push({ type: 'add', content: newLines[i], newLineNum: i + 1 });
        }

        // Context after (up to 3 lines)
        const contextAfterStart = Math.max(oldLines.length - suffixLen, 0);
        const contextAfterEnd = Math.min(contextAfterStart + 3, oldLines.length);
        for (let i = contextAfterStart; i < contextAfterEnd; i++) {
            const newI = newLines.length - (oldLines.length - i);
            diffLines.push({ type: 'context', content: oldLines[i], oldLineNum: i + 1, newLineNum: newI + 1 });
        }

        return diffLines;
    };

    const diffLines = generateDiff();
    const addedCount = diffLines.filter(l => l.type === 'add').length;
    const removedCount = diffLines.filter(l => l.type === 'remove').length;

    // Split into hunks: each hunk = [context] [add/remove block] [context] (max ±DIFF_CONTEXT_LINES)
    type DiffLine = { type: 'context' | 'add' | 'remove' | 'header'; content: string; oldLineNum?: number; newLineNum?: number };
    const nonHeaderLines = diffLines.filter((l): l is DiffLine => l.type !== 'header');
    const hunks: DiffLine[][] = [];
    let i = 0;
    while (i < nonHeaderLines.length) {
        const hunk: DiffLine[] = [];
        // Skip leading context (keep up to DIFF_CONTEXT_LINES at start of hunk)
        let contextCount = 0;
        while (i < nonHeaderLines.length && nonHeaderLines[i].type === 'context' && contextCount < DIFF_CONTEXT_LINES) {
            hunk.push(nonHeaderLines[i]);
            i++;
            contextCount++;
        }
        // Skip extra leading context (collapse)
        while (i < nonHeaderLines.length && nonHeaderLines[i].type === 'context') {
            i++;
        }
        // Take all add/remove until next context block
        while (i < nonHeaderLines.length && (nonHeaderLines[i].type === 'add' || nonHeaderLines[i].type === 'remove')) {
            hunk.push(nonHeaderLines[i]);
            i++;
        }
        // Take up to DIFF_CONTEXT_LINES trailing context
        let trail = 0;
        while (i < nonHeaderLines.length && nonHeaderLines[i].type === 'context' && trail < DIFF_CONTEXT_LINES) {
            hunk.push(nonHeaderLines[i]);
            i++;
            trail++;
        }
        // Skip trailing context beyond DIFF_CONTEXT_LINES
        while (i < nonHeaderLines.length && nonHeaderLines[i].type === 'context') {
            i++;
        }
        if (hunk.length > 0) hunks.push(hunk);
    }
    const headerLines = diffLines.filter(l => l.type === 'header');
    const useHunks = !expandAll && diffLines.length > DIFF_HUNK_THRESHOLD && hunks.length > 0;

    return (
        <div className="flex flex-col h-full">
            {/* AI-generated change summary at top */}
            {proposal.description && (
                <div className="px-3 py-2 bg-muted/50 border-b border-border">
                    <p className="text-xs font-medium text-muted-foreground mb-0.5">Summary</p>
                    <p className="text-sm text-foreground">{proposal.description}</p>
                </div>
            )}

            {/* File Header */}
            <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border flex-wrap">
                <span className="text-sm font-medium truncate">{proposal.path}</span>
                <span className={cn(
                    "text-xs px-1.5 py-0.5 rounded capitalize shrink-0",
                    proposal.operation === 'create' && "bg-green-500/20 text-green-500",
                    proposal.operation === 'modify' && "bg-yellow-500/20 text-yellow-500",
                    proposal.operation === 'delete' && "bg-red-500/20 text-red-500",
                )}>
                    {proposal.operation}
                </span>
                {/* Line change summary */}
                <div className="ml-auto flex items-center gap-2 text-xs shrink-0">
                    {addedCount > 0 && (
                        <span className="font-mono" style={{ color: 'var(--diff-add-text)' }}>+{addedCount}</span>
                    )}
                    {removedCount > 0 && (
                        <span className="font-mono" style={{ color: 'var(--diff-remove-text)' }}>-{removedCount}</span>
                    )}
                    {/* Expand All / Collapse */}
                    {diffLines.length > DIFF_HUNK_THRESHOLD && (
                        <button
                            type="button"
                            onClick={() => setExpandAll((e) => !e)}
                            className="px-2 py-0.5 rounded border border-border bg-background hover:bg-muted text-xs font-medium"
                        >
                            {expandAll ? 'Collapse' : 'Expand All'}
                        </button>
                    )}
                </div>
            </div>

            {/* Unified Diff View (hunks or full) */}
            <div className="flex-1 overflow-auto font-mono text-xs" data-lang={proposal.path.split('.').pop() || 'text'}>
                {headerLines.map((line, index) => (
                    <div
                        key={`h-${index}`}
                        className={cn("flex", line.type === 'header' && "bg-muted/50 border-b border-border")}
                        style={{
                            backgroundColor: line.type === 'add' ? 'var(--diff-add-bg)' : line.type === 'remove' ? 'var(--diff-remove-bg)' : undefined,
                        }}
                    >
                        <div className="flex-1 flex">
                            <span className="w-5 text-center select-none shrink-0 font-bold" style={{ color: 'var(--diff-context-text)' }}> </span>
                            <pre className="flex-1 whitespace-pre-wrap break-words px-2 py-0.5 text-muted-foreground italic py-1 px-3">{line.content}</pre>
                        </div>
                    </div>
                ))}
                {useHunks
                    ? hunks.map((hunk, hi) => (
                        <div key={hi} className="border-b border-border/50">
                            {hunk.map((line, index) => (
                                <DiffLineRow key={`${hi}-${index}`} line={line} />
                            ))}
                        </div>
                    ))
                    : diffLines.filter(l => l.type !== 'header').map((line, index) => (
                        <DiffLineRow key={index} line={line} />
                    ))
                }
            </div>

            {proposal.description && (
                <div className="px-3 py-2 bg-muted/30 border-t border-border">
                    <p className="text-xs text-muted-foreground">
                        {proposal.description}
                    </p>
                </div>
            )}
        </div>
    );
}

/**
 * Approve Tab - Batch approval controls
 */
function ApproveTab({
    proposals,
    approvalState,
    onApproveAll,
    onRejectAll,
    onExecuteSelected,
    isExecuting = false
}: {
    proposals: FileProposal[];
    approvalState: { approved: string[]; rejected: string[] };
    onApproveAll: () => void;
    onRejectAll: () => void;
    onExecuteSelected: () => void;
    isExecuting?: boolean;
}) {
    const approvedCount = approvalState.approved.length;
    const rejectedCount = approvalState.rejected.length;
    const pendingCount = proposals.length - approvedCount - rejectedCount;

    return (
        <div className="flex flex-col h-full p-4">
            {/* Stats */}
            <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="flex flex-col items-center p-3 rounded-lg bg-muted/30 border border-border">
                    <span className="text-2xl font-bold text-foreground">{pendingCount}</span>
                    <span className="text-xs text-muted-foreground">Pending</span>
                </div>
                <div className="flex flex-col items-center p-3 rounded-lg bg-green-500/10 border border-green-500/30">
                    <span className="text-2xl font-bold text-green-500">{approvedCount}</span>
                    <span className="text-xs text-green-500">Selected</span>
                </div>
                <div className="flex flex-col items-center p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                    <span className="text-2xl font-bold text-red-500">{rejectedCount}</span>
                    <span className="text-xs text-red-500">Rejected</span>
                </div>
            </div>

            {/* Instructions */}
            <p className="text-xs text-muted-foreground mb-4">
                Toggle files in the Files tab, then execute selected or use batch actions below.
            </p>

            {/* Primary: Execute Selected */}
            {approvedCount > 0 && (
                <button
                    onClick={onExecuteSelected}
                    disabled={isExecuting}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 mb-4 rounded-lg bg-gradient-to-r from-green-500 to-emerald-500 text-white font-medium hover:from-green-600 hover:to-emerald-600 transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isExecuting ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                        <Check className="w-5 h-5" />
                    )}
                    Execute Selected ({approvedCount})
                </button>
            )}

            {/* Batch Actions */}
            <div className="flex gap-3">
                <button
                    onClick={onApproveAll}
                    disabled={isExecuting}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-green-500/20 text-green-600 border border-green-500/30 font-medium hover:bg-green-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isExecuting ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                        <CheckCircle2 className="w-4 h-4" />
                    )}
                    Approve All
                </button>
                <button
                    onClick={onRejectAll}
                    disabled={isExecuting}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-red-500/20 text-red-600 border border-red-500/30 font-medium hover:bg-red-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isExecuting ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                        <XCircle className="w-4 h-4" />
                    )}
                    Reject All
                </button>
            </div>

            {/* Summary */}
            <div className="mt-auto pt-6 border-t border-border">
                <h4 className="text-sm font-medium mb-2">Summary</h4>
                <ul className="space-y-1 text-xs text-muted-foreground">
                    {proposals.map(p => {
                        const isApproved = approvalState.approved.includes(p.id);
                        const isRejected = approvalState.rejected.includes(p.id);
                        const displayName = p.operation === 'command'
                            ? (p.command?.split(' ').slice(0, 3).join(' ') + '...' || 'Command')
                            : p.path.split('/').pop();

                        return (
                            <li key={p.id} className="flex items-center gap-2">
                                {isApproved && <CheckCircle2 className="w-3 h-3 text-green-500" />}
                                {isRejected && <XCircle className="w-3 h-3 text-red-500" />}
                                {!isApproved && !isRejected && <div className="w-3 h-3 rounded-full border border-muted-foreground" />}
                                <span className={cn(isRejected && "line-through")}>
                                    {p.operation} {displayName}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            </div>
        </div>
    );
}

export default FileDiffPanel;
