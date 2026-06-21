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
    AlertTriangle,
    Trash2,
    Shield,
    Sparkles,
    Lightbulb,
    Check,
    Folder
} from 'lucide-react';
import { InlinePermissionsHint } from '@/components/chat/InlinePermissionsHint';
import { FixAllErrorsDialog } from '../FixAllErrorsDialog';
import {
    type TerminalOutput,
    browserErrorsAtom,
    dismissedErrorSignaturesAtom,
    visibleBrowserErrorsAtom,
    getErrorSignature,
    selectedErrorForCodeAtom,
} from '@/atoms/sourceAtoms';
import { currentAppAtom } from '@/atoms/appAtoms';
import { WorkspaceFileTree } from '@/components/workspace/WorkspaceFileTree';
import { CodebaseSearchBox } from '@/components/CodebaseSearchBox';
import { type ParsedError } from '@/lib/devServerErrorParser';
import { FileEditor } from './FileEditor';
import { TerminalPanel } from '@/components/panels/TerminalPanel';

interface CodePreviewPanelProps {
    data: {
        url?: string;
        file?: { path: string; content: string };
        terminal?: { output: string[]; running: boolean };
        terminalOutputs?: Map<string, TerminalOutput>;
        errors?: ParsedError[];
        chatId?: number;         // For permissions tab
        workspacePath?: string;  // For live code editor
        appId?: number | null;
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

function CodePreviewPanel({ data, activeTab, onClearErrors, onSolveWithAI, onSolveAllWithAI, onSwitchToCode }: CodePreviewPanelProps) {
    const navigate = useNavigate();
    const currentApp = useAtomValue(currentAppAtom);
    const [selectedErrorForCode, setSelectedErrorForCode] = useAtom(selectedErrorForCodeAtom);
    const setBrowserErrors = useSetAtom(browserErrorsAtom);
    const setDismissedSignatures = useSetAtom(dismissedErrorSignaturesAtom);
    const visibleErrors = useAtomValue(visibleBrowserErrorsAtom);
    const currentAppId = data?.appId ?? currentApp?.id ?? null;
    const previewUrl = data?.url;
    const currentFile = data?.file;
    const errorsData = data?.errors !== undefined ? visibleErrors : (data?.errors || []);
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
                            onSwitchToCode={onSwitchToCode}
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
                <PermissionsTab />
            )}
        </div>
    );
}

/**
 * Preview Tab — the dev server now renders in a native WebContentsView (managed
 * by browser_view_manager) that the agent can drive via the browser tools
 * (target:"preview"). This placeholder div reports its rect via preview:set-bounds;
 * the native view paints OVER it. Runtime errors arrive over preview:error
 * (handled in useBrowserErrorListener) rather than the old iframe postMessage hack.
 */
function PreviewTab({ url }: { url?: string }) {
    const [viewport, setViewport] = useState<ViewportSize>('full');
    const placeholderRef = useRef<HTMLDivElement>(null);

    const reportBounds = useCallback(() => {
        const el = placeholderRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return;
        void IpcClient.getInstance().previewSetBounds({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        });
    }, []);

    // Load (or reload) the dev-server URL into the preview WebContentsView.
    useEffect(() => {
        if (!url) return;
        void IpcClient.getInstance().previewLoad(url);
    }, [url]);

    // Show the native view while the Preview tab is mounted; hide on unmount /
    // tab switch. Track the placeholder rect (panel resize, viewport changes).
    useEffect(() => {
        if (!url) return;
        const ipc = IpcClient.getInstance();
        void ipc.previewSetVisible(true).then(reportBounds);
        const el = placeholderRef.current;
        const observer = new ResizeObserver(() => reportBounds());
        if (el) observer.observe(el);
        window.addEventListener('resize', reportBounds);
        const settle = setTimeout(reportBounds, 250);
        return () => {
            clearTimeout(settle);
            observer.disconnect();
            window.removeEventListener('resize', reportBounds);
            void ipc.previewSetVisible(false);
        };
    }, [url, reportBounds]);

    // Re-report after a viewport change (the box resizes synchronously here).
    useEffect(() => {
        reportBounds();
    }, [viewport, reportBounds]);

    const handleRefresh = useCallback(() => {
        if (url) void IpcClient.getInstance().previewLoad(url);
    }, [url]);

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

            {/* WebContentsView footprint — the native preview view renders over this rect. */}
            <div className="flex-1 bg-muted/10 flex items-center justify-center p-4 overflow-hidden">
                <div
                    ref={placeholderRef}
                    className="bg-white rounded-lg shadow-lg overflow-hidden transition-all duration-200"
                    style={{
                        width: VIEWPORT_SIZES[viewport].width,
                        height: viewport === 'full' ? '100%' : 'calc(100% - 2rem)',
                        maxWidth: '100%'
                    }}
                />
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
    onSwitchToCode,
}: {
    file?: { path: string; content: string };
    errors?: ParsedError[];
    workspacePath?: string;
    appId?: number | null;
    selectedErrorForCode?: { filePath: string; line?: number; column?: number } | null;
    onSelectedErrorForCodeConsumed?: () => void;
    onSwitchToCode?: () => void;
}) {
    const { data: appFilesData, isLoading: appFilesLoading } = useQuery({
        queryKey: ['app-files', appId],
        queryFn: async () => {
            if (appId == null) return null;
            return IpcClient.getInstance().getAppFiles(appId);
        },
        enabled: appId != null,
        staleTime: 5_000,
        refetchOnWindowFocus: true,
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

    // The Code tab ALWAYS shows the file tree + editor. Runtime/preview errors
    // render as VS Code-style squiggles inside FileEditor (previewErrors →
    // applyPreviewMarkersToModel) and as the list in the Errors tab — the
    // legacy ErrorFileEditor takeover (which hijacked this tab whenever any
    // error carried a file path, sometimes into an EMPTY "No files with
    // errors" state after its own external-file filtering) is gone.

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
                                onSwitchToCode?.();
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
                            previewErrors={errors}
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
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4 bg-[#1e1e1e] gap-3">
                <Shield className="w-12 h-12 opacity-20 text-green-500" />
                <p className="text-sm text-green-500/80">No errors detected</p>
                <p className="text-xs text-zinc-500 text-center max-w-xs">
                    Open and edit project files in the <strong className="text-zinc-400">Code</strong> tab.
                </p>
                {onSwitchToCode ? (
                    <button
                        type="button"
                        onClick={onSwitchToCode}
                        className="text-xs px-3 py-1.5 rounded-md border border-border/60 bg-muted/30 hover:bg-muted/50 transition-colors"
                    >
                        Go to Code tab
                    </button>
                ) : null}
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
                                                <p className="flex items-center gap-1.5 text-xs text-zinc-500 mt-1 truncate">
                                                    <Folder className="w-3 h-3 shrink-0" />
                                                    <span className="truncate">{error.file}{error.line ? `:${error.line}` : ''}</span>
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
function PermissionsTab() {
    return (
        <div className="flex flex-col h-full">
            <InlinePermissionsHint />
        </div>
    );
}

export default CodePreviewPanel;
