/**
 * DiagramPanel
 * ============
 * Right panel for architecture diagrams with:
 * - REAL Mermaid rendering (via MermaidRenderer)
 * - Version history dropdown
 * - Before/After compare modes
 * - Export buttons (SVG, Copy)
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { useAtom } from 'jotai';
import { diagramStateAtom, type DiagramState } from '@/atoms/sourceAtoms';
import { cn } from '@/lib/utils';
import { MermaidRenderer } from '@/components/MermaidRenderer';
import { IpcClient } from '@/ipc/ipc_client';
import {
    GitCompare,
    Download,
    Copy,
    Code2,
    Image,
    Layout,
    ChevronLeft,
    ChevronRight,
    History,
    RotateCcw,
    Check,
} from 'lucide-react';

interface DiagramPanelProps {
    data: DiagramState | null;
    activeTab: string;
}

type CompareMode = 'current' | 'before' | 'after' | 'side-by-side';

interface DiagramVersion {
    id: number;
    content: string;
    changeDescription: string | null;
    createdAt: Date;
}

export function DiagramPanel({ data, activeTab }: DiagramPanelProps) {
    const [diagramState, setDiagramState] = useAtom(diagramStateAtom);
    const [compareMode, setCompareMode] = useState<CompareMode>('current');
    const [versions, setVersions] = useState<DiagramVersion[]>([]);
    const [showHistory, setShowHistory] = useState(false);

    // Use data from props or atom
    const diagram = data || diagramState;

    // Fetch version history if we have a diagram ID
    useEffect(() => {
        if (diagram && (diagram as any).id) {
            IpcClient.getInstance()
                .getDiagramHistory((diagram as any).id)
                .then((result) => {
                    if (result.success) {
                        setVersions(result.versions);
                    }
                })
                .catch(console.error);
        }
    }, [diagram]);

    if (!diagram) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
                <Layout className="w-12 h-12 mb-3 opacity-50" />
                <p className="text-sm">No diagram to display</p>
                <p className="text-xs">Generate a diagram using the AI</p>
            </div>
        );
    }

    const hasCompareData = !!(diagram.beforeCode && diagram.afterCode);

    return (
        <div className="flex flex-col h-full">
            {activeTab === 'diagram' && (
                <DiagramViewer
                    diagram={diagram}
                    compareMode={compareMode}
                    setCompareMode={setCompareMode}
                    hasCompareData={hasCompareData}
                    versions={versions}
                    showHistory={showHistory}
                    setShowHistory={setShowHistory}
                />
            )}
            {activeTab === 'logs' && <DiagramLogs />}
        </div>
    );
}

/**
 * Main Diagram Viewer with Compare Modes and Version History
 */
function DiagramViewer({
    diagram,
    compareMode,
    setCompareMode,
    hasCompareData,
    versions,
    showHistory,
    setShowHistory,
}: {
    diagram: DiagramState;
    compareMode: CompareMode;
    setCompareMode: (mode: CompareMode) => void;
    hasCompareData: boolean;
    versions: DiagramVersion[];
    showHistory: boolean;
    setShowHistory: (show: boolean) => void;
}) {
    const [copied, setCopied] = useState(false);
    const [renderedSvg, setRenderedSvg] = useState<string | null>(null);

    // Get code to display based on compare mode
    const displayCode = useMemo(() => {
        switch (compareMode) {
            case 'before':
                return diagram.beforeCode || diagram.code;
            case 'after':
                return diagram.afterCode || diagram.code;
            default:
                return diagram.code;
        }
    }, [compareMode, diagram]);

    // Copy diagram code
    const handleCopy = useCallback(() => {
        navigator.clipboard.writeText(displayCode);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, [displayCode]);

    // Export as SVG
    const handleExportSVG = useCallback(() => {
        if (!renderedSvg) return;
        const blob = new Blob([renderedSvg], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'diagram.svg';
        a.click();
        URL.revokeObjectURL(url);
    }, [renderedSvg]);

    // Restore a previous version
    const handleRestore = useCallback(async (version: DiagramVersion) => {
        if (!(diagram as any).id) return;
        try {
            await IpcClient.getInstance().restoreDiagramVersion({
                diagramId: (diagram as any).id,
                versionId: version.id,
            });
            setShowHistory(false);
            // TODO: Refresh diagram state
        } catch (error) {
            console.error('Failed to restore version:', error);
        }
    }, [diagram, setShowHistory]);

    return (
        <div className="flex flex-col h-full">
            {/* Compare Mode Selector */}
            {hasCompareData && (
                <div className="flex items-center gap-1 px-3 py-2 border-b border-border bg-muted/20">
                    <span className="text-xs text-muted-foreground mr-2">Compare:</span>
                    {(['before', 'current', 'after', 'side-by-side'] as CompareMode[]).map((mode) => (
                        <button
                            key={mode}
                            onClick={() => setCompareMode(mode)}
                            className={cn(
                                "px-2 py-1 text-xs rounded-md transition-colors capitalize",
                                compareMode === mode
                                    ? "bg-primary/10 text-primary font-medium"
                                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                            )}
                        >
                            {mode.replace('-', ' ')}
                        </button>
                    ))}
                </div>
            )}

            {/* Diagram Preview - Now with REAL rendering! */}
            <div className="flex-1 overflow-auto p-4">
                {compareMode === 'side-by-side' && hasCompareData ? (
                    <SideBySideView
                        beforeCode={diagram.beforeCode || ''}
                        afterCode={diagram.afterCode || ''}
                    />
                ) : diagram.type === 'mermaid' || diagram.type === 'architecture' ||
                    diagram.type === 'flowchart' || diagram.type === 'sequence' ||
                    diagram.type === 'class' ? (
                    <MermaidRenderer
                        code={displayCode}
                        className="min-h-[300px]"
                        onRender={setRenderedSvg}
                    />
                ) : (
                    // PlantUML fallback - show code
                    <PlantUMLPreview code={displayCode} />
                )}
            </div>

            {/* Actions Bar */}
            <div className="flex items-center justify-between px-3 py-2 border-t border-border bg-muted/20">
                <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground px-2 py-0.5 rounded bg-muted capitalize">
                        {diagram.type}
                    </span>
                    {versions.length > 0 && (
                        <button
                            onClick={() => setShowHistory(!showHistory)}
                            className={cn(
                                "flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors",
                                showHistory
                                    ? "bg-primary/10 text-primary"
                                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                            )}
                        >
                            <History className="w-3.5 h-3.5" />
                            {versions.length} versions
                        </button>
                    )}
                </div>
                <div className="flex items-center gap-1">
                    <button
                        onClick={handleCopy}
                        className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                        title="Copy code"
                    >
                        {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                        {copied ? 'Copied!' : 'Copy'}
                    </button>
                    <button
                        onClick={handleExportSVG}
                        disabled={!renderedSvg}
                        className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Export SVG"
                    >
                        <Image className="w-3.5 h-3.5" />
                        SVG
                    </button>
                </div>
            </div>

            {/* Version History Dropdown */}
            {showHistory && versions.length > 0 && (
                <div className="absolute bottom-14 left-3 right-3 bg-background border border-border rounded-lg shadow-lg max-h-48 overflow-y-auto z-10">
                    <div className="p-2 text-xs font-medium text-muted-foreground border-b border-border">
                        Version History
                    </div>
                    {versions.map((version) => (
                        <div
                            key={version.id}
                            className="flex items-center justify-between px-3 py-2 hover:bg-muted/50 border-b border-border last:border-0"
                        >
                            <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium truncate">
                                    {version.changeDescription || 'Updated diagram'}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {new Date(version.createdAt).toLocaleString()}
                                </p>
                            </div>
                            <button
                                onClick={() => handleRestore(version)}
                                className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-primary hover:bg-primary/10"
                            >
                                <RotateCcw className="w-3 h-3" />
                                Restore
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * PlantUML Preview (code display for now)
 */
function PlantUMLPreview({ code }: { code: string }) {
    return (
        <div className="space-y-4">
            <div className="bg-gradient-to-br from-green-500/5 to-blue-500/5 rounded-lg border border-border p-6 min-h-[200px] flex items-center justify-center">
                <div className="text-center space-y-3">
                    <Layout className="w-16 h-16 mx-auto text-green-500/50" />
                    <p className="text-sm text-muted-foreground">PlantUML Diagram</p>
                    <p className="text-xs text-muted-foreground/70">
                        {code.split('\n').length} lines
                    </p>
                </div>
            </div>
            <div className="bg-muted/30 rounded-lg border border-border overflow-hidden">
                <div className="flex items-center justify-between px-3 py-1.5 bg-muted/50 border-b border-border">
                    <span className="text-xs font-medium text-muted-foreground">PlantUML Code</span>
                    <Code2 className="w-3.5 h-3.5 text-muted-foreground" />
                </div>
                <pre className="p-3 text-xs font-mono text-foreground overflow-x-auto max-h-[300px]">
                    {code}
                </pre>
            </div>
        </div>
    );
}

/**
 * Side-by-Side Comparison View
 */
function SideBySideView({
    beforeCode,
    afterCode,
}: {
    beforeCode: string;
    afterCode: string;
}) {
    return (
        <div className="grid grid-cols-2 gap-4 h-full">
            {/* Before */}
            <div className="flex flex-col rounded-lg border border-border overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border-b border-red-500/20">
                    <ChevronLeft className="w-4 h-4 text-red-500" />
                    <span className="text-xs font-medium text-red-500">Before</span>
                </div>
                <div className="flex-1 p-3 overflow-auto">
                    <MermaidRenderer code={beforeCode} />
                </div>
            </div>

            {/* After */}
            <div className="flex flex-col rounded-lg border border-border overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-green-500/10 border-b border-green-500/20">
                    <ChevronRight className="w-4 h-4 text-green-500" />
                    <span className="text-xs font-medium text-green-500">After</span>
                </div>
                <div className="flex-1 p-3 overflow-auto">
                    <MermaidRenderer code={afterCode} />
                </div>
            </div>
        </div>
    );
}

/**
 * Diagram Logs Tab
 */
function DiagramLogs() {
    return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
            <Code2 className="w-12 h-12 mb-3 opacity-50" />
            <p className="text-sm">No diagram logs</p>
            <p className="text-xs">Generation logs will appear here</p>
        </div>
    );
}

export default DiagramPanel;
