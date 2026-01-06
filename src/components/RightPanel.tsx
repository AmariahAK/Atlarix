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
import { rightPanelVisibleAtom, rightPanelWidthAtom, pinnedPanelAtom } from '@/atoms/sourceAtoms';
import { chatInputValueAtom } from '@/atoms/chatAtoms';
import SourcePreviewPanel from './preview_panel/SourcePreviewPanel';
import FileDiffPanel from './preview_panel/FileDiffPanel';
import DiagramPanel from './preview_panel/DiagramPanel';
import CodePreviewPanel from './preview_panel/CodePreviewPanel';
import { TimelineView } from './DiagramTimeline';
import { PermissionQueuePanel } from './PermissionQueuePanel';
import { cn } from '@/lib/utils';
import {
    X, Terminal, Wrench,
    Search, Code, Workflow, Eye,
    AlertTriangle, Shield, Globe, Code2, FileText
} from 'lucide-react';
import { ToolCallCard, ToolCallData, ToolStatus } from './ToolCallCard';
import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import { type PanelType, type PanelTab } from '@/atoms/sourceAtoms';

// Icon configuration for secondary tabs
const TAB_ICONS: Record<PanelTab, { icon: React.ElementType; label: string }> = {
    preview: { icon: Eye, label: 'Preview' },
    code: { icon: Code2, label: 'Code' },
    terminal: { icon: Terminal, label: 'Terminal' },
    errors: { icon: AlertTriangle, label: 'Errors' },
    permissions: { icon: Shield, label: 'Permissions' },
    search: { icon: Globe, label: 'Search' },
    sources: { icon: Globe, label: 'Sources' },
    diagram: { icon: Workflow, label: 'Diagram' },
    logs: { icon: FileText, label: 'Logs' },
    files: { icon: FileText, label: 'Files' },
    diff: { icon: Code2, label: 'Diff' },
    approve: { icon: Shield, label: 'Approve' },
    timeline: { icon: Workflow, label: 'Timeline' },
    permission: { icon: Shield, label: 'Permission' },
    tools: { icon: Wrench, label: 'Tools' },
    debug: { icon: Terminal, label: 'Debug' },
};

// Primary mode categories for the toolbar
type PrimaryMode = 'search' | 'code' | 'diagrams' | 'preview' | 'tools';

// Map panel types to primary modes
const PANEL_TYPE_TO_MODE: Record<PanelType, PrimaryMode> = {
    'web-search': 'search',
    'code-preview': 'preview',
    'diagram': 'diagrams',
    'terminal': 'code',
    'file-diff': 'code',
    'files': 'code',
    'tools': 'tools',
    'timeline': 'diagrams',
    'permission': 'code',  // Permission requests appear in Code mode
    'empty': 'search',
};

export function RightPanel() {
    const { context, setActiveTab } = useRightPanelContext();
    const [isVisible, setIsVisible] = useAtom(rightPanelVisibleAtom);
    const [width, setWidth] = useAtom(rightPanelWidthAtom);
    const [pinnedPanel, setPinnedPanel] = useAtom(pinnedPanelAtom);
    const setChatInput = useSetAtom(chatInputValueAtom);

    // Handle "Solve with AI" button click - pre-fills chat with error context
    const handleSolveWithAI = useCallback((error: { message: string; source?: string; stack?: string }) => {
        const prompt = `Please fix this error in my application:

**Error:** ${error.message}
${error.source ? `**File:** ${error.source}` : ''}
${error.stack ? `
**Stack Trace:**
\`\`\`
${error.stack}
\`\`\`` : ''}

Please identify the issue and provide a fix.`;

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
            'diagrams': 'diagram',
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
            className={cn(
                "relative flex flex-col h-full bg-background border-l border-border flex-none",
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

            {/* Drag Resize Handle - positioned at left edge */}
            <div
                onMouseDown={handleMouseDown}
                className={cn(
                    "absolute left-0 top-0 bottom-0 w-3 -ml-1.5 cursor-col-resize z-50",
                    "hover:bg-primary/30 transition-colors",
                    isDragging && "bg-primary/50"
                )}
                style={{ touchAction: 'none' }}
            />

            {/* Icon Toolbar - Simple like reference app */}
            <TooltipProvider>
                <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                    {/* Mode Icons */}
                    <div className="flex items-center gap-1">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    onClick={() => handleModeClick('search')}
                                    className={cn(
                                        "p-2 rounded-lg transition-colors",
                                        currentMode === 'search'
                                            ? "bg-primary/15 text-primary"
                                            : "text-muted-foreground hover:text-foreground hover:bg-muted"
                                    )}
                                >
                                    <Search size={iconSize} />
                                </button>
                            </TooltipTrigger>
                            <TooltipContent>Search Results</TooltipContent>
                        </Tooltip>

                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    onClick={() => handleModeClick('code')}
                                    className={cn(
                                        "p-2 rounded-lg transition-colors",
                                        currentMode === 'code'
                                            ? "bg-primary/15 text-primary"
                                            : "text-muted-foreground hover:text-foreground hover:bg-muted"
                                    )}
                                >
                                    <Code size={iconSize} />
                                </button>
                            </TooltipTrigger>
                            <TooltipContent>Code & Permissions</TooltipContent>
                        </Tooltip>

                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    onClick={() => handleModeClick('diagrams')}
                                    className={cn(
                                        "p-2 rounded-lg transition-colors",
                                        currentMode === 'diagrams'
                                            ? "bg-primary/15 text-primary"
                                            : "text-muted-foreground hover:text-foreground hover:bg-muted"
                                    )}
                                >
                                    <Workflow size={iconSize} />
                                </button>
                            </TooltipTrigger>
                            <TooltipContent>Diagrams</TooltipContent>
                        </Tooltip>

                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    onClick={() => handleModeClick('preview')}
                                    className={cn(
                                        "p-2 rounded-lg transition-colors",
                                        currentMode === 'preview'
                                            ? "bg-primary/15 text-primary"
                                            : "text-muted-foreground hover:text-foreground hover:bg-muted"
                                    )}
                                >
                                    <Eye size={iconSize} />
                                </button>
                            </TooltipTrigger>
                            <TooltipContent>Live Preview</TooltipContent>
                        </Tooltip>
                    </div>

                    {/* Close button */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                onClick={() => setIsVisible(false)}
                                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>Close panel</TooltipContent>
                    </Tooltip>
                </div>
            </TooltipProvider>

            {/* Secondary Tabs (context-specific) */}
            {/* Secondary Tabs - Icon-only with tooltips */}
            {context.tabs.length > 1 && (
                <TooltipProvider>
                    <div className="flex items-center gap-1 px-3 py-2 border-b border-border/50 bg-muted/20 overflow-x-auto flex-shrink-0">
                        {context.tabs.map((tab) => {
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
                <PanelContent context={context} onSolveWithAI={handleSolveWithAI} />
            </div>
        </div>
    );
}

/**
 * Renders the appropriate panel content based on context type
 */
function PanelContent({
    context,
    onSolveWithAI
}: {
    context: ReturnType<typeof useRightPanelContext>['context'];
    onSolveWithAI?: (error: { message: string; source?: string; stack?: string }) => void;
}) {
    switch (context.type) {
        case 'web-search':
            return <SourcePreviewPanel data={context.data} activeTab={context.activeTab} />;

        case 'file-diff':
            return <FileDiffPanel data={context.data} activeTab={context.activeTab} />;

        case 'code-preview':
            return (
                <CodePreviewPanel
                    data={context.data}
                    activeTab={context.activeTab}
                    onSolveWithAI={onSolveWithAI}
                />
            );

        case 'diagram':
            return <DiagramPanel data={context.data} activeTab={context.activeTab} />;

        case 'terminal':
            return <TerminalPanel data={context.data} />;

        case 'timeline':
            // Timeline panel for workspace diagram snapshots
            return <TimelineView appId={context.data?.appId || 0} />;

        case 'tools':
            // Tool execution activity panel
            return <ToolsPanel data={context.data} />;

        case 'permission':
            // New permission queue panel with status sections
            return <PermissionQueuePanel chatId={context.data?.chatId} />;

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
                        <li><strong>Diagrams</strong> - Architecture views</li>
                        <li><strong>Preview</strong> - Live preview</li>
                    </ul>
                    <p className="text-xs mt-4 opacity-60">
                        Content will appear here as you chat
                    </p>
                </div>
            );
    }
}

/**
 * Terminal Panel - Simple inline component for terminal output
 */
function TerminalPanel({ data }: { data: any }) {
    if (!data) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
                <Terminal className="w-12 h-12 mb-3 opacity-50" />
                <p className="text-sm">No terminal output</p>
                <p className="text-xs">Command output will appear here</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-[#1e1e1e]">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-700 bg-zinc-900">
                <Terminal className="w-4 h-4 text-zinc-400" />
                <span className="text-sm text-zinc-300">Terminal</span>
                {data.status === 'running' && (
                    <span className="ml-auto text-xs px-2 py-0.5 rounded bg-green-500/20 text-green-400">
                        Running
                    </span>
                )}
            </div>
            <div className="flex-1 overflow-auto p-4 font-mono text-xs text-zinc-300 whitespace-pre-wrap">
                {data.output || 'No output'}
            </div>
        </div>
    );
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
