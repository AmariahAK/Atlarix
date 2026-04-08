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
import { useNavigate } from '@tanstack/react-router';
import { getDefaultStore, useAtom, useAtomValue, useSetAtom } from 'jotai';
import { diagramStateAtom, diagramStalenessAtom, diagramViewModeAtom, blueprintStateAtom, blueprintAiEditingAtom, type DiagramState, type GitDiagramDecision } from '@/atoms/sourceAtoms';
import { currentAppAtom } from '@/atoms/appAtoms';
import { cn } from '@/lib/utils';
import { MermaidRenderer } from '@/components/MermaidRenderer';
import { BlueprintEditor } from '@/components/preview_panel/BlueprintEditor';
import { ReferenceProjectsCard } from '@/components/blueprint/ReferenceProjectsCard';
import { IpcClient } from '@/ipc/ipc_client';
import { createEmptyBlueprint } from '@/shared/blueprint-types';
import { toast } from 'sonner';
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
    AlertTriangle,
    RefreshCw,
    Sparkles,
    Info,
    Box,
    Bot,
    Maximize2,
} from 'lucide-react';
import { VaultPanel } from '@/components/preview_panel/VaultPanel';
import type { PanelTab } from '@/atoms/sourceAtoms';

/** Humanize blueprint tool action names for display */
function humanizeBlueprintAction(action: string): string {
    const map: Record<string, string> = {
        add_blueprint_room: "Adding room…",
        add_blueprint_function: "Adding function…",
        add_blueprint_edge: "Adding connection…",
        update_blueprint: "Updating blueprint…",
    };
    return map[action] ?? action.replace(/_/g, " ");
}

interface DiagramPanelProps {
    data: DiagramState | null;
    activeTab: string;
    setActiveTab?: (tab: PanelTab) => void;
}

type CompareMode = 'current' | 'before' | 'after' | 'side-by-side';

interface DiagramVersion {
    id: number;
    content: string;
    changeDescription: string | null;
    createdAt: Date;
}

interface DiagramRecord {
    id: number;
    workspaceId: number | null;
    type: string;
    title: string;
    content: string;
    metadata?: unknown;
}

function isDiagramStateLike(v: unknown): v is DiagramState {
    if (!v || typeof v !== 'object') return false;
    const anyV = v as any;
    return typeof anyV.code === 'string' && typeof anyV.type === 'string' && typeof anyV.compareMode === 'string';
}

export function DiagramPanel({ data, activeTab, setActiveTab }: DiagramPanelProps) {
    const navigate = useNavigate();
    const [diagramState, setDiagramState] = useAtom(diagramStateAtom);
    const [staleness, setStaleness] = useAtom(diagramStalenessAtom);
    const [viewMode, setViewMode] = useAtom(diagramViewModeAtom);
    const [blueprint, setBlueprint] = useAtom(blueprintStateAtom);
    const [aiEditing, setAiEditing] = useAtom(blueprintAiEditingAtom);
    const app = useAtomValue(currentAppAtom);
    const [compareMode, setCompareMode] = useState<CompareMode>('current');
    const [versions, setVersions] = useState<DiagramVersion[]>([]);
    const [showHistory, setShowHistory] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [loadingDiagram, setLoadingDiagram] = useState(false);
    const [loadingBlueprint, setLoadingBlueprint] = useState(false);
    const [savingBlueprint, setSavingBlueprint] = useState(false);
    const [allDiagrams, setAllDiagrams] = useState<DiagramRecord[]>([]);

    const refreshDiagramsForWorkspace = useCallback(
        async (opts?: { preferDiagramId?: number }) => {
            if (!app?.id) return;
            setLoadingDiagram(true);
            try {
                const result = await IpcClient.getInstance().listDiagrams({ workspaceId: app.id });
                if (result.success && result.diagrams && result.diagrams.length > 0) {
                    const diagrams = result.diagrams as DiagramRecord[];
                    setAllDiagrams(diagrams);
                    const preferred =
                        opts?.preferDiagramId != null
                            ? diagrams.find((d) => d.id === opts.preferDiagramId)
                            : null;
                    const currentDiagramState = getDefaultStore().get(diagramStateAtom) as DiagramState | null;
                    const currentInList =
                        currentDiagramState && (currentDiagramState as any).workspaceId === app.id
                            ? diagrams.find((d) => d.id === (currentDiagramState as any).id)
                            : null;
                    const toShow = preferred || currentInList || diagrams[0];
                    const nextState: DiagramState = {
                        id: toShow.id,
                        code: toShow.content ?? '',
                        type: toShow.type || 'mermaid',
                        title: toShow.title,
                        compareMode: 'current',
                        workspaceId: app.id,
                    } as DiagramState;

                    // Avoid noisy re-renders / history refresh loops if nothing materially changed.
                    const currentId = (currentDiagramState as any)?.id;
                    const currentCode = (currentDiagramState as any)?.code;
                    if (currentId !== nextState.id || currentCode !== nextState.code) {
                        setDiagramState(nextState);
                    }
                } else {
                    setAllDiagrams([]);
                    setDiagramState(null);
                }
            } catch (e) {
                console.error("[DiagramPanel] Failed to refresh diagrams:", e);
                setAllDiagrams([]);
            } finally {
                setLoadingDiagram(false);
            }
        },
        [app?.id, setDiagramState],
    );

    // Subscribe to "AI is editing blueprint" for visual indicator
    useEffect(() => {
        const unsub = IpcClient.getInstance().onBlueprintAiEditing((payload) => {
            setAiEditing(payload);
            setTimeout(() => setAiEditing(null), 8000);
        });
        return unsub;
    }, [setAiEditing]);

    // When AI (or backend) updates the blueprint, refresh UI
    useEffect(() => {
        const unsub = IpcClient.getInstance().onBlueprintUpdated((payload) => {
            if (app?.id === payload.workspaceId) setBlueprint(payload.blueprint);
        });
        return unsub;
    }, [app?.id, setBlueprint]);

    // Prefer diagramState when we have loaded allDiagrams for this workspace so selector and display stay in sync
    const diagram = useMemo(() => {
        const state = isDiagramStateLike(diagramState) ? diagramState : null;
        const fallback = isDiagramStateLike(data) ? data : null;

        if (allDiagrams.length > 0 && state && state.workspaceId === app?.id) {
            const match = state.id != null ? allDiagrams.find((d) => d.id === state.id) : null;
            if (match) {
                return {
                    ...state,
                    id: match.id,
                    code: match.content ?? state.code,
                    title: match.title ?? state.title,
                    type: (match.type as any) ?? state.type,
                    workspaceId: app?.id ?? state.workspaceId,
                } as DiagramState;
            }
            return state;
        }

        // When diagramState is missing workspaceId (e.g. streamed/tool diagram), prefer it over unrelated props.
        return state ?? fallback;
    }, [allDiagrams, app?.id, diagramState, data]);

    // Load ALL diagrams for workspace (same as Diagrams page) so user can switch between them
    useEffect(() => {
        if (!app?.id) return;

        void refreshDiagramsForWorkspace();
    }, [app?.id, refreshDiagramsForWorkspace]);

    const refreshHistoryForDiagram = useCallback(
        async (diagramId: number) => {
            try {
                const result = await IpcClient.getInstance().getDiagramHistory(diagramId);
                if (result.success) setVersions(result.versions);
            } catch (e) {
                console.error("[DiagramPanel] Failed to refresh history:", e);
            }
        },
        [],
    );

    // Load blueprint when workspace changes and in Blueprint mode
    useEffect(() => {
        if (!app?.id || viewMode !== 'blueprint') return;
        setLoadingBlueprint(true);
        IpcClient.getInstance()
            .getBlueprint({ workspaceId: app.id })
            .then((res) => {
                if (res.success && res.blueprint) setBlueprint(res.blueprint);
                else setBlueprint(createEmptyBlueprint());
            })
            .catch(() => setBlueprint(createEmptyBlueprint()))
            .finally(() => setLoadingBlueprint(false));
    }, [app?.id, viewMode, setBlueprint]);

    const handleSelectDiagram = useCallback((record: DiagramRecord) => {
        setDiagramState({
            id: record.id,
            code: record.content ?? '',
            type: record.type || 'mermaid',
            title: record.title,
            compareMode: 'current',
            workspaceId: app?.id ?? null,
        } as DiagramState);
    }, [app?.id, setDiagramState]);

    // Fetch version history if we have a diagram ID
    const diagramId = (diagram as any)?.id as number | undefined;
    useEffect(() => {
        if (diagramId != null) {
            void refreshHistoryForDiagram(diagramId);
        }
    }, [diagramId, refreshHistoryForDiagram]);

    // Handle refresh click
    const handleRefreshDiagram = useCallback(async () => {
        if (!app?.id) return;
        setIsRefreshing(true);
        try {
            const result = await IpcClient.getInstance().generateAiDiagram({
                workspaceId: app.id,
                title: diagram?.title,
            });
            if (result.success && result.diagram) {
                const d = result.diagram;
                setDiagramState({
                    id: d.id,
                    code: d.content,
                    type: d.type || 'mermaid',
                    title: d.title,
                    compareMode: 'current',
                    workspaceId: app.id,
                });
                setStaleness(null); // Clear staleness warning
                toast.success('Diagram regenerated');
            } else {
                const errMsg = (result as { error?: string })?.error ?? 'Regenerate failed';
                toast.error(errMsg);
            }
        } catch (error) {
            console.error('Failed to refresh diagram:', error);
            toast.error(error instanceof Error ? error.message : 'Failed to regenerate diagram');
        } finally {
            setIsRefreshing(false);
        }
    }, [app?.id, diagram?.title, setDiagramState, setStaleness]);

    if (loadingDiagram) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-6">
                <RefreshCw className="w-8 h-8 animate-spin text-primary mb-4" />
                <p className="text-sm">Loading diagram...</p>
            </div>
        );
    }

    // When Blueprint mode, we don't require a Live diagram
    const showNoDiagram = !diagram && viewMode === 'live';
    if (showNoDiagram) {
        return (
            <div className="flex flex-col h-full">
                {activeTab === 'diagram' && (
                    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 bg-muted/5">
                        <span className="text-xs text-muted-foreground">View:</span>
                        <div className="flex rounded-md border border-border overflow-hidden">
                            <button type="button" onClick={() => setViewMode('live')} className="px-3 py-1 text-xs font-medium bg-primary text-primary-foreground">Live</button>
                            <button type="button" onClick={() => setViewMode('blueprint')} className="px-3 py-1 text-xs font-medium bg-background text-muted-foreground hover:bg-muted">Blueprint</button>
                        </div>
                    </div>
                )}
                <div className="flex flex-col items-center justify-center flex-1 text-muted-foreground p-6">
                    <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                        <Code2 className="w-8 h-8 text-primary" />
                    </div>
                    <h3 className="text-lg font-medium text-foreground mb-2">No Diagram</h3>
                    <p className="text-sm text-center mb-4">
                        Generate an architecture diagram from the sidebar to visualize your project structure, or switch to <strong>Blueprint</strong> to plan rooms and functions.
                    </p>
                    {app?.id && (
                        <button
                            onClick={handleRefreshDiagram}
                            disabled={isRefreshing}
                            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-2 disabled:opacity-50"
                        >
                            {isRefreshing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                            {isRefreshing ? 'Generating...' : 'Generate Diagram'}
                        </button>
                    )}
                </div>
            </div>
        );
    }

    const hasCompareData = !!(diagram?.beforeCode && diagram?.afterCode);

    return (
        <div className="flex flex-col h-full">
            {/* Diagram selector: all diagrams for this workspace (matches Diagrams page count) */}
            {activeTab === 'diagram' && allDiagrams.length > 0 && (
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 bg-muted/10">
                    <span className="text-xs text-muted-foreground">Diagram:</span>
                    <select
                        value={String((diagram as any)?.id ?? '')}
                        onChange={(e) => {
                            const id = Number(e.target.value);
                            const record = allDiagrams.find((d) => d.id === id);
                            if (record) handleSelectDiagram(record);
                        }}
                        className="text-xs rounded-md border border-border bg-background px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary flex-1 min-w-0"
                    >
                        {allDiagrams.map((d) => (
                            <option key={d.id} value={d.id}>
                                {d.title} ({d.type || 'mermaid'})
                            </option>
                        ))}
                    </select>
                </div>
            )}
            {/* Live vs Blueprint mode toggle */}
            {activeTab === 'diagram' && (
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 bg-muted/5">
                    <span className="text-xs text-muted-foreground">View:</span>
                    <div className="flex rounded-md border border-border overflow-hidden">
                        <button
                            type="button"
                            onClick={() => setViewMode('live')}
                            className={cn(
                                "px-3 py-1 text-xs font-medium transition-colors",
                                viewMode === 'live'
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-background text-muted-foreground hover:bg-muted"
                            )}
                        >
                            Live
                        </button>
                        <button
                            type="button"
                            onClick={() => setViewMode('blueprint')}
                            className={cn(
                                "px-3 py-1 text-xs font-medium transition-colors",
                                viewMode === 'blueprint'
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-background text-muted-foreground hover:bg-muted"
                            )}
                        >
                            Blueprint
                        </button>
                    </div>
                    <span className="text-xs text-muted-foreground">
                        {viewMode === 'live' ? 'Mermaid from code' : 'Containers & beacons'}
                    </span>
                    {app?.id && (
                        <button
                            type="button"
                            onClick={() => navigate({ to: '/diagram', search: { appId: app.id } })}
                            className="ml-auto flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground rounded-md transition-colors"
                        >
                            <Maximize2 className="h-3.5 w-3.5" />
                            Open in full screen
                        </button>
                    )}
                </div>
            )}
            {/* AI is editing blueprint indicator (Cursor/Antigravity-style) - prominent sticky bar */}
            {activeTab === 'diagram' && viewMode === 'blueprint' && aiEditing && app?.id === aiEditing.workspaceId && (
                <div className="flex items-center gap-3 px-4 py-3 border-b-2 border-primary/50 bg-primary/15 text-primary sticky top-0 z-10 shadow-sm ring-1 ring-primary/20">
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/20">
                        <Bot className="w-4 h-4 animate-pulse" />
                    </div>
                    <div className="flex flex-col gap-0.5">
                        <span className="text-sm font-semibold">AI is editing the blueprint</span>
                        <span className="text-xs opacity-90">{humanizeBlueprintAction(aiEditing.action)}</span>
                    </div>
                </div>
            )}
            {/* Live mode hint */}
            {activeTab === 'diagram' && viewMode === 'live' && (
                <div className="px-3 py-1.5 border-b border-border/50 bg-muted/5 text-xs text-muted-foreground">
                    <p>Architecture diagram: project structure, components, and data flow. Edit in chat or regenerate to sync with code.</p>
                </div>
            )}
            {/* Staleness Warning Banner (with git-based Update vs Regenerate when available) */}
            {staleness && (staleness.isStale || staleness.gitDecision?.action !== 'none') && activeTab === 'diagram' && (
                <StalenessWarningBanner
                    severity={staleness.severity === 'none' ? 'minor' : staleness.severity}
                    reason={staleness.reason}
                    onRefresh={handleRefreshDiagram}
                    isRefreshing={isRefreshing}
                    gitDecision={staleness.gitDecision}
                />
            )}

            {activeTab === 'vault' && (
                <div className="flex flex-col flex-1 min-h-0">
                    <VaultPanel appId={app?.id ?? null} />
                </div>
            )}
            {activeTab === 'diagram' && viewMode === 'blueprint' && (
                <div className="flex flex-col flex-1 min-h-0">
                    <div className="px-3 py-2 border-b border-border/50">
                        <ReferenceProjectsCard workspaceId={app?.id ?? null} />
                    </div>
                    {loadingBlueprint ? (
                        <div className="flex flex-col items-center justify-center flex-1 text-muted-foreground p-6">
                            <RefreshCw className="w-8 h-8 animate-spin text-primary mb-4" />
                            <p className="text-sm">Loading blueprint…</p>
                        </div>
                    ) : (
                        <BlueprintEditor
                            blueprint={blueprint ?? createEmptyBlueprint()}
                            onSave={(b) => {
                                setBlueprint(b);
                                if (app?.id) {
                                    setSavingBlueprint(true);
                                    IpcClient.getInstance()
                                        .setBlueprint({ workspaceId: app.id, blueprint: b })
                                        .then(() => toast.success("Blueprint saved"))
                                        .catch((e) => toast.error(e?.message ?? "Failed to save blueprint"))
                                        .finally(() => setSavingBlueprint(false));
                                }
                            }}
                            isSaving={savingBlueprint}
                            onOpenCreds={setActiveTab ? () => setActiveTab('vault') : undefined}
                        />
                    )}
                </div>
            )}
            {activeTab === 'diagram' && viewMode === 'live' && diagram && (
                <DiagramViewer
                    diagram={diagram}
                    compareMode={compareMode}
                    setCompareMode={setCompareMode}
                    hasCompareData={hasCompareData}
                    versions={versions}
                    showHistory={showHistory}
                    setShowHistory={setShowHistory}
                    onAfterRestore={async () => {
                        const id = (diagram as any).id as number | undefined;
                        await refreshDiagramsForWorkspace({ preferDiagramId: id });
                        if (id != null) {
                            await refreshHistoryForDiagram(id);
                        }
                    }}
                />
            )}
            {activeTab === 'logs' && <DiagramLogs />}
        </div>
    );
}

/**
 * Staleness Warning Banner with AI accuracy explanation
 */
function StalenessWarningBanner({
    severity,
    reason,
    onRefresh,
    isRefreshing,
    gitDecision,
}: {
    severity: 'minor' | 'moderate' | 'major';
    reason: string;
    onRefresh: () => void;
    isRefreshing: boolean;
    /** When workspace is git: update vs regenerate decision for button label */
    gitDecision?: GitDiagramDecision | null;
}) {
    const colors = {
        minor: 'bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/30',
        moderate: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30',
        major: 'bg-destructive/10 text-destructive border-destructive/30',
    };

    const messages = {
        minor: 'Minor project changes detected.',
        moderate: 'Project structure has changed.',
        major: 'Significant changes detected!',
    };

    const buttonLabel = gitDecision?.action === 'update'
        ? (isRefreshing ? 'Updating...' : 'Update Diagram')
        : gitDecision?.action === 'regenerate'
            ? (isRefreshing ? 'Regenerating...' : 'Regenerate Diagram')
            : (isRefreshing ? 'Refreshing...' : 'Refresh Diagram');

    return (
        <div className={cn(
            "flex flex-col gap-2 px-3 py-3 border-b",
            colors[severity]
        )}>
            <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span className="text-sm font-medium">{messages[severity]}</span>
                </div>
                <button
                    onClick={onRefresh}
                    disabled={isRefreshing}
                    className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors shrink-0",
                        severity === 'major' || gitDecision?.action === 'regenerate'
                            ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            : "bg-primary text-primary-foreground hover:bg-primary/90",
                        isRefreshing && "opacity-50 cursor-not-allowed"
                    )}
                >
                    <RefreshCw className={cn("w-3 h-3", isRefreshing && "animate-spin")} />
                    {buttonLabel}
                </button>
            </div>
            <div className="flex items-start gap-2 text-xs opacity-80">
                <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>
                    {gitDecision ? reason : 'Refreshing helps the AI understand your current project structure accurately.'}
                    {!gitDecision && severity === 'major' && ' Outdated diagrams may cause incorrect suggestions.'}
                    {gitDecision && gitDecision.totalFiles > 0 && (
                        <span className="block mt-1">
                            {gitDecision.totalFiles} file(s) changed (+{gitDecision.linesAdded}/-{gitDecision.linesDeleted} lines).
                        </span>
                    )}
                </span>
            </div>
        </div>
    );
}

/** Treat as Mermaid if type is mermaid/architecture/flowchart/sequence/class or content looks like Mermaid */
function isMermaidLike(code: string, type: string): boolean {
    const t = (type || '').toLowerCase();
    if (['mermaid', 'architecture', 'flowchart', 'sequence', 'class'].includes(t)) return true;
    const trimmed = (code || '').trim();
    if (!trimmed) return false;
    const first = trimmed.split(/\s/)[0]?.toLowerCase() ?? '';
    return ['graph', 'flowchart', 'sequenceDiagram', 'classDiagram', 'stateDiagram', 'erDiagram', 'journey', 'gantt'].some((kw) => first.startsWith(kw));
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
    onAfterRestore,
}: {
    diagram: DiagramState;
    compareMode: CompareMode;
    setCompareMode: (mode: CompareMode) => void;
    hasCompareData: boolean;
    versions: DiagramVersion[];
    showHistory: boolean;
    setShowHistory: (show: boolean) => void;
    onAfterRestore?: () => Promise<void>;
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
        void navigator.clipboard.writeText(displayCode).catch((e) => {
            console.error("[DiagramPanel] Failed to copy:", e);
        });
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
            const result = await IpcClient.getInstance().restoreDiagramVersion({
                diagramId: (diagram as any).id,
                versionId: version.id,
            });
            if (!result?.success) {
                toast.error((result as any)?.error ?? "Failed to restore diagram version");
                return;
            }
            setShowHistory(false);
            await onAfterRestore?.();
            toast.success("Restored diagram version");
        } catch (error) {
            console.error('Failed to restore version:', error);
            toast.error("Failed to restore diagram version");
        }
    }, [diagram, onAfterRestore, setShowHistory]);

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
                ) : !(displayCode || '').trim() ? (
                    <div className="flex flex-col items-center justify-center min-h-[300px] text-muted-foreground p-6">
                        <Layout className="w-12 h-12 mb-3 opacity-50" />
                        <p className="text-sm">No diagram content yet</p>
                        <p className="text-xs mt-1">Generate or restore a diagram to see it here.</p>
                    </div>
                ) : isMermaidLike(displayCode, diagram.type) ? (
                    <MermaidRenderer
                        code={displayCode}
                        className="min-h-[300px]"
                        onRender={setRenderedSvg}
                    />
                ) : (
                    <UnsupportedDiagramPreview code={displayCode} type={diagram.type} />
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
 * Unsupported Diagram Type Preview
 */
function UnsupportedDiagramPreview({ code, type }: { code: string; type: string }) {
    // Guard against undefined/null code
    const safeCode = code || '';

    return (
        <div className="space-y-4">
            <div className="bg-gradient-to-br from-amber-500/5 to-orange-500/5 rounded-lg border border-border p-6 min-h-[200px] flex items-center justify-center">
                <div className="text-center space-y-3">
                    <Layout className="w-16 h-16 mx-auto text-amber-500/50" />
                    <p className="text-sm text-muted-foreground">Unsupported Diagram Type: {type}</p>
                    <p className="text-xs text-muted-foreground/70">
                        {safeCode.split('\n').length} lines • Only Mermaid diagrams are supported
                    </p>
                </div>
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

/**
 * Staleness Banner - Shows when diagram is outdated
 */
interface StalenessBannerProps {
    severity: 'minor' | 'moderate' | 'major';
    reason: string;
    onRefresh: () => void;
    isRefreshing?: boolean;
}

export function StalenessBanner({ severity, reason, onRefresh, isRefreshing }: StalenessBannerProps) {
    const colors = {
        minor: 'bg-muted/50 text-muted-foreground border-border',
        moderate: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30',
        major: 'bg-destructive/10 text-destructive border-destructive/30',
    };

    return (
        <div className={cn(
            "flex items-center justify-between gap-3 px-3 py-2 border-b",
            colors[severity]
        )}>
            <div className="flex items-center gap-2 flex-1 min-w-0">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span className="text-xs truncate">{reason}</span>
            </div>
            <button
                onClick={onRefresh}
                disabled={isRefreshing}
                className={cn(
                    "flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors shrink-0",
                    severity === 'major'
                        ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        : "bg-primary text-primary-foreground hover:bg-primary/90",
                    isRefreshing && "opacity-50 cursor-not-allowed"
                )}
            >
                <RefreshCw className={cn("w-3 h-3", isRefreshing && "animate-spin")} />
                {isRefreshing ? 'Refreshing...' : 'Refresh'}
            </button>
        </div>
    );
}

export default DiagramPanel;
