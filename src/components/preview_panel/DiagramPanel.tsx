/**
 * DiagramPanel
 * ============
 * Right panel for architecture diagrams with:
 * - Mermaid/PlantUML code editor
 * - Live diagram preview
 * - Before/After/Side-by-Side compare modes
 * - Export buttons (SVG, PNG, Code)
 * - Interactive clickable nodes
 */

import { useState, useCallback, useMemo } from 'react';
import { useAtom } from 'jotai';
import { diagramStateAtom, type DiagramState } from '@/atoms/sourceAtoms';
import { cn } from '@/lib/utils';
import {
    GitCompare,
    Download,
    Copy,
    Code2,
    Image,
    Layout,
    ChevronLeft,
    ChevronRight,
    Maximize2
} from 'lucide-react';

interface DiagramPanelProps {
    data: DiagramState | null;
    activeTab: string;
}

type CompareMode = 'current' | 'before' | 'after' | 'side-by-side';

export function DiagramPanel({ data, activeTab }: DiagramPanelProps) {
    const [diagramState, setDiagramState] = useAtom(diagramStateAtom);
    const [compareMode, setCompareMode] = useState<CompareMode>('current');
    const [isEditing, setIsEditing] = useState(false);
    const [editCode, setEditCode] = useState('');

    // Use data from props or atom
    const diagram = data || diagramState;

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
                />
            )}
            {activeTab === 'logs' && <DiagramLogs />}
        </div>
    );
}

/**
 * Main Diagram Viewer with Compare Modes
 */
function DiagramViewer({
    diagram,
    compareMode,
    setCompareMode,
    hasCompareData
}: {
    diagram: DiagramState;
    compareMode: CompareMode;
    setCompareMode: (mode: CompareMode) => void;
    hasCompareData: boolean;
}) {
    const [copied, setCopied] = useState(false);

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

    // Export as SVG (placeholder - would use actual Mermaid rendering)
    const handleExportSVG = useCallback(() => {
        const svgElement = document.querySelector('.diagram-preview svg');
        if (svgElement) {
            const svgData = new XMLSerializer().serializeToString(svgElement);
            const blob = new Blob([svgData], { type: 'image/svg+xml' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'diagram.svg';
            a.click();
            URL.revokeObjectURL(url);
        }
    }, []);

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

            {/* Diagram Preview */}
            <div className="flex-1 overflow-auto p-4">
                {compareMode === 'side-by-side' && hasCompareData ? (
                    <SideBySideView
                        beforeCode={diagram.beforeCode || ''}
                        afterCode={diagram.afterCode || ''}
                        type={diagram.type}
                    />
                ) : (
                    <DiagramRender
                        code={displayCode}
                        type={diagram.type}
                    />
                )}
            </div>

            {/* Actions Bar */}
            <div className="flex items-center justify-between px-3 py-2 border-t border-border bg-muted/20">
                <div className="flex items-center gap-1">
                    <span className="text-xs text-muted-foreground px-2 py-0.5 rounded bg-muted capitalize">
                        {diagram.type}
                    </span>
                </div>
                <div className="flex items-center gap-1">
                    <button
                        onClick={handleCopy}
                        className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                        title="Copy code"
                    >
                        <Copy className="w-3.5 h-3.5" />
                        {copied ? 'Copied!' : 'Copy'}
                    </button>
                    <button
                        onClick={handleExportSVG}
                        className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                        title="Export SVG"
                    >
                        <Image className="w-3.5 h-3.5" />
                        SVG
                    </button>
                </div>
            </div>
        </div>
    );
}

/**
 * Render a diagram from Mermaid/PlantUML code
 */
function DiagramRender({ code, type }: { code: string; type: 'mermaid' | 'plantuml' }) {
    // For now, show code block. In production, would use mermaid.js or PlantUML server
    return (
        <div className="diagram-preview">
            {type === 'mermaid' ? (
                <MermaidDiagram code={code} />
            ) : (
                <PlantUMLDiagram code={code} />
            )}
        </div>
    );
}

/**
 * Mermaid Diagram Renderer
 */
function MermaidDiagram({ code }: { code: string }) {
    // Placeholder - in production would use mermaid.js
    // For now, show a styled code preview with diagram structure hints
    return (
        <div className="space-y-4">
            {/* Visual representation (simplified) */}
            <div className="bg-gradient-to-br from-primary/5 to-accent/5 rounded-lg border border-border p-6 min-h-[200px] flex items-center justify-center">
                <div className="text-center space-y-3">
                    <Layout className="w-16 h-16 mx-auto text-primary/50" />
                    <p className="text-sm text-muted-foreground">Mermaid Diagram</p>
                    <p className="text-xs text-muted-foreground/70">
                        {code.split('\n').length} lines
                    </p>
                </div>
            </div>

            {/* Code Preview */}
            <div className="bg-muted/30 rounded-lg border border-border overflow-hidden">
                <div className="flex items-center justify-between px-3 py-1.5 bg-muted/50 border-b border-border">
                    <span className="text-xs font-medium text-muted-foreground">Mermaid Code</span>
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
 * PlantUML Diagram Renderer
 */
function PlantUMLDiagram({ code }: { code: string }) {
    // In production, would send to PlantUML server for rendering
    // For now, show code preview
    return (
        <div className="space-y-4">
            {/* Visual placeholder */}
            <div className="bg-gradient-to-br from-green-500/5 to-blue-500/5 rounded-lg border border-border p-6 min-h-[200px] flex items-center justify-center">
                <div className="text-center space-y-3">
                    <Layout className="w-16 h-16 mx-auto text-green-500/50" />
                    <p className="text-sm text-muted-foreground">PlantUML Diagram</p>
                    <p className="text-xs text-muted-foreground/70">
                        {code.split('\n').length} lines
                    </p>
                </div>
            </div>

            {/* Code Preview */}
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
    type
}: {
    beforeCode: string;
    afterCode: string;
    type: 'mermaid' | 'plantuml';
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
                    <DiagramRender code={beforeCode} type={type} />
                </div>
            </div>

            {/* After */}
            <div className="flex flex-col rounded-lg border border-border overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-green-500/10 border-b border-green-500/20">
                    <ChevronRight className="w-4 h-4 text-green-500" />
                    <span className="text-xs font-medium text-green-500">After</span>
                </div>
                <div className="flex-1 p-3 overflow-auto">
                    <DiagramRender code={afterCode} type={type} />
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
