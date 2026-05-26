/**
 * RightPanel - Master Panel Router
 * =================================
 * Context-aware right panel that dynamically adapts based on current activity
 * 
 * Panel Types:
 * - web-search: Source cards + iframe preview
 * - code-preview: Live preview iframe (frontend)
 * - diagram: Architecture diagram (backend)
 * - terminal: Command output
 * - file-diff: File changes + approval
 * - empty: No content
 */

import React from 'react';
import { useRightPanelContext } from '@/hooks/useRightPanelContext';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useSearch } from '@tanstack/react-router';
import { rightPanelVisibleAtom, rightPanelWidthAtom, pinnedPanelAtom, rightPanelSuppressAutoOpenAtom } from '@/atoms/sourceAtoms';
import { chatInputValueAtom } from '@/atoms/chatAtoms';
import SourcePreviewPanel from './preview_panel/SourcePreviewPanel';
import FileDiffPanel from './preview_panel/FileDiffPanel';
import CodePreviewPanel from './preview_panel/CodePreviewPanel';
import { VaultPanel } from './preview_panel/VaultPanel';
import { TimelineView } from './DiagramTimeline';
import { PermissionQueuePanel } from './PermissionQueuePanel';
import { EmbeddedChatTab } from './panels/EmbeddedChatTab';
import { cn } from '@/lib/utils';
import {
    X, Terminal, Wrench,
    Search, Code, Workflow, Eye,
    AlertTriangle, Shield, Globe, Code2, FileText, KeyRound, MessageSquare, ListTree,
} from 'lucide-react';
import { TerminalPanel } from './panels/TerminalPanel';
import { ActivityPanel } from './panels/ActivityPanel';
import { type ParsedError } from '@/lib/devServerErrorParser';
import { ToolCallCard, ToolCallData, ToolStatus } from './ToolCallCard';
import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import { type PanelType, type PanelTab } from '@/atoms/sourceAtoms';
import { useWorkspacePlanPanel } from '@/hooks/useWorkspacePlanPanel';

// Icon configuration for secondary tabs
const TAB_ICONS: Record<PanelTab, { icon: React.ElementType; label: string }> = {
    preview: { icon: Eye, label: 'Preview' },
    code: { icon: Code2, label: 'Code' },
    terminal: { icon: Terminal, label: 'Terminal' },
    errors: { icon: AlertTriangle, label: 'Errors' },
    permissions: { icon: Shield, label: 'Permissions' },
    search: { icon: Globe, label: 'Search' },
    sources: { icon: Globe, label: 'Sources' },
    logs: { icon: FileText, label: 'Logs' },
    files: { icon: FileText, label: 'Files' },
    diff: { icon: Code2, label: 'Diff' },
    approve: { icon: Shield, label: 'Approve' },
    timeline: { icon: Workflow, label: 'Timeline' },
    permission: { icon: Shield, label: 'Permission' },
    tools: { icon: Wrench, label: 'Tools' },
    debug: { icon: Terminal, label: 'Debug' },
    vault: { icon: KeyRound, label: 'Vault' },
    activity: { icon: ListTree, label: 'Activity' },
    chat: { icon: MessageSquare, label: 'Chat' },
};

// Primary mode categories for the toolbar
type PrimaryMode = 'search' | 'code' | 'diagrams' | 'preview' | 'tools';

// Map panel types to primary modes
const PANEL_TYPE_TO_MODE: Record<PanelType, PrimaryMode> = {
    'web-search': 'search',
    'code-preview': 'preview',
    'terminal': 'code',
    'file-diff': 'code',
    'files': 'code',
    'tools': 'tools',
    'timeline': 'code',
    'permission': 'code',  // Permission requests appear in Code mode
    'empty': 'search',
};

export function RightPanel() {
    useWorkspacePlanPanel();
    const { context, setActiveTab } = useRightPanelContext();
    const [isVisible, setIsVisible] = useAtom(rightPanelVisibleAtom);
    const setSuppressRightAutoOpen = useSetAtom(rightPanelSuppressAutoOpenAtom);
    const [width, setWidth] = useAtom(rightPanelWidthAtom);
    const [pinnedPanel, setPinnedPanel] = useAtom(pinnedPanelAtom);
    const [chatInputValue, setChatInput] = useAtom(chatInputValueAtom);

    // Get chatId from URL route as fallback for PermissionQueuePanel
    let routeChatId: number | undefined;
    try {
        const searchParams = useSearch({ strict: false }) as unknown as { id?: number | string } | undefined;
        const id = searchParams?.id;
        routeChatId = id !== undefined && id !== null ? Number(id) : undefined;
    } catch {
        // Not on chat route, that's fine
    }

    // Handle "Solve with AI" button click - appends error context to existing chat input
    const handleSolveWithAI = useCallback((error: { message: string; file?: string; line?: number; stack?: string }) => {
        // Check if message already includes user suggestion (from Suggest button)
        const hasSuggestion = error.message.includes("User's suggestion:");

        let errorContext: string;
        if (hasSuggestion) {
            // Split message and suggestion (supports "User's suggestion:" or legacy "💡 User's suggestion:")
            const [errorPart, suggestionPart] = error.message.split(/\n\n(?:💡 )?User's suggestion:/);
            errorContext = `Please identify the issue and provide a fix.

Error: ${errorPart}${error.file ? `
File: ${error.file}${error.line ? `:${error.line}` : ''}` : ''}

User's suggestion:${suggestionPart}`;
        } else {
            errorContext = `Please identify the issue and provide a fix.

Error: ${error.message}${error.file ? `
File: ${error.file}${error.line ? `:${error.line}` : ''}` : ''}`;
        }

        // Append to existing input instead of replacing
        const existingInput = chatInputValue?.trim() || '';
        if (existingInput) {
            // User has typed something - append error context
            setChatInput(`${existingInput}\n\n---\n${errorContext.trim()}`);
        } else {
            // No existing input - just set the error
            setChatInput(errorContext.trim());
        }
    }, [chatInputValue, setChatInput]);

    // Handle "Fix All" button click - formats multiple errors for AI
    const handleSolveAllWithAI = useCallback((errors: ParsedError[], context: string) => {
        // Group errors by type for better organization
        const errorsByType = errors.reduce((acc, err) => {
            const type = err.type || 'unknown';
            if (!acc[type]) acc[type] = [];
            acc[type].push(err);
            return acc;
        }, {} as Record<string, ParsedError[]>);

        // Format errors list
        const errorsList = Object.entries(errorsByType)
            .map(([type, errs]) => {
                const header = `### ${type.toUpperCase()} ERRORS`;
                const items = errs.map((e, i) =>
                    `${i + 1}. **${e.file || 'Unknown file'}${e.line ? `:${e.line}` : ''}**\n   ${e.message}${e.stack ? `\n   \`\`\`\n   ${e.stack.slice(0, 200)}...\n   \`\`\`` : ''}`
                ).join('\n\n');
                return `${header}\n${items}`;
            })
            .join('\n\n---\n\n');

        const prompt = `Please fix the following ${errors.length} error${errors.length !== 1 ? 's' : ''} in my application:

${errorsList}
${context ? `
---

**Additional Context from User:**
${context}` : ''}

Please fix these errors in priority order (structural/build errors first, then runtime errors). Provide fixes for each error.`;

        setChatInput(prompt.trim());
    }, [setChatInput]);

    // Track which primary mode is selected
    const currentMode = PANEL_TYPE_TO_MODE[context.type] || 'search';

    // Drag resize state
    const [isDragging, setIsDragging] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);

    // Handle primary mode click - pins to appropriate panel type
    const handleModeClick = useCallback((mode: PrimaryMode) => {
        // Map mode back to panel type
        const modeToPanel: Record<PrimaryMode, PanelType> = {
            'search': 'web-search',
            'code': 'file-diff',
            'diagrams': 'code-preview',
            'preview': 'code-preview',
            'tools': 'tools',
        };
        setPinnedPanel(modeToPanel[mode]);
    }, [setPinnedPanel]);

    // Handle drag resize
    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        setIsDragging(true);
    }, []);

    useEffect(() => {
        if (!isDragging) return;

        const handleMouseMove = (e: MouseEvent) => {
            if (!panelRef.current) return;
            const containerRight = window.innerWidth;
            const newWidth = containerRight - e.clientX;
            // Clamp between min and max
            setWidth(Math.max(280, Math.min(700, newWidth)));
        };

        const handleMouseUp = () => {
            setIsDragging(false);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging, setWidth]);

    // Don't render if not visible
    if (!isVisible) {
        return null;
    }

    const iconSize = 18;

    return (
        <div
            ref={panelRef}
            data-tour="tour-activity-panel"
            className={cn(
                "relative flex flex-col h-full bg-background border-l border-border flex-none z-10",
                !isDragging && "animate-slide-in-right"
            )}
            style={{ width: `${width}px`, minWidth: '280px', maxWidth: '700px' }}
        >
            {/* Global Drag Overlay - Captures all mouse events during drag */}
            {isDragging && (
                <div
                    className="fixed inset-0 z-[9999] cursor-col-resize user-select-none"
                    style={{ touchAction: 'none' }}
                />
            )}

            {/* Fix: Finding 2 — visible resize grip + discoverability (see layout onboarding highlight) */}
            <TooltipProvider>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <div
                            data-onboarding="panel-resize-grip"
                            role="separator"
                            aria-orientation="vertical"
                            aria-label="Drag to resize panel"
                            title="Drag to resize panel"
                            onMouseDown={(e) => {
                                try {
                                    localStorage.setItem("atlarix_panel_resize_hint_shown", "1");
                                } catch {
                                    /* ignore */
                                }
                                handleMouseDown(e);
                            }}
                            className={cn(
                                "absolute left-0 top-0 bottom-0 w-3 -ml-1.5 cursor-col-resize z-50 flex items-center justify-center",
                                "hover:bg-primary/25 transition-colors group",
                                isDragging && "bg-primary/50"
                            )}
                            style={{ touchAction: 'none' }}
                        >
                            <span className="flex flex-col gap-0.5 pointer-events-none opacity-60 group-hover:opacity-100">
                                <span className="w-0.5 h-1 rounded-full bg-muted-foreground/80 mx-auto" />
                                <span className="w-0.5 h-1 rounded-full bg-muted-foreground/80 mx-auto" />
                                <span className="w-0.5 h-1 rounded-full bg-muted-foreground/80 mx-auto" />
                            </span>
                        </div>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="max-w-[14rem]">
                        Drag to resize the panel. Tabs switch between Preview, Code, Terminal, and more.
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>

            {/* Header with Close Button */}
            <div className="flex items-center justify-end px-3 py-2 border-b border-border">
                <TooltipProvider>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                onClick={() => { setSuppressRightAutoOpen(true); setIsVisible(false); }}
                                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>Close panel</TooltipContent>
                    </Tooltip>
                </TooltipProvider>
            </div>

            {/* Tab Navigation - Always visible */}
            {context.tabs.length > 0 && (
                <TooltipProvider>
                    <div className="flex flex-nowrap items-center gap-1 px-3 py-2 border-b border-border/50 bg-muted/20 overflow-x-auto flex-shrink-0 min-w-0">
                        {context.tabs.filter((tab) => !["diagram", "permissions", "permission", "approve"].includes(tab)).map((tab) => {
                            const tabConfig = TAB_ICONS[tab];
                            const Icon = tabConfig?.icon || Code2;
                            const label = tabConfig?.label || tab;
                            return (
                                <Tooltip key={tab}>
                                    <TooltipTrigger asChild>
                                        <button
                                            onClick={() => setActiveTab(tab)}
                                            aria-label={label}
                                            className={cn(
                                                "p-2 rounded-md transition-colors",
                                                context.activeTab === tab
                                                    ? "bg-primary/15 text-primary"
                                                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                                            )}
                                        >
                                            <Icon size={16} />
                                            <span className="sr-only">{label}</span>
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent>{label}</TooltipContent>
                                </Tooltip>
                            );
                        })}
                    </div>
                </TooltipProvider>
            )}


            {/* Panel Content - scrollable */}
            <div className="flex-1 overflow-auto">
                <PanelContent context={context} onSolveWithAI={handleSolveWithAI} onSolveAllWithAI={handleSolveAllWithAI} onSwitchToCode={() => setActiveTab('code')} setActiveTab={setActiveTab} fallbackChatId={routeChatId} />
            </div>
        </div>
    );
}

/**
 * Renders the appropriate panel content based on context type
 */
function PanelContent({
    context,
    onSolveWithAI,
    onSolveAllWithAI,
    onSwitchToCode,
    setActiveTab,
    fallbackChatId
}: {
    context: ReturnType<typeof useRightPanelContext>['context'];
    onSolveWithAI?: (error: { message: string; source?: string; stack?: string }) => void;
    onSolveAllWithAI?: (errors: ParsedError[], context: string) => void;
    onSwitchToCode?: () => void;
    setActiveTab?: (tab: import('@/atoms/sourceAtoms').PanelTab) => void;
    fallbackChatId?: number;
}) {
    // Chat tab (when chat area is hidden)
    if (context.activeTab === 'chat') {
        return <EmbeddedChatTab />;
    }

    // For file-diff and permission types, route based on activeTab
    if (context.type === 'file-diff' || context.type === 'permission') {
        switch (context.activeTab) {
            case 'permissions':
            case 'permission':
            case 'approve':
            case 'diff':
                return <PermissionQueuePanel chatId={context.data?.chatId ?? fallbackChatId} />;
            case 'preview':
            case 'code':
            case 'errors':
                return (
                    <CodePreviewPanel
                        data={context.data}
                        activeTab={context.activeTab}
                        onSolveWithAI={onSolveWithAI}
                        onSolveAllWithAI={onSolveAllWithAI}
                        onSwitchToCode={onSwitchToCode}
                    />
                );
            case 'diagram':
            case 'activity':
                return <ActivityPanel />;
            case 'terminal':
                return <TerminalPanel />;
            case 'search':
            case 'sources':
                return <SourcePreviewPanel data={context.data} activeTab="sources" />;
            case 'vault':
                // Per-workspace credential vault (.env style) for MCP / local secrets — not a hosted OAuth broker.
                return <VaultPanel appId={context.data?.appId ?? null} />;
            default:
                // Default to permission queue
                return <PermissionQueuePanel chatId={context.data?.chatId ?? fallbackChatId} />;
        }
    }

    switch (context.type) {
        case 'web-search':
            return <SourcePreviewPanel data={context.data} activeTab={context.activeTab} />;

        case 'code-preview':
            if (context.activeTab === 'vault') {
                return <VaultPanel appId={context.data?.appId ?? null} />;
            }
            if (context.activeTab === 'terminal') {
                return <TerminalPanel />;
            }
            if (context.activeTab === 'activity') {
                return <ActivityPanel />;
            }
            return (
                <CodePreviewPanel
                    data={context.data}
                    activeTab={context.activeTab}
                    onSolveWithAI={onSolveWithAI}
                    onSolveAllWithAI={onSolveAllWithAI}
                    onSwitchToCode={onSwitchToCode}
                />
            );

        case 'diagram':
            return <ActivityPanel />;

        case 'terminal':
            return <TerminalPanel />;

        case 'timeline':
            // Timeline panel for workspace diagram snapshots
            return <TimelineView appId={context.data?.appId || 0} />;

        case 'tools':
            // Tool execution activity panel
            return <ToolsPanel data={context.data} />;

        default:
            return (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-6 text-center">
                    <div className="w-16 h-16 mb-4 rounded-full bg-muted/50 flex items-center justify-center">
                        <Search className="w-8 h-8 opacity-50" />
                    </div>
                    <h3 className="text-sm font-medium mb-2 text-foreground">No content yet</h3>
                    <p className="text-xs max-w-[200px]">
                        Use the toolbar above to switch between modes:
                    </p>
                    <ul className="text-xs mt-3 space-y-1 text-left">
                        <li><strong>Search</strong> - Web search results</li>
                        <li><strong>Code</strong> - File changes & diffs</li>
                        <li><strong>Activity</strong> - Tool and session activity</li>
                        <li><strong>Preview</strong> - Live preview</li>
                    </ul>
                    <p className="text-xs mt-4 opacity-60">
                        Content will appear here as you chat
                    </p>
                </div>
            );
    }
}


export default RightPanel;

/**
 * Tools Panel - Display tool execution activity
 * Used primarily for Ask mode to show tool calls and results
 */
function ToolsPanel({ data }: { data: any }) {
    const timeline = data?.timeline || [];

    if (timeline.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
                <Wrench className="w-12 h-12 mb-3 opacity-50" />
                <p className="text-sm font-medium">No Tool Activity</p>
                <p className="text-xs text-center mt-1">
                    Tool calls and results will appear here
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-background">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
                <Wrench className="w-4 h-4 text-teal-400" />
                <span className="text-sm font-medium">Tool Activity</span>
                <span className="ml-auto text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">
                    {timeline.length} tool{timeline.length !== 1 ? 's' : ''}
                </span>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {timeline.map((tool: any, index: number) => {
                    // Map ToolExecution status to ToolCallCard status
                    const mappedStatus: ToolStatus =
                        tool.status === 'completed' ? 'complete' :
                            tool.status === 'running' ? 'running' :
                                tool.status === 'error' ? 'error' : 'pending';

                    return (
                        <ToolCallCard
                            key={tool.id || index}
                            tool={{
                                id: tool.id,
                                name: tool.name,
                                status: mappedStatus,
                                params: tool.params,
                                result: tool.result,
                                error: tool.error,
                                duration: tool.duration,
                            }}
                        />
                    );
                })}
            </div>
        </div>
    );
}

/**
 * Permission Panel - Display pending permission requests
 * Shows tool operations awaiting user approval
 */
function PermissionPanel({ data }: { data: any }) {
    const operationId = data?.operationId;
    const message = data?.message;

    // If no specific operation, show empty state
    if (!operationId && !message) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
                <div className="w-16 h-16 mb-4 rounded-full bg-muted/50 flex items-center justify-center">
                    <Wrench className="w-8 h-8 opacity-50" />
                </div>
                <p className="text-sm font-medium mb-2">No Pending Permissions</p>
                <p className="text-xs text-center">
                    Permission requests will appear here when the AI needs approval
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-background">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
                <Wrench className="w-4 h-4 text-amber-400" />
                <span className="text-sm font-medium">Permission Required</span>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
                {message && (
                    <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                        <p className="text-sm text-amber-700 dark:text-amber-300">{message}</p>
                    </div>
                )}
                <div className="text-xs text-muted-foreground">
                    <p>Operation ID: {operationId || 'N/A'}</p>
                    <p className="mt-2">
                        Use the permission panel in the chat input area to approve or reject this operation.
                    </p>
                </div>
            </div>
        </div>
    );
}
