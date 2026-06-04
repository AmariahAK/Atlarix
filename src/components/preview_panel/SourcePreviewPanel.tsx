/**
 * SourcePreviewPanel
 * ==================
 * Right panel for web search results with:
 * - Source cards grid with favicons
 * - Iframe preview for selected source
 * - Tool execution timeline
 */

import { useAtom } from 'jotai';
import { selectedSourceAtom, type SourceItem } from '@/atoms/sourceAtoms';
import { cn } from '@/lib/utils';
import { ExternalLink, Clock, CheckCircle2, AlertCircle, Loader2, Globe } from 'lucide-react';

interface SourcePreviewPanelProps {
    data: {
        sources: SourceItem[];
        timeline: any[];
    };
    activeTab: string;
}

function SourcePreviewPanel({ data, activeTab }: SourcePreviewPanelProps) {
    const [selectedSource, setSelectedSource] = useAtom(selectedSourceAtom);
    const sources = data?.sources || [];
    const timeline = data?.timeline || [];

    return (
        <div className="flex flex-col h-full">
            {activeTab === 'sources' && (
                <SourcesTab
                    sources={sources}
                    selectedSource={selectedSource}
                    onSelectSource={setSelectedSource}
                />
            )}
            {activeTab === 'tools' && <ToolsTab timeline={timeline} />}
            {activeTab === 'debug' && <DebugTab data={data} />}
        </div>
    );
}

/**
 * Sources Tab - Grid of source cards + iframe preview
 */
function SourcesTab({
    sources,
    selectedSource,
    onSelectSource
}: {
    sources: SourceItem[];
    selectedSource: SourceItem | null;
    onSelectSource: (source: SourceItem | null) => void;
}) {
    if (sources.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
                <Globe className="w-12 h-12 mb-3 opacity-50" />
                <p className="text-sm">No sources available</p>
                <p className="text-xs">Search results will appear here</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Source Cards Grid */}
            <div className="p-3 border-b border-border overflow-y-auto max-h-[40%]">
                <div className="grid grid-cols-1 gap-2">
                    {sources.map((source, index) => (
                        <SourceCard
                            key={source.id || index}
                            source={source}
                            isSelected={selectedSource?.id === source.id}
                            onClick={() => onSelectSource(source)}
                        />
                    ))}
                </div>
            </div>

            {/* Content Preview */}
            <div className="flex-1 overflow-hidden">
                {selectedSource ? (
                    <div className="h-full flex flex-col">
                        {/* Preview Header */}
                        <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b border-border">
                            <div className="flex items-center gap-2 min-w-0">
                                <img
                                    src={selectedSource.favicon || `https://www.google.com/s2/favicons?domain=${new URL(selectedSource.url).hostname}&sz=16`}
                                    alt=""
                                    className="w-4 h-4"
                                    onError={(e) => e.currentTarget.style.display = 'none'}
                                />
                                <span className="text-sm font-medium truncate">
                                    {selectedSource.title}
                                </span>
                            </div>
                            <a
                                href={selectedSource.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                                title="Open in browser"
                            >
                                <ExternalLink className="w-4 h-4" />
                            </a>
                        </div>

                        {/* Rich Content Preview (instead of iframe which gets blocked) */}
                        <div className="flex-1 overflow-y-auto p-4 bg-card">
                            {/* Source badge and score */}
                            <div className="flex items-center gap-2 mb-3">
                                <span className="text-xs px-2 py-1 rounded-full bg-primary/10 text-primary capitalize font-medium">
                                    {selectedSource.source}
                                </span>
                                {selectedSource.score && (
                                    <span className="text-xs text-muted-foreground">
                                        Relevance: {selectedSource.score.toFixed(1)}
                                    </span>
                                )}
                            </div>

                            {/* Title */}
                            <h3 className="text-lg font-semibold text-foreground mb-2">
                                {selectedSource.title}
                            </h3>

                            {/* URL */}
                            <p className="text-xs text-muted-foreground mb-4 break-all">
                                {selectedSource.url}
                            </p>

                            {/* Content/Snippet */}
                            <div className="prose prose-sm dark:prose-invert max-w-none">
                                <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                                    {selectedSource.snippet || 'No preview available for this source.'}
                                </p>
                            </div>

                            {/* Open in browser button */}
                            <div className="mt-6 pt-4 border-t border-border">
                                <a
                                    href={selectedSource.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-sm font-medium"
                                >
                                    <ExternalLink className="w-4 h-4" />
                                    Open Full Article
                                </a>
                                <p className="text-xs text-muted-foreground mt-2">
                                    Click to read the complete content in your browser
                                </p>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                        <Globe className="w-10 h-10 mb-2 opacity-50" />
                        <p className="text-sm">Click a source to preview</p>
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * Individual Source Card
 */
function SourceCard({
    source,
    isSelected,
    onClick
}: {
    source: SourceItem;
    isSelected: boolean;
    onClick: () => void;
}) {
    // Get favicon URL
    const faviconUrl = source.favicon ||
        `https://www.google.com/s2/favicons?domain=${new URL(source.url).hostname}&sz=32`;

    // Map source to color
    const sourceColors: Record<string, string> = {
        stackoverflow: 'border-[#F48024]/50 bg-[#F48024]/5',
        github: 'border-[#6e5494]/50 bg-[#6e5494]/5',
        reddit: 'border-[#FF4500]/50 bg-[#FF4500]/5',
        mdn: 'border-[#83D0F2]/50 bg-[#83D0F2]/5',
        duckduckgo: 'border-[#DE5833]/50 bg-[#DE5833]/5',
    };

    const colorClass = sourceColors[source.source] || 'border-border bg-muted/20';

    return (
        <button
            onClick={onClick}
            className={cn(
                "w-full text-left p-2.5 rounded-lg border transition-all",
                colorClass,
                isSelected
                    ? "ring-2 ring-primary ring-offset-1 ring-offset-background"
                    : "hover:border-primary/50"
            )}
        >
            <div className="flex items-start gap-2">
                <img
                    src={faviconUrl}
                    alt=""
                    className="w-4 h-4 mt-0.5 flex-shrink-0"
                    onError={(e) => e.currentTarget.style.display = 'none'}
                />
                <div className="min-w-0 flex-1">
                    <h4 className="text-sm font-medium text-foreground line-clamp-1">
                        {source.title}
                    </h4>
                    <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                        {source.snippet}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground capitalize">
                            {source.source}
                        </span>
                        {source.score && (
                            <span className="text-[10px] text-muted-foreground">
                                Score: {source.score.toFixed(1)}
                            </span>
                        )}
                    </div>
                </div>
            </div>
        </button>
    );
}

/**
 * Tools Tab - Execution timeline
 */
function ToolsTab({ timeline }: { timeline: any[] }) {
    if (timeline.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
                <Clock className="w-12 h-12 mb-3 opacity-50" />
                <p className="text-sm">No tool executions yet</p>
            </div>
        );
    }

    return (
        <div className="p-3 overflow-y-auto">
            <div className="space-y-2">
                {timeline.map((tool, index) => (
                    <div
                        key={tool.id || index}
                        className="flex items-center gap-3 p-2.5 rounded-lg bg-muted/30 border border-border"
                    >
                        {/* Status Icon */}
                        {tool.status === 'running' && (
                            <Loader2 className="w-4 h-4 text-primary animate-spin" />
                        )}
                        {tool.status === 'completed' && (
                            <CheckCircle2 className="w-4 h-4 text-green-500" />
                        )}
                        {tool.status === 'error' && (
                            <AlertCircle className="w-4 h-4 text-red-500" />
                        )}

                        {/* Tool Info */}
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-foreground">
                                {tool.name}
                            </p>
                            {tool.duration && (
                                <p className="text-xs text-muted-foreground">
                                    {tool.duration}ms
                                </p>
                            )}
                        </div>

                        {/* Timestamp */}
                        <span className="text-xs text-muted-foreground">
                            {new Date(tool.startTime).toLocaleTimeString()}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

/**
 * Debug Tab - Raw data view
 */
function DebugTab({ data }: { data: any }) {
    return (
        <div className="p-3 overflow-y-auto">
            <pre className="text-xs text-muted-foreground bg-muted/30 p-3 rounded-lg overflow-x-auto">
                {JSON.stringify(data, null, 2)}
            </pre>
        </div>
    );
}

export default SourcePreviewPanel;
