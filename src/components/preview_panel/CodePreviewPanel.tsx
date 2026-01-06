/**
 * CodePreviewPanel
 * ================
 * Right panel for live preview with:
 * - Live iframe preview (Vite/Next dev server)
 * - Code view of current file
 * - Terminal output
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useSetAtom } from 'jotai';
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
    Square,
    AlertTriangle,
    Trash2,
    Shield,
    Globe,
    ExternalLink as LinkIcon
} from 'lucide-react';
import { PermissionQueuePanel } from '../PermissionQueuePanel';
import { type SourceItem, browserErrorsAtom } from '@/atoms/sourceAtoms';
import { type ParsedError } from '@/lib/devServerErrorParser';

interface CodePreviewPanelProps {
    data: {
        url?: string;
        file?: { path: string; content: string };
        terminal?: { output: string[]; running: boolean };
        errors?: ParsedError[];
        sources?: SourceItem[];  // Web search sources for search tab
        chatId?: number;         // For permissions tab
    } | null;
    activeTab: string;
    onClearErrors?: () => void;
    onSolveWithAI?: (error: { message: string; source?: string; stack?: string }) => void;
}

type ViewportSize = 'mobile' | 'tablet' | 'desktop' | 'full';

const VIEWPORT_SIZES: Record<ViewportSize, { width: string; label: string }> = {
    mobile: { width: '375px', label: 'Mobile' },
    tablet: { width: '768px', label: 'Tablet' },
    desktop: { width: '1024px', label: 'Desktop' },
    full: { width: '100%', label: 'Full' },
};

export function CodePreviewPanel({ data, activeTab, onClearErrors, onSolveWithAI }: CodePreviewPanelProps) {
    const previewUrl = data?.url;
    const currentFile = data?.file;
    const terminalData = data?.terminal;
    const errorsData = data?.errors || [];
    const sourcesData = data?.sources || [];
    const chatId = data?.chatId;

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
            {activeTab === 'errors' && (
                <ErrorsTab errors={errorsData} onClear={onClearErrors} onSolveWithAI={onSolveWithAI} />
            )}
            {activeTab === 'permissions' && (
                <PermissionsTab chatId={chatId} />
            )}
            {activeTab === 'search' && (
                <SearchTab sources={sourcesData} />
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
    const setErrors = useSetAtom(browserErrorsAtom);

    // Inject error capture script into iframe on load
    useEffect(() => {
        const iframe = iframeRef.current;
        if (!iframe || !url) return;

        const handleIframeLoad = () => {
            try {
                const iframeWin = iframe.contentWindow;
                if (!iframeWin) {
                    console.debug('[PreviewTab] No contentWindow access');
                    return;
                }

                // For same-origin iframes (localhost dev server), we can inject directly
                // For cross-origin, accessing document will throw an error
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const _test = iframeWin.document; // This throws if cross-origin

                // Check if already injected
                if ((iframeWin as any).__atlarixErrorCapture) {
                    console.debug('[PreviewTab] Error capture already injected');
                    return;
                }
                (iframeWin as any).__atlarixErrorCapture = true;

                console.log('[PreviewTab] Injecting error capture into iframe');

                // Send error to parent via postMessage
                const sendError = (type: string, message: string, source?: string, lineno?: number, stack?: string) => {
                    window.postMessage({
                        type: 'atlarix-error',
                        payload: {
                            type,
                            message: String(message),
                            source: source || url,
                            lineno,
                            stack,
                            timestamp: Date.now(),
                            url
                        }
                    }, '*');
                };

                // Override console.error in iframe
                const originalError = iframeWin.console.error;
                iframeWin.console.error = function (...args: any[]) {
                    const message = args.map(arg => {
                        if (arg instanceof Error) {
                            return arg.message + (arg.stack ? '\n' + arg.stack : '');
                        }
                        return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
                    }).join(' ');

                    sendError('console-error', message);
                    return originalError.apply(iframeWin.console, args);
                };

                // Global error handler in iframe
                iframeWin.onerror = function (message, source, lineno, colno, error) {
                    sendError(
                        'error',
                        String(message),
                        source,
                        lineno,
                        error?.stack
                    );
                    return false;
                };

                // Unhandled promise rejection handler in iframe
                iframeWin.addEventListener('unhandledrejection', function (event: PromiseRejectionEvent) {
                    const reason = event.reason;
                    sendError(
                        'unhandled-rejection',
                        reason instanceof Error ? reason.message : String(reason),
                        undefined,
                        undefined,
                        reason instanceof Error ? reason.stack : undefined
                    );
                });

                // Also capture script errors
                iframeWin.addEventListener('error', function (event: ErrorEvent) {
                    if (event.error || event.message) {
                        sendError(
                            'error',
                            event.message || event.error?.message || 'Unknown error',
                            event.filename,
                            event.lineno,
                            event.error?.stack
                        );
                    }
                }, true);

                console.log('[PreviewTab] Error capture successfully injected');
            } catch (e) {
                // Cross-origin iframe - can't inject directly
                // Rely on proxy injection or postMessage from the page itself
                console.debug('[PreviewTab] Cannot inject into cross-origin iframe, relying on postMessage');
            }
        };

        iframe.addEventListener('load', handleIframeLoad);
        return () => iframe.removeEventListener('load', handleIframeLoad);
    }, [url, key]);

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

/**
 * Errors Tab - Enhanced IDE-style error display
 */
function ErrorsTab({
    errors,
    onClear,
    onSolveWithAI
}: {
    errors: ParsedError[];
    onClear?: () => void;
    onSolveWithAI?: (error: ParsedError) => void;
}) {
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

    const toggleExpanded = (id: string) => {
        setExpandedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    if (errors.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4 bg-[#1e1e1e]">
                <Shield className="w-12 h-12 mb-3 opacity-20 text-green-500" />
                <p className="text-sm text-green-500/80">No errors detected</p>
                <p className="text-xs text-zinc-500">Dev server output is clean</p>
            </div>
        );
    }

    // Group errors by file
    const errorsByFile = errors.reduce((acc, error) => {
        const file = error.file || 'General';
        if (!acc[file]) acc[file] = [];
        acc[file].push(error);
        return acc;
    }, {} as Record<string, ParsedError[]>);

    // Sort files locally (General last)
    const sortedFiles = Object.keys(errorsByFile).sort((a, b) => {
        if (a === 'General') return 1;
        if (b === 'General') return -1;
        return a.localeCompare(b);
    });

    const errorCount = errors.filter(e => e.severity === 'error').length;
    const warningCount = errors.filter(e => e.severity === 'warning').length;

    return (
        <div className="flex flex-col h-full bg-[#1e1e1e]">
            {/* Errors Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-[#1e1e1e]">
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5">
                        <div className="flex items-center justify-center w-5 h-5 rounded-full bg-red-500/20 text-red-400">
                            <span className="text-xs font-bold">{errorCount}</span>
                        </div>
                        <span className="text-xs text-zinc-400">errors</span>
                    </div>
                    {warningCount > 0 && (
                        <div className="flex items-center gap-1.5">
                            <div className="flex items-center justify-center w-5 h-5 rounded-full bg-yellow-500/20 text-yellow-400">
                                <span className="text-xs font-bold">{warningCount}</span>
                            </div>
                            <span className="text-xs text-zinc-400">warnings</span>
                        </div>
                    )}
                </div>
                {onClear && (
                    <button
                        onClick={onClear}
                        className="p-1.5 text-xs rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
                        title="Clear all errors"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>

            {/* Error List */}
            <div className="flex-1 overflow-auto p-3 space-y-4">
                {sortedFiles.map(file => (
                    <div key={file} className="space-y-1">
                        {/* File Header */}
                        {file !== 'General' && (
                            <div className="flex items-center gap-2 px-1 pb-1">
                                <span className="text-xs font-medium text-zinc-400 font-mono">{file}</span>
                                <span className="h-px flex-1 bg-zinc-800"></span>
                            </div>
                        )}

                        {/* Errors for this file */}
                        <div className="space-y-2">
                            {errorsByFile[file].map(error => {
                                const isExpanded = expandedIds.has(error.id);
                                // Check for rawOutput or stack or file for details
                                const hasDetails = error.rawOutput || error.stack || error.file;

                                return (
                                    <div
                                        key={error.id}
                                        className={cn(
                                            "group rounded border transition-all duration-200",
                                            error.severity === 'error'
                                                ? "bg-red-500/5 border-red-500/20 hover:border-red-500/40"
                                                : "bg-yellow-500/5 border-yellow-500/20 hover:border-yellow-500/40"
                                        )}
                                    >
                                        <div
                                            className="p-3 cursor-pointer"
                                            onClick={() => toggleExpanded(error.id)}
                                        >
                                            {error.file && (
                                                <p className="text-xs text-zinc-500 mt-1 truncate">
                                                    📁 {error.file}{error.line ? `:${error.line}` : ''}
                                                </p>
                                            )}
                                            <div className="flex items-start gap-3">
                                                {/* Icon */}
                                                <AlertTriangle className={cn(
                                                    "w-4 h-4 mt-0.5 flex-shrink-0",
                                                    error.severity === 'error' ? "text-red-400" : "text-yellow-400"
                                                )} />

                                                {/* Content */}
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <span className={cn(
                                                            "text-xs px-1.5 py-0.5 rounded border uppercase font-bold tracking-wider",
                                                            error.severity === 'error'
                                                                ? "border-red-500/30 text-red-400 bg-red-500/10"
                                                                : "border-yellow-500/30 text-yellow-400 bg-yellow-500/10"
                                                        )}>
                                                            {error.type}
                                                        </span>
                                                        <span className="text-[10px] text-zinc-500 px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700">
                                                            {error.framework}
                                                        </span>
                                                    </div>

                                                    <p className="text-sm text-zinc-300 font-mono break-words leading-relaxed">
                                                        {error.message}
                                                    </p>

                                                    {/* Location */}
                                                    {(error.line || error.file) && (
                                                        <div className="mt-1.5 flex items-center gap-2 text-xs text-zinc-500">
                                                            <span>Line {error.line || '?'}:{error.column || '?'}</span>
                                                        </div>
                                                    )}

                                                    {/* Suggestion */}
                                                    {error.suggestion && (
                                                        <div className="mt-2 flex items-start gap-1.5 text-xs text-emerald-400/80 bg-emerald-500/5 p-1.5 rounded border border-emerald-500/20">
                                                            <div className="w-1 h-1 rounded-full bg-emerald-500 mt-1.5"></div>
                                                            <span>Tip: {error.suggestion}</span>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>

                                            {/* Action Bar (always visible if actionable) */}
                                            {error.actionable && onSolveWithAI && (
                                                <div className="mt-3 pl-7 flex items-center gap-2">
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            onSolveWithAI(error);
                                                        }}
                                                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20 transition-colors"
                                                    >
                                                        <span>✨ Fix with AI</span>
                                                    </button>
                                                </div>
                                            )}
                                        </div>

                                        {/* Raw Details (Expanded) */}
                                        {isExpanded && error.rawOutput && (
                                            <div className="border-t border-zinc-800 bg-black/20 p-3">
                                                <pre className="text-[10px] text-zinc-500 font-mono whitespace-pre-wrap overflow-x-auto">
                                                    {error.rawOutput}
                                                </pre>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

/**
 * Permissions Tab - Show pending permission requests
 * Features empty state when no permissions pending
 */
function PermissionsTab({ chatId }: { chatId?: number }) {
    return (
        <div className="flex flex-col h-full">
            <PermissionQueuePanel chatId={chatId} />
        </div>
    );
}

/**
 * Search Tab - Display web search results from AI
 * Shows URL cards that user can click to view sources
 */
function SearchTab({ sources }: { sources: SourceItem[] }) {
    if (sources.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
                <Globe className="w-12 h-12 mb-3 opacity-50" />
                <p className="text-sm">No search results</p>
                <p className="text-xs">Web search URLs will appear here</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-background">
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/20">
                <Globe className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium">Search Results</span>
                <span className="ml-auto text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">
                    {sources.length} source{sources.length !== 1 ? 's' : ''}
                </span>
            </div>

            {/* Source List */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {sources.map((source) => (
                    <a
                        key={source.id}
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block p-3 rounded-lg border border-border bg-card hover:bg-muted/50 transition-colors"
                    >
                        <div className="flex items-start gap-3">
                            {/* Favicon */}
                            {source.favicon ? (
                                <img
                                    src={source.favicon}
                                    alt=""
                                    className="w-5 h-5 rounded mt-0.5"
                                />
                            ) : (
                                <Globe className="w-5 h-5 text-muted-foreground mt-0.5" />
                            )}

                            <div className="flex-1 min-w-0">
                                {/* Title */}
                                <h4 className="text-sm font-medium text-foreground line-clamp-1">
                                    {source.title}
                                </h4>

                                {/* URL */}
                                <p className="text-xs text-muted-foreground truncate mt-0.5">
                                    {source.url}
                                </p>

                                {/* Snippet */}
                                {source.snippet && (
                                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                                        {source.snippet}
                                    </p>
                                )}
                            </div>

                            {/* External link indicator */}
                            <ExternalLink className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                        </div>
                    </a>
                ))}
            </div>
        </div>
    );
}

export default CodePreviewPanel;
