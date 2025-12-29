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
import { useAtom, useAtomValue } from 'jotai';
import { rightPanelVisibleAtom, rightPanelWidthAtom, pinnedPanelAtom } from '@/atoms/sourceAtoms';
import SourcePreviewPanel from './preview_panel/SourcePreviewPanel';
import FileDiffPanel from './preview_panel/FileDiffPanel';
import DiagramPanel from './preview_panel/DiagramPanel';
import CodePreviewPanel from './preview_panel/CodePreviewPanel';
import { TimelineView } from './DiagramTimeline';
import { cn } from '@/lib/utils';
import {
    Pin, PinOff, X, Maximize2, Minimize2, Terminal, Wrench,
    Search, Code, Workflow, Eye, MoreVertical
} from 'lucide-react';
import { ToolCallCard, ToolCallData, ToolStatus } from './ToolCallCard';
import { motion } from 'framer-motion';
import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import { type PanelType } from '@/atoms/sourceAtoms';

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
    'empty': 'search',
};

export function RightPanel() {
    const { context, isPinned, pin, unpin, setActiveTab } = useRightPanelContext();
    const [isVisible, setIsVisible] = useAtom(rightPanelVisibleAtom);
    const [width, setWidth] = useAtom(rightPanelWidthAtom);
    const [pinnedPanel, setPinnedPanel] = useAtom(pinnedPanelAtom);

    // Track which primary mode is selected
    const currentMode = PANEL_TYPE_TO_MODE[context.type] || 'search';

    // Refs for animated indicator
    const searchRef = useRef<HTMLButtonElement>(null);
    const codeRef = useRef<HTMLButtonElement>(null);
    const diagramsRef = useRef<HTMLButtonElement>(null);
    const previewRef = useRef<HTMLButtonElement>(null);
    const toolsRef = useRef<HTMLButtonElement>(null);
    const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });

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

    // Update indicator position when mode changes
    useEffect(() => {
        const refs: Record<PrimaryMode, React.RefObject<HTMLButtonElement | null>> = {
            'search': searchRef,
            'code': codeRef,
            'diagrams': diagramsRef,
            'preview': previewRef,
            'tools': toolsRef,
        };

        const targetRef = refs[currentMode];
        if (targetRef.current) {
            const button = targetRef.current;
            const container = button.parentElement;
            if (container) {
                const containerRect = container.getBoundingClientRect();
                const buttonRect = button.getBoundingClientRect();
                setIndicatorStyle({
                    left: buttonRect.left - containerRect.left,
                    width: buttonRect.width,
                });
            }
        }
    }, [currentMode]);

    // Don't render if not visible
    if (!isVisible) {
        return null;
    }

    const iconSize = 16;

    return (
        <div
            className="flex flex-col h-full border-l border-border bg-background animate-slide-in-right"
            style={{ width: `${width}px`, minWidth: '300px', maxWidth: '600px' }}
        >
            {/* Primary Toolbar - ActionHeader style */}
            <TooltipProvider>
                <div className="flex items-center justify-between px-2 py-2 border-b border-border">
                    {/* Mode Buttons with animated indicator */}
                    <div className="relative flex rounded-md p-0.5 gap-0.5">
                        <motion.div
                            className="absolute top-0.5 bottom-0.5 bg-primary/10 shadow rounded-md"
                            animate={{
                                left: indicatorStyle.left,
                                width: indicatorStyle.width,
                            }}
                            transition={{
                                type: "spring",
                                stiffness: 600,
                                damping: 35,
                                mass: 0.6,
                            }}
                        />

                        <ModeButton
                            ref={searchRef}
                            icon={<Search size={iconSize} />}
                            label="Search"
                            isActive={currentMode === 'search'}
                            onClick={() => handleModeClick('search')}
                        />
                        <ModeButton
                            ref={codeRef}
                            icon={<Code size={iconSize} />}
                            label="Code"
                            isActive={currentMode === 'code'}
                            onClick={() => handleModeClick('code')}
                        />
                        <ModeButton
                            ref={diagramsRef}
                            icon={<Workflow size={iconSize} />}
                            label="Diagrams"
                            isActive={currentMode === 'diagrams'}
                            onClick={() => handleModeClick('diagrams')}
                        />
                        <ModeButton
                            ref={previewRef}
                            icon={<Eye size={iconSize} />}
                            label="Preview"
                            isActive={currentMode === 'preview'}
                            onClick={() => handleModeClick('preview')}
                        />
                        {/* Tools button removed - ThinkingCard shows tool activity */}
                    </div>

                    {/* Controls */}
                    <div className="flex items-center gap-0.5">
                        {/* Pin/Unpin */}
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    onClick={isPinned ? unpin : pin}
                                    className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                                >
                                    {isPinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
                                </button>
                            </TooltipTrigger>
                            <TooltipContent>{isPinned ? "Unpin panel" : "Pin panel"}</TooltipContent>
                        </Tooltip>

                        {/* Resize toggle */}
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    onClick={() => setWidth(width === 400 ? 550 : 400)}
                                    className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                                >
                                    {width === 400 ? <Maximize2 className="w-4 h-4" /> : <Minimize2 className="w-4 h-4" />}
                                </button>
                            </TooltipTrigger>
                            <TooltipContent>{width === 400 ? "Expand panel" : "Collapse panel"}</TooltipContent>
                        </Tooltip>

                        {/* Close */}
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
                </div>
            </TooltipProvider>

            {/* Secondary Tabs (context-specific) */}
            {context.tabs.length > 1 && (
                <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border/50 bg-muted/20">
                    {context.tabs.map((tab) => (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab)}
                            className={cn(
                                "px-2 py-1 text-xs rounded transition-colors capitalize",
                                context.activeTab === tab
                                    ? "bg-primary/10 text-primary font-medium"
                                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                            )}
                        >
                            {tab}
                        </button>
                    ))}
                </div>
            )}

            {/* Panel Content */}
            <div className="flex-1 overflow-hidden">
                <PanelContent context={context} />
            </div>
        </div>
    );
}

/**
 * Mode button component for primary toolbar
 */
interface ModeButtonProps {
    icon: React.ReactNode;
    label: string;
    isActive: boolean;
    onClick: () => void;
}

const ModeButton = React.forwardRef<HTMLButtonElement, ModeButtonProps>(
    ({ icon, label, isActive, onClick }, ref) => (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    ref={ref}
                    onClick={onClick}
                    className={cn(
                        "relative flex flex-col items-center gap-0.5 px-2 py-1 rounded-md text-xs font-medium z-10 transition-colors",
                        isActive
                            ? "text-primary"
                            : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                    )}
                >
                    {icon}
                    <span className="hidden sm:block">{label}</span>
                </button>
            </TooltipTrigger>
            <TooltipContent className="sm:hidden">{label}</TooltipContent>
        </Tooltip>
    )
);
ModeButton.displayName = 'ModeButton';

/**
 * Renders the appropriate panel content based on context type
 */
function PanelContent({ context }: { context: ReturnType<typeof useRightPanelContext>['context'] }) {
    switch (context.type) {
        case 'web-search':
            return <SourcePreviewPanel data={context.data} activeTab={context.activeTab} />;

        case 'file-diff':
            return <FileDiffPanel data={context.data} activeTab={context.activeTab} />;

        case 'code-preview':
            return <CodePreviewPanel data={context.data} activeTab={context.activeTab} />;

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

