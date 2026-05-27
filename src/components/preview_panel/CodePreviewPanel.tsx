/**
 * CodePreviewPanel
 * ================
 * Right panel for live preview with:
 * - Live iframe preview (Vite/Next dev server)
 * - Code view of current file
 * - Terminal output
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useSetAtom, useAtomValue, useAtom } from 'jotai';
import { IpcClient } from '@/ipc/ipc_client';
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
    ExternalLink as LinkIcon,
    Sparkles,
    History,
    Lightbulb,
    Check
} from 'lucide-react';
import { PermissionQueuePanel } from '../PermissionQueuePanel';
import { FixAllErrorsDialog } from '../FixAllErrorsDialog';
import { type SourceItem, type TerminalOutput, browserErrorsAtom, dismissedErrorSignaturesAtom, visibleBrowserErrorsAtom, getErrorSignature, diagramStateAtom, selectedErrorForCodeAtom } from '@/atoms/sourceAtoms';
import { currentAppAtom } from '@/atoms/appAtoms';
import { WorkspaceFileTree } from '@/components/workspace/WorkspaceFileTree';
import { CodebaseSearchBox } from '@/components/CodebaseSearchBox';
import { type ParsedError } from '@/lib/devServerErrorParser';
import { ErrorFileEditor } from './ErrorFileEditor';
import { FileEditor } from './FileEditor';
import { MermaidRenderer } from '@/components/MermaidRenderer';
import { TerminalPanel } from '@/components/panels/TerminalPanel';

interface CodePreviewPanelProps {
    data: {
        url?: string;
        file?: { path: string; content: string };
        terminal?: { output: string[]; running: boolean };
        terminalOutputs?: Map<string, TerminalOutput>;
        errors?: ParsedError[];
        sources?: SourceItem[];  // Web search sources for search tab
        chatId?: number;         // For permissions tab
        workspacePath?: string;  // For live code editor
    } | null;
    activeTab: string;
    onClearErrors?: () => void;
    onSolveWithAI?: (error: { message: string; source?: string; stack?: string }) => void;
    onSolveAllWithAI?: (errors: ParsedError[], context: string) => void;
    onSwitchToCode?: () => void; // Switch to Code tab for line highlighting
}

type ViewportSize = 'mobile' | 'tablet' | 'desktop' | 'full';

const VIEWPORT_SIZES: Record<ViewportSize, { width: string; label: string }> = {
    mobile: { width: '375px', label: 'Mobile' },
    tablet: { width: '768px', label: 'Tablet' },
    desktop: { width: '1024px', label: 'Desktop' },
    full: { width: '100%', label: 'Full' },
};

export function CodePreviewPanel({ data, activeTab, onClearErrors, onSolveWithAI, onSolveAllWithAI, onSwitchToCode }: CodePreviewPanelProps) {
    const navigate = useNavigate();
    const currentApp = useAtomValue(currentAppAtom);
    const [selectedErrorForCode, setSelectedErrorForCode] = useAtom(selectedErrorForCodeAtom);
    const setBrowserErrors = useSetAtom(browserErrorsAtom);
    const setDismissedSignatures = useSetAtom(dismissedErrorSignaturesAtom);
    const visibleErrors = useAtomValue(visibleBrowserErrorsAtom);
    const currentAppId = (data as { appId?: number })?.appId ?? null;
    const previewUrl = data?.url;
    const currentFile = data?.file;
    const terminalData = data?.terminal;
    const errorsData = data?.errors !== undefined ? visibleErrors : (data?.errors || []);
    const sourcesData = data?.sources || [];
    const chatId = data?.chatId;
    const workspacePath = data?.workspacePath || '';

    return (
        <div className="flex flex-col h-full">
            {activeTab === 'preview' && (
                <PreviewTab url={previewUrl} />
            )}
            {activeTab === 'code' && (
                <div className="flex flex-col h-full min-h-0">
                    {currentAppId && (
                        <div className="flex items-center justify-end px-2 py-1.5 border-b border-border/50 bg-muted/5 flex-shrink-0">
                            <button
                                type="button"
                                onClick={() =>
                                    navigate({
                                        to: "/code",
                                        search: {
                                            appId: currentAppId!,
                                            ...(currentFile?.path ? { file: currentFile.path } : {}),
                                            tab: "errors",
                                        },
                                    })
                                }
                                className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground rounded-md transition-colors"
                            >
                                <Maximize2 className="h-3.5 w-3.5" />
                                Open in full screen
                            </button>
                        </div>
                    )}
                    <div className="flex-1 min-h-0 flex min-w-0">
                        <CodeTab
                            file={currentFile}
                            errors={errorsData}
                            workspacePath={workspacePath}
                            appId={currentAppId}
                            selectedErrorForCode={selectedErrorForCode}
                            onSelectedErrorForCodeConsumed={() => setSelectedErrorForCode(null)}
                        />
                    </div>
                </div>
            )}
            {activeTab === 'terminal' && (
                <TerminalPanel />
            )}
            {activeTab === 'errors' && (
                <ErrorsTab
                    errors={errorsData}
                    onClear={onClearErrors}
                    onSolveWithAI={onSolveWithAI}
                    onSolveAllWithAI={onSolveAllWithAI}
                    onSwitchToCode={onSwitchToCode}
                    onEditErrorFile={(filePath, line, column) => {
                        setSelectedErrorForCode({ filePath, line, column });
                        onSwitchToCode?.();
                    }}
                    onMarkDone={(error) => {
                        setDismissedSignatures((prev) => new Set(prev).add(getErrorSignature(error)));
                        setBrowserErrors((prev) => prev.filter((e) => e.id !== error.id));
                    }}
                />
            )}
            {activeTab === 'permissions' && (
                <PermissionsTab chatId={chatId} />
            )}
            {activeTab === 'search' && (
                <SearchTab
                    sources={sourcesData}
                    appId={currentAppId}
                />
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

                // Override console.error in iframe (contentWindow may be typed without console in some envs)
                const win = iframeWin as Window & { console: Console };
                const originalError = win.console.error.bind(win.console);
                win.console.error = function (...args: unknown[]) {
                    const message = args.map(arg => {
                        if (arg instanceof Error) {
                            return arg.message + (arg.stack ? '\n' + arg.stack : '');
                        }
                        return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
                    }).join(' ');

                    sendError('console-error', message);
                    return originalError(...args);
                };

                // Global error handler in iframe
                win.onerror = function (message: string | Event, source?: string | null, lineno?: number, colno?: number, error?: Error | null) {
                    sendError(
                        'error',
                        String(message),
                        source ?? undefined,
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
 * Code Tab - Current file view or Error File Editor
 * When files is provided, renders miniscreen: file tree sidebar + editor (same size as blueprint).
 * Otherwise shows single-file view or search/empty state.
 */
function CodeTab({
    file,
    errors = [],
    workspacePath = '',
    appId = null,
    selectedErrorForCode = null,
    onSelectedErrorForCodeConsumed = () => {},
}: {
    file?: { path: string; content: string };
    errors?: ParsedError[];
    workspacePath?: string;
    appId?: number | null;
    selectedErrorForCode?: { filePath: string; line?: number; column?: number } | null;
    onSelectedErrorForCodeConsumed?: () => void;
}) {
    const { data: appFilesData, isLoading: appFilesLoading } = useQuery({
        queryKey: ['app-files', appId],
        queryFn: async () => {
            if (appId == null) return null;
            return IpcClient.getInstance().getAppFiles(appId);
        },
        enabled: appId != null,
        staleTime: 60_000,
        refetchOnWindowFocus: false,
    });
    const workspaceFiles = appFilesData?.files ?? [];
    const [sidebarFile, setSidebarFile] = useState<{ path: string; content: string } | null>(null);
    const [sidebarFileLoading, setSidebarFileLoading] = useState(false);
    const [codeSearchResults, setCodeSearchResults] = useState<{ results: any[]; query: string } | null>(null);
    const [selectedFilePathFromTree, setSelectedFilePathFromTree] = useState<string | null>(null);
    const [treeFileContent, setTreeFileContent] = useState<{ path: string; content: string } | null>(null);
    const [treeFileLoading, setTreeFileLoading] = useState(false);
    /** After atom clears, still pass initialLine into FileEditor when opening from Errors / sidebar list. */
    const treeOpenLineRef = useRef<{ path: string; line?: number } | null>(null);

    // Clear sidebar file when workspace is deselected
    useEffect(() => {
        if (!workspacePath && !appId) setSidebarFile(null);
    }, [workspacePath, appId]);

    // Miniscreen: load file when user selects from tree
    useEffect(() => {
        if (!selectedFilePathFromTree || !appId) {
            setTreeFileContent(null);
            return;
        }
        setTreeFileLoading(true);
        IpcClient.getInstance()
            .readAppFile(appId, selectedFilePathFromTree)
            .then((content) => setTreeFileContent({ path: selectedFilePathFromTree, content }))
            .catch(() => setTreeFileContent(null))
            .finally(() => setTreeFileLoading(false));
    }, [selectedFilePathFromTree, appId]);

    const selectedFilePath = selectedErrorForCode?.filePath ?? null;
    // Load file when selectedErrorForCode is set (from Errors tab "View code")
    useEffect(() => {
        if (!selectedFilePath) return;
        // Prefer readAppFile (handles path resolution) when we have appId
        if (appId) {
            // Miniscreen: editor is driven by tree selection + readAppFile in tree effect, not sidebarFile.
            if (appId) {
                treeOpenLineRef.current = {
                    path: selectedFilePath,
                    line: selectedErrorForCode?.line,
                };
                setSelectedFilePathFromTree(selectedFilePath);
                onSelectedErrorForCodeConsumed();
                return;
            }
            setSidebarFileLoading(true);
            IpcClient.getInstance()
                .readAppFile(appId, selectedFilePath)
                .then((content) => {
                    setSidebarFile({ path: selectedFilePath, content });
                    onSelectedErrorForCodeConsumed();
                })
                .catch(() => setSidebarFile(null))
                .finally(() => setSidebarFileLoading(false));
            return;
        }
        // Fallback: use readFileContent with absolute path when we have workspacePath
        if (!workspacePath) return;
        const base = workspacePath.replace(/\\/g, '/').replace(/\/$/, '');
        const rel = selectedFilePath.replace(/^[/\\]/, '').replace(/\\/g, '/');
        const absolutePath = `${base}/${rel}`.replace(/\/+/g, '/');

        setSidebarFileLoading(true);
        IpcClient.getInstance()
            .readFileContent(absolutePath)
            .then((result) => {
                if (result.success && result.content !== undefined) {
                    setSidebarFile({ path: selectedFilePath, content: result.content });
                    onSelectedErrorForCodeConsumed();
                } else {
                    setSidebarFile(null);
                }
            })
            .catch(() => setSidebarFile(null))
            .finally(() => setSidebarFileLoading(false));
    }, [selectedFilePath, workspacePath, appId, selectedErrorForCode?.line, onSelectedErrorForCodeConsumed]);

    // Check if we have errors with file paths - show editor for those
    const filesWithErrors = errors.filter(e => e.file);

    // If there are errors with files, show the ErrorFileEditor
    if (filesWithErrors.length > 0 && workspacePath) {
        return (
            <ErrorFileEditor
                errors={errors}
                workspacePath={workspacePath}
                initialFilePath={selectedFilePath || undefined}
                initialLine={selectedErrorForCode?.line}
                onInitialFilePathConsumed={onSelectedErrorForCodeConsumed}
            />
        );
    }

    // Miniscreen mode: file tree sidebar + editor whenever a workspace is selected
    if (appId) {
        return (
            <div className="flex flex-1 min-h-0 min-w-0">
                <div className="w-[160px] flex-shrink-0 border-r border-border flex flex-col bg-muted/10 overflow-hidden">
                    <div className="px-2 py-1.5 border-b border-border text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Files
                    </div>
                    <div className="flex-1 overflow-auto min-h-0">
                        {appFilesLoading ? (
                            <div className="flex items-center justify-center p-3 text-muted-foreground">
                                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" />
                            </div>
                        ) : (
                        <WorkspaceFileTree
                            files={workspaceFiles}
                            onFileClick={(path) => {
                                setSelectedFilePathFromTree(path);
                                if (treeOpenLineRef.current && path !== treeOpenLineRef.current.path) {
                                    treeOpenLineRef.current = null;
                                }
                            }}
                            maxHeight="100%"
                        />
                        )}
                    </div>
                </div>
                <div className="flex-1 min-w-0 flex flex-col min-h-0">
                    {treeFileLoading ? (
                        <div className="flex flex-col items-center justify-center flex-1 text-muted-foreground p-4">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mb-3" />
                            <p className="text-sm">Loading file...</p>
                        </div>
                    ) : treeFileContent ? (
                        <FileEditor
                            appId={appId}
                            filePath={treeFileContent.path}
                            initialLine={
                                treeOpenLineRef.current?.path === treeFileContent.path
                                    ? treeOpenLineRef.current.line
                                    : selectedErrorForCode?.filePath === treeFileContent.path
                                      ? selectedErrorForCode?.line
                                      : undefined
                            }
                        />
                    ) : (
                        <div className="flex flex-col items-center justify-center flex-1 text-muted-foreground p-4">
                            <Code2 className="w-12 h-12 mb-3 opacity-50" />
                            <p className="text-sm">Select a file from the tree</p>
                            <p className="text-xs">Add, edit, and save with Cmd/Ctrl+S</p>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    // File from sidebar click (or explicit file prop)
    const displayFile = file || sidebarFile;
    if (sidebarFileLoading) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mb-3" />
                <p className="text-sm">Loading file...</p>
            </div>
        );
    }
    if (!displayFile) {
        return (
            <div className="flex flex-col h-full min-h-0">
                {/* Codebase search in Code tab (search your codebase here, not in Web tab) */}
                {appId && (
                    <div className="p-3 border-b border-border bg-muted/10 flex-shrink-0">
                        <CodebaseSearchBox
                            appId={appId}
                            placeholder="Search codebase... e.g. 'authentication logic'"
                            onResults={(results, query) => setCodeSearchResults({ results, query })}
                        />
                        {codeSearchResults && (
                            <div className="mt-2 space-y-2 font-mono text-xs max-h-[200px] overflow-y-auto">
                                {codeSearchResults.results.slice(0, 8).map((r: any, i: number) => (
                                    <div key={i} className="rounded border border-border bg-card p-2">
                                        <div className="text-primary mb-1">{r.file?.split(/[/\\]/).pop()}:{r.line}</div>
                                        <pre className="whitespace-pre-wrap text-muted-foreground overflow-x-auto">
                                            {[...(r.contextBefore || []), r.content, ...(r.contextAfter || [])].join('\n')}
                                        </pre>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                <div className="flex flex-col items-center justify-center flex-1 text-muted-foreground p-4">
                    <Code2 className="w-12 h-12 mb-3 opacity-50" />
                    <p className="text-sm">No file selected</p>
                    <p className="text-xs">Click a file in the sidebar or select from errors</p>
                </div>
            </div>
        );
    }

    // Use Monaco FileEditor so user can edit and save (Cmd/Ctrl+S)
    if (appId) {
        return (
            <div className="flex flex-col h-full min-h-0">
                <FileEditor
                    appId={appId}
                    filePath={displayFile.path}
                    initialLine={selectedErrorForCode?.line}
                />
            </div>
        );
    }

    // Fallback when no appId (e.g. non-workspace context): read-only view
    const fileName = displayFile.path.split('/').pop();
    const lineCount = displayFile.content.split('\n').length;
    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/20">
                <div className="flex items-center gap-2">
                    <Code2 className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{fileName}</span>
                </div>
                <span className="text-xs text-muted-foreground">{lineCount} lines</span>
            </div>
            <div className="flex-1 overflow-auto">
                <pre className="p-4 text-xs font-mono text-foreground leading-relaxed">
                    {displayFile.content.split('\n').map((line, i) => (
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


/** Helper to strip ANSI codes from terminal output */
function stripAnsi(str: string) {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Terminal Tab - Command output with multi-tab support
 * Shows tabs when multiple commands/servers are running (e.g. backend + frontend)
 * v7.1.2: Enhanced with clear output, kill process, and copy functionality
 */
function TerminalTab({
    data,
    terminalOutputs,
}: {
    data?: { output: string[]; running: boolean };
    terminalOutputs?: Map<string, { operationId: string; command: string; output: string; status: string; startTime: number }>;
}) {
    const outputRef = useRef<HTMLDivElement>(null);
    const outputs = terminalOutputs && terminalOutputs.size > 0
        ? Array.from(terminalOutputs.entries())
            .map(([id, o]) => ({ id, ...o }))
            .sort((a, b) => b.startTime - a.startTime)
        : [];
    const [selectedId, setSelectedId] = useState<string | null>(
        () => outputs[0]?.operationId ?? null
    );
    const [showCopyFeedback, setShowCopyFeedback] = useState(false);

    // When outputs change, select first if none selected
    useEffect(() => {
        if (outputs.length > 0 && !selectedId) {
            setSelectedId(outputs[0].operationId);
        }
        if (outputs.length > 0 && selectedId && !outputs.some((o) => o.operationId === selectedId)) {
            setSelectedId(outputs[0].operationId);
        }
    }, [outputs, selectedId]);

    const selected = outputs.find((o) => o.operationId === selectedId) ?? outputs[0];

    // Auto-scroll to bottom when selected output changes
    useEffect(() => {
        if (outputRef.current) {
            outputRef.current.scrollTop = outputRef.current.scrollHeight;
        }
    }, [selected?.output, selected?.operationId]);

    const handleCopyOutput = () => {
        if (selected?.output) {
            navigator.clipboard.writeText(selected.output).then(() => {
                setShowCopyFeedback(true);
                setTimeout(() => setShowCopyFeedback(false), 1500);
            });
        }
    };

    const handleClearOutput = () => {
        // v7.1.2: clearTerminalOutput IPC method to be implemented
        // For now, just visual feedback that button works
        if (selected?.operationId) {
            import('@/ipc/ipc_client').then(({ IpcClient }) => {
                if ('clearTerminalOutput' in IpcClient.getInstance()) {
                    (IpcClient.getInstance() as any).clearTerminalOutput(selected.operationId);
                }
            });
        }
    };

    if (outputs.length === 0 && !data) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
                <Terminal className="w-12 h-12 mb-3 opacity-50" />
                <p className="text-sm">No terminal output</p>
                <p className="text-xs">Run a command to see output</p>
            </div>
        );
    }

    // Use selected from Map, or fallback to legacy single data
    const displayData = selected
        ? {
            output: stripAnsi(selected.output || '').split('\n').filter(Boolean),
            running: selected.status === 'running',
            command: selected.command,
            operationId: selected.operationId,
        }
        : data
            ? { output: data.output, running: data.running, command: 'Command', operationId: undefined }
            : null;

    if (!displayData) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
                <Terminal className="w-12 h-12 mb-3 opacity-50" />
                <p className="text-sm">No terminal output</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-[#1e1e1e]">
            {/* Terminal Header with Tabs */}
            <div className="flex flex-col border-b border-zinc-700 bg-zinc-900">
                {outputs.length > 1 && (
                    <div className="flex gap-1 px-2 pt-2 overflow-x-auto">
                        {outputs.map((o) => (
                            <button
                                key={o.operationId}
                                onClick={() => setSelectedId(o.operationId)}
                                className={cn(
                                    "flex items-center gap-2 px-3 py-1.5 text-xs rounded-t transition-colors shrink-0",
                                    selectedId === o.operationId
                                        ? "bg-zinc-800 text-zinc-200"
                                        : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
                                )}
                            >
                                <Terminal className="w-3 h-3" />
                                <span className="truncate max-w-[120px]" title={o.command}>
                                    {o.command.length > 20 ? o.command.slice(0, 17) + '...' : o.command}
                                </span>
                                {o.status === 'running' && (
                                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                                )}
                            </button>
                        ))}
                    </div>
                )}
                <div className="flex items-center justify-between px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                        <Terminal className="w-4 h-4 text-zinc-400 shrink-0" />
                        <span className="text-sm text-zinc-300 truncate" title={displayData.command}>
                            {displayData.command}
                        </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        {/* Copy button */}
                        <button
                            onClick={handleCopyOutput}
                            className="p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded transition-colors"
                            title="Copy output"
                        >
                            {showCopyFeedback ? (
                                <Check className="w-3.5 h-3.5 text-green-400" />
                            ) : (
                                <span className="text-xs">Copy</span>
                            )}
                        </button>
                        {/* Clear button */}
                        <button
                            onClick={handleClearOutput}
                            className="p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded transition-colors"
                            title="Clear output"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                        {/* Status indicator */}
                        {displayData.running ? (
                            <span className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-green-500/20 text-green-400">
                                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                                Running
                            </span>
                        ) : (
                            <span className="flex items-center gap-1 px-2 py-1 text-xs text-zinc-500">
                                <Play className="w-3 h-3" />
                                Completed
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {/* Terminal Output */}
            <div
                ref={outputRef}
                className="flex-1 overflow-auto p-4 font-mono text-xs text-zinc-300"
            >
                {displayData.output.map((line, i) => (
                    <div key={i} className="whitespace-pre-wrap">
                        {line}
                    </div>
                ))}
                {displayData.running && (
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
    onSolveWithAI,
    onSolveAllWithAI,
    onSwitchToCode,
    onEditErrorFile,
    onMarkDone,
}: {
    errors: ParsedError[];
    onClear?: () => void;
    onSolveWithAI?: (error: ParsedError) => void;
    onSolveAllWithAI?: (errors: ParsedError[], context: string) => void;
    onSwitchToCode?: () => void;
    onEditErrorFile?: (filePath: string, line?: number, column?: number) => void;
    onMarkDone?: (error: ParsedError) => void;
}) {
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
    const [showFixAllDialog, setShowFixAllDialog] = useState(false);
    // State for "Suggest" feature - tracks which error has input open and the notes content
    const [suggestingErrorId, setSuggestingErrorId] = useState<string | null>(null);
    const [suggestNotes, setSuggestNotes] = useState('');

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

    // Deduplicate errors by message (normalized) to prevent multiple buttons for same error
    const deduplicatedErrors = errors.reduce((acc, error) => {
        const normalizedMsg = error.message
            .replace(/:\d+:\d+/g, '') // Remove line:col
            .replace(/\?t=\d+/g, '') // Remove cache-busting
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 100);
        const key = `${normalizedMsg}-${error.file || ''}-${error.type}`;
        if (!acc.seen.has(key)) {
            acc.seen.add(key);
            acc.errors.push(error);
        }
        return acc;
    }, { seen: new Set<string>(), errors: [] as ParsedError[] }).errors;

    // Group errors by file
    const errorsByFile = deduplicatedErrors.reduce((acc, error) => {
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

    const errorCount = deduplicatedErrors.filter(e => e.severity === 'error').length;
    const warningCount = deduplicatedErrors.filter(e => e.severity === 'warning').length;

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
                <div className="flex items-center gap-2">
                    {/* Edit Code Button - Switch to Code tab for line highlighting */}
                    {onSwitchToCode && deduplicatedErrors.some(e => e.file) && (
                        <button
                            onClick={onSwitchToCode}
                            className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md bg-zinc-700/50 text-zinc-300 hover:bg-zinc-700 border border-zinc-600/50 transition-colors"
                            title="Edit code with line highlighting"
                        >
                            <Code2 className="w-3 h-3" />
                            <span>Edit Code</span>
                        </button>
                    )}
                    {/* Fix All Button */}
                    {errors.length > 1 && onSolveAllWithAI && (
                        <button
                            onClick={() => setShowFixAllDialog(true)}
                            className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20 transition-colors"
                            title="Fix all errors with AI"
                        >
                            <Sparkles className="w-3 h-3" />
                            <span>Fix All</span>
                        </button>
                    )}
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
                                                <div className="mt-3 pl-7 space-y-2">
                                                    <div className="flex items-center gap-2">
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                onSolveWithAI(error);
                                                            }}
                                                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20 transition-colors"
                                                        >
                                                            <Sparkles className="w-3 h-3" />
                                                            <span>Fix with AI</span>
                                                        </button>
                                                        {/* View code - opens exact file and line in Code tab */}
                                                        {(onEditErrorFile || onSwitchToCode) && error.file && (
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    if (onEditErrorFile) {
                                                                        onEditErrorFile(error.file!, error.line, error.column);
                                                                    } else {
                                                                        onSwitchToCode?.();
                                                                    }
                                                                }}
                                                                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-zinc-700/30 text-zinc-300 hover:bg-zinc-700/50 border border-zinc-700/50 transition-colors"
                                                                title="Open this file at line in Code tab"
                                                            >
                                                                <Code2 className="w-3 h-3" />
                                                                <span>View code</span>
                                                            </button>
                                                        )}
                                                        {/* Mark done - remove from list */}
                                                        {onMarkDone && (
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    onMarkDone(error);
                                                                }}
                                                                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-zinc-700/30 text-zinc-300 hover:bg-zinc-700/50 border border-zinc-700/50 transition-colors"
                                                                title="Mark as done and remove from list"
                                                            >
                                                                <Check className="w-3 h-3" />
                                                                <span>Mark done</span>
                                                            </button>
                                                        )}
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                if (suggestingErrorId === error.id) {
                                                                    setSuggestingErrorId(null);
                                                                    setSuggestNotes('');
                                                                } else {
                                                                    setSuggestingErrorId(error.id);
                                                                    setSuggestNotes('');
                                                                }
                                                            }}
                                                            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${suggestingErrorId === error.id
                                                                ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
                                                                : 'bg-zinc-700/30 text-zinc-400 hover:bg-zinc-700/50 border-zinc-700/50'
                                                                }`}
                                                        >
                                                            <Lightbulb className="w-3 h-3" />
                                                            <span>Suggest</span>
                                                        </button>
                                                    </div>

                                                    {/* Suggest Notes Input */}
                                                    {suggestingErrorId === error.id && (
                                                        <div className="flex flex-col gap-2 p-2 rounded-md bg-zinc-800/50 border border-zinc-700/50" onClick={(e) => e.stopPropagation()}>
                                                            <input
                                                                type="text"
                                                                value={suggestNotes}
                                                                onChange={(e) => setSuggestNotes(e.target.value)}
                                                                placeholder="Your suggestion for the AI (e.g., 'add export keyword')"
                                                                className="w-full px-2 py-1.5 text-xs rounded bg-zinc-900 border border-zinc-700 text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-primary/50"
                                                                autoFocus
                                                                onKeyDown={(e) => {
                                                                    if (e.key === 'Enter' && suggestNotes.trim()) {
                                                                        // Create enhanced error with user's suggestion
                                                                        onSolveWithAI({
                                                                            ...error,
                                                                            message: `${error.message}\n\nUser's suggestion: ${suggestNotes}`
                                                                        });
                                                                        setSuggestingErrorId(null);
                                                                        setSuggestNotes('');
                                                                    }
                                                                }}
                                                            />
                                                            <div className="flex items-center gap-2">
                                                                <button
                                                                    onClick={() => {
                                                                        if (suggestNotes.trim()) {
                                                                            onSolveWithAI({
                                                                                ...error,
                                                                                message: `${error.message}\n\nUser's suggestion: ${suggestNotes}`
                                                                            });
                                                                            setSuggestingErrorId(null);
                                                                            setSuggestNotes('');
                                                                        }
                                                                    }}
                                                                    disabled={!suggestNotes.trim()}
                                                                    className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-primary/20 text-primary hover:bg-primary/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                                                >
                                                                    <span>Send with Notes</span>
                                                                </button>
                                                                <button
                                                                    onClick={() => {
                                                                        setSuggestingErrorId(null);
                                                                        setSuggestNotes('');
                                                                    }}
                                                                    className="px-2 py-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                                                                >
                                                                    Cancel
                                                                </button>
                                                            </div>
                                                        </div>
                                                    )}
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

            {/* Fix All Errors Dialog */}
            {onSolveAllWithAI && (
                <FixAllErrorsDialog
                    isOpen={showFixAllDialog}
                    onClose={() => setShowFixAllDialog(false)}
                    errors={errors}
                    onSubmit={(selectedErrors, context) => {
                        onSolveAllWithAI(selectedErrors, context);
                        setShowFixAllDialog(false);
                    }}
                />
            )}
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
 * Search Tab - Web search results only (codebase search lives in Code tab)
 */
function SearchTab({ sources }: { sources: SourceItem[]; appId: number | null }) {
    return (
        <div className="flex flex-col h-full bg-background">
            {/* Web Search Results Header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/20 flex-shrink-0">
                <Globe className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium">Web Results</span>
                <span className="ml-auto text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">
                    {sources.length} source{sources.length !== 1 ? 's' : ''}
                </span>
            </div>

            {/* Web Source List */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
                {sources.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                        <Globe className="w-10 h-10 mb-2 opacity-40" />
                        <p className="text-xs">Web search URLs will appear here when AI searches</p>
                    </div>
                ) : sources.map((source) => (
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
