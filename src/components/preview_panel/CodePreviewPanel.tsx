/**
 * CodePreviewPanel
 * ================
 * Right panel for live preview with:
 * - Live iframe preview (Vite/Next dev server)
 * - Code view of current file
 * - Terminal output
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import {
    RefreshCw,
    ExternalLink,
    Smartphone,
    Tablet,
    Monitor,
    Maximize2,
    Code2,
    Terminal,
    Play,
    Square
} from 'lucide-react';

interface CodePreviewPanelProps {
    data: {
        url?: string;
        file?: { path: string; content: string };
        terminal?: { output: string[]; running: boolean };
    } | null;
    activeTab: string;
}

type ViewportSize = 'mobile' | 'tablet' | 'desktop' | 'full';

const VIEWPORT_SIZES: Record<ViewportSize, { width: string; label: string }> = {
    mobile: { width: '375px', label: 'Mobile' },
    tablet: { width: '768px', label: 'Tablet' },
    desktop: { width: '1024px', label: 'Desktop' },
    full: { width: '100%', label: 'Full' },
};

export function CodePreviewPanel({ data, activeTab }: CodePreviewPanelProps) {
    const previewUrl = data?.url;
    const currentFile = data?.file;
    const terminalData = data?.terminal;

    return (
        <div className="flex flex-col h-full">
            {activeTab === 'preview' && (
                <PreviewTab url={previewUrl} />
            )}
            {activeTab === 'code' && (
                <CodeTab file={currentFile} />
            )}
            {activeTab === 'terminal' && (
                <TerminalTab data={terminalData} />
            )}
        </div>
    );
}

/**
 * Preview Tab - Live iframe with responsive controls
 */
function PreviewTab({ url }: { url?: string }) {
    const [viewport, setViewport] = useState<ViewportSize>('full');
    const [key, setKey] = useState(0); // For refresh
    const iframeRef = useRef<HTMLIFrameElement>(null);

    const handleRefresh = useCallback(() => {
        setKey(prev => prev + 1);
    }, []);

    const handleOpenExternal = useCallback(() => {
        if (url) {
            window.open(url, '_blank');
        }
    }, [url]);

    if (!url) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
                <Monitor className="w-12 h-12 mb-3 opacity-50" />
                <p className="text-sm">No preview available</p>
                <p className="text-xs">Start a dev server to see live preview</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/20">
                {/* Viewport Buttons */}
                <div className="flex items-center gap-1">
                    <button
                        onClick={() => setViewport('mobile')}
                        className={cn(
                            "p-1.5 rounded-md transition-colors",
                            viewport === 'mobile'
                                ? "bg-primary/10 text-primary"
                                : "text-muted-foreground hover:text-foreground hover:bg-muted"
                        )}
                        title="Mobile (375px)"
                    >
                        <Smartphone className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => setViewport('tablet')}
                        className={cn(
                            "p-1.5 rounded-md transition-colors",
                            viewport === 'tablet'
                                ? "bg-primary/10 text-primary"
                                : "text-muted-foreground hover:text-foreground hover:bg-muted"
                        )}
                        title="Tablet (768px)"
                    >
                        <Tablet className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => setViewport('desktop')}
                        className={cn(
                            "p-1.5 rounded-md transition-colors",
                            viewport === 'desktop'
                                ? "bg-primary/10 text-primary"
                                : "text-muted-foreground hover:text-foreground hover:bg-muted"
                        )}
                        title="Desktop (1024px)"
                    >
                        <Monitor className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => setViewport('full')}
                        className={cn(
                            "p-1.5 rounded-md transition-colors",
                            viewport === 'full'
                                ? "bg-primary/10 text-primary"
                                : "text-muted-foreground hover:text-foreground hover:bg-muted"
                        )}
                        title="Full Width"
                    >
                        <Maximize2 className="w-4 h-4" />
                    </button>
                </div>

                {/* URL Display */}
                <div className="flex-1 mx-4">
                    <div className="text-xs text-muted-foreground bg-muted/50 px-2 py-1 rounded truncate">
                        {url}
                    </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1">
                    <button
                        onClick={handleRefresh}
                        className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                        title="Refresh"
                    >
                        <RefreshCw className="w-4 h-4" />
                    </button>
                    <button
                        onClick={handleOpenExternal}
                        className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                        title="Open in browser"
                    >
                        <ExternalLink className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Iframe Container */}
            <div className="flex-1 bg-muted/10 flex items-center justify-center p-4 overflow-auto">
                <div
                    className="bg-white rounded-lg shadow-lg overflow-hidden transition-all duration-200"
                    style={{
                        width: VIEWPORT_SIZES[viewport].width,
                        height: viewport === 'full' ? '100%' : 'calc(100% - 2rem)',
                        maxWidth: '100%'
                    }}
                >
                    <iframe
                        key={key}
                        ref={iframeRef}
                        src={url}
                        className="w-full h-full border-0"
                        title="Live Preview"
                    />
                </div>
            </div>

            {/* Viewport Label */}
            <div className="px-3 py-1.5 border-t border-border bg-muted/20">
                <span className="text-xs text-muted-foreground">
                    {VIEWPORT_SIZES[viewport].label} — {VIEWPORT_SIZES[viewport].width}
                </span>
            </div>
        </div>
    );
}

/**
 * Code Tab - Current file view
 */
function CodeTab({ file }: { file?: { path: string; content: string } }) {
    if (!file) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
                <Code2 className="w-12 h-12 mb-3 opacity-50" />
                <p className="text-sm">No file selected</p>
                <p className="text-xs">Select a file to view its code</p>
            </div>
        );
    }

    const fileName = file.path.split('/').pop();
    const lineCount = file.content.split('\n').length;

    return (
        <div className="flex flex-col h-full">
            {/* File Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/20">
                <div className="flex items-center gap-2">
                    <Code2 className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{fileName}</span>
                </div>
                <span className="text-xs text-muted-foreground">{lineCount} lines</span>
            </div>

            {/* Code Content */}
            <div className="flex-1 overflow-auto">
                <pre className="p-4 text-xs font-mono text-foreground leading-relaxed">
                    {file.content.split('\n').map((line, i) => (
                        <div key={i} className="flex">
                            <span className="w-8 text-right pr-4 text-muted-foreground select-none">
                                {i + 1}
                            </span>
                            <code className="flex-1">{line || ' '}</code>
                        </div>
                    ))}
                </pre>
            </div>
        </div>
    );
}

/**
 * Terminal Tab - Command output
 */
function TerminalTab({ data }: { data?: { output: string[]; running: boolean } }) {
    const outputRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom
    useEffect(() => {
        if (outputRef.current) {
            outputRef.current.scrollTop = outputRef.current.scrollHeight;
        }
    }, [data?.output]);

    if (!data) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
                <Terminal className="w-12 h-12 mb-3 opacity-50" />
                <p className="text-sm">No terminal output</p>
                <p className="text-xs">Run a command to see output</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-[#1e1e1e]">
            {/* Terminal Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-700 bg-zinc-900">
                <div className="flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-zinc-400" />
                    <span className="text-sm text-zinc-300">Terminal</span>
                </div>
                <div className="flex items-center gap-2">
                    {data.running ? (
                        <button className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-red-500/20 text-red-400 hover:bg-red-500/30">
                            <Square className="w-3 h-3" />
                            Stop
                        </button>
                    ) : (
                        <span className="flex items-center gap-1 px-2 py-1 text-xs text-zinc-500">
                            <Play className="w-3 h-3" />
                            Completed
                        </span>
                    )}
                </div>
            </div>

            {/* Terminal Output */}
            <div
                ref={outputRef}
                className="flex-1 overflow-auto p-4 font-mono text-xs text-zinc-300"
            >
                {data.output.map((line, i) => (
                    <div key={i} className="whitespace-pre-wrap">
                        {line}
                    </div>
                ))}
                {data.running && (
                    <span className="inline-block w-2 h-4 bg-zinc-300 animate-pulse" />
                )}
            </div>
        </div>
    );
}

export default CodePreviewPanel;
