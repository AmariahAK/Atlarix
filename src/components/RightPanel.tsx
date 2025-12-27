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

import { useRightPanelContext } from '@/hooks/useRightPanelContext';
import { useAtom } from 'jotai';
import { rightPanelVisibleAtom, rightPanelWidthAtom } from '@/atoms/sourceAtoms';
import SourcePreviewPanel from './preview_panel/SourcePreviewPanel';
import FileDiffPanel from './preview_panel/FileDiffPanel';
import DiagramPanel from './preview_panel/DiagramPanel';
import CodePreviewPanel from './preview_panel/CodePreviewPanel';
import { TimelineView } from './DiagramTimeline';
import { cn } from '@/lib/utils';
import { Pin, PinOff, X, Maximize2, Minimize2, Terminal } from 'lucide-react';

export function RightPanel() {
    const { context, isPinned, pin, unpin, setActiveTab } = useRightPanelContext();
    const [isVisible, setIsVisible] = useAtom(rightPanelVisibleAtom);
    const [width, setWidth] = useAtom(rightPanelWidthAtom);

    // Don't render if not visible or no content
    if (!isVisible || context.type === 'empty') {
        return null;
    }

    return (
        <div
            className="flex flex-col h-full border-l border-border bg-background animate-slide-in-right"
            style={{ width: `${width}px`, minWidth: '300px', maxWidth: '600px' }}
        >
            {/* Panel Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30">
                {/* Tabs */}
                <div className="flex items-center gap-1">
                    {context.tabs.map((tab) => (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab)}
                            className={cn(
                                "px-3 py-1.5 text-sm rounded-md transition-colors capitalize",
                                context.activeTab === tab
                                    ? "bg-primary/10 text-primary font-medium"
                                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                            )}
                        >
                            {tab}
                        </button>
                    ))}
                </div>

                {/* Controls */}
                <div className="flex items-center gap-1">
                    {/* Pin/Unpin */}
                    <button
                        onClick={isPinned ? unpin : pin}
                        className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                        title={isPinned ? "Unpin panel" : "Pin panel"}
                    >
                        {isPinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
                    </button>

                    {/* Resize toggle */}
                    <button
                        onClick={() => setWidth(width === 400 ? 550 : 400)}
                        className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                        title={width === 400 ? "Expand panel" : "Collapse panel"}
                    >
                        {width === 400 ? <Maximize2 className="w-4 h-4" /> : <Minimize2 className="w-4 h-4" />}
                    </button>

                    {/* Close */}
                    <button
                        onClick={() => setIsVisible(false)}
                        className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                        title="Close panel"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Panel Content */}
            <div className="flex-1 overflow-hidden">
                <PanelContent context={context} />
            </div>
        </div>
    );
}

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

        default:
            return (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                    <p className="text-sm">No content to display</p>
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

