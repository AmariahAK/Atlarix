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
import { useSearch } from '@tanstack/react-router';
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

    // Get chatId from search params
    let chatId: number | undefined;
    try {
        const search = useSearch({ from: "/chat" });
        chatId = search?.id;
    } catch {
        // Not on chat route, chatId will be undefined
    }

    // Group proposals by directory
    const groupedProposals = useMemo(() => {
        const groups: Record<string, FileProposal[]> = {};
        proposals.forEach(p => {
            const dir = p.path.split('/').slice(0, -1).join('/') || '/';
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

    if (proposals.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
                <FolderOpen className="w-12 h-12 mb-3 opacity-50" />
                <p className="text-sm">No pending changes</p>
                <p className="text-xs">File proposals will appear here</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {activeTab === 'files' && (
                <FilesTab
                    groupedProposals={groupedProposals}
                    selectedProposal={selectedProposal}
                    approvalState={approvalState}
                    onSelectProposal={setSelectedProposal}
                    onToggleApproval={handleToggleApproval}
                />
            )}
            {activeTab === 'diff' && (
                <DiffTab proposal={selectedProposal} />
            )}
            {activeTab === 'approve' && (
                <ApproveTab
                    proposals={proposals}
                    approvalState={approvalState}
                    onApproveAll={handleApproveAll}
                    onRejectAll={handleRejectAll}
                    isExecuting={isExecuting}
                />
            )}
        </div>
    );
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
        create: { icon: FilePlus, color: 'text-green-500', label: '✨' },
        modify: { icon: FileEdit, color: 'text-yellow-500', label: '📝' },
        delete: { icon: Trash2, color: 'text-red-500', label: '🗑️' },
        rename: { icon: FileEdit, color: 'text-blue-500', label: '📝' },
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
                                const opInfo = opIcons[proposal.operation];
                                const isApproved = approvalState.approved.includes(proposal.id);
                                const isRejected = approvalState.rejected.includes(proposal.id);
                                const isSelected = selectedProposal?.id === proposal.id;
                                const fileName = proposal.path.split('/').pop();

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

                                        {/* File Name */}
                                        <span className="flex-1 text-sm truncate">
                                            {fileName}
                                        </span>

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

/**
 * Diff Tab - Monaco diff viewer (simplified for now)
 */
function DiffTab({ proposal }: { proposal: FileProposal | null }) {
    if (!proposal) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
                <File className="w-12 h-12 mb-3 opacity-50" />
                <p className="text-sm">Select a file to view changes</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* File Header */}
            <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border">
                <span className="text-sm font-medium">{proposal.path}</span>
                <span className={cn(
                    "text-xs px-1.5 py-0.5 rounded capitalize",
                    proposal.operation === 'create' && "bg-green-500/20 text-green-500",
                    proposal.operation === 'modify' && "bg-yellow-500/20 text-yellow-500",
                    proposal.operation === 'delete' && "bg-red-500/20 text-red-500",
                )}>
                    {proposal.operation}
                </span>
            </div>

            {/* Diff Content (simplified - would use Monaco in full implementation) */}
            <div className="flex-1 overflow-auto p-3 font-mono text-xs">
                {proposal.operation === 'delete' ? (
                    <div className="bg-red-500/10 p-3 rounded border border-red-500/30">
                        <p className="text-red-500 mb-2">File will be deleted:</p>
                        <pre className="text-muted-foreground whitespace-pre-wrap">
                            {proposal.oldContent || '(content not available)'}
                        </pre>
                    </div>
                ) : proposal.operation === 'create' ? (
                    <div className="bg-green-500/10 p-3 rounded border border-green-500/30">
                        <p className="text-green-500 mb-2">New file:</p>
                        <pre className="text-foreground whitespace-pre-wrap">
                            {proposal.newContent || '(content not available)'}
                        </pre>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {proposal.oldContent && (
                            <div className="bg-red-500/10 p-3 rounded border border-red-500/30">
                                <p className="text-red-500 mb-2">- Old:</p>
                                <pre className="text-muted-foreground whitespace-pre-wrap">
                                    {proposal.oldContent}
                                </pre>
                            </div>
                        )}
                        {proposal.newContent && (
                            <div className="bg-green-500/10 p-3 rounded border border-green-500/30">
                                <p className="text-green-500 mb-2">+ New:</p>
                                <pre className="text-foreground whitespace-pre-wrap">
                                    {proposal.newContent}
                                </pre>
                            </div>
                        )}
                    </div>
                )}

                {proposal.description && (
                    <div className="mt-4 p-3 bg-muted/30 rounded border border-border">
                        <p className="text-xs text-muted-foreground">
                            {proposal.description}
                        </p>
                    </div>
                )}
            </div>
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
    isExecuting = false
}: {
    proposals: FileProposal[];
    approvalState: { approved: string[]; rejected: string[] };
    onApproveAll: () => void;
    onRejectAll: () => void;
    isExecuting?: boolean;
}) {
    const approvedCount = approvalState.approved.length;
    const rejectedCount = approvalState.rejected.length;
    const pendingCount = proposals.length - approvedCount - rejectedCount;

    return (
        <div className="flex flex-col h-full p-4">
            {/* Stats */}
            <div className="grid grid-cols-3 gap-3 mb-6">
                <div className="flex flex-col items-center p-3 rounded-lg bg-muted/30 border border-border">
                    <span className="text-2xl font-bold text-foreground">{pendingCount}</span>
                    <span className="text-xs text-muted-foreground">Pending</span>
                </div>
                <div className="flex flex-col items-center p-3 rounded-lg bg-green-500/10 border border-green-500/30">
                    <span className="text-2xl font-bold text-green-500">{approvedCount}</span>
                    <span className="text-xs text-green-500">Approved</span>
                </div>
                <div className="flex flex-col items-center p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                    <span className="text-2xl font-bold text-red-500">{rejectedCount}</span>
                    <span className="text-xs text-red-500">Rejected</span>
                </div>
            </div>

            {/* Batch Actions */}
            <div className="flex gap-3">
                <button
                    onClick={onApproveAll}
                    disabled={isExecuting}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-green-500 text-white font-medium hover:bg-green-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isExecuting ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                        <Check className="w-5 h-5" />
                    )}
                    Approve All
                </button>
                <button
                    onClick={onRejectAll}
                    disabled={isExecuting}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-red-500 text-white font-medium hover:bg-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isExecuting ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                        <X className="w-5 h-5" />
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
                        const fileName = p.path.split('/').pop();

                        return (
                            <li key={p.id} className="flex items-center gap-2">
                                {isApproved && <CheckCircle2 className="w-3 h-3 text-green-500" />}
                                {isRejected && <XCircle className="w-3 h-3 text-red-500" />}
                                {!isApproved && !isRejected && <div className="w-3 h-3 rounded-full border border-muted-foreground" />}
                                <span className={cn(isRejected && "line-through")}>
                                    {p.operation} {fileName}
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
