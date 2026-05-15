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
import { diagramStateAtom, diagramStalenessAtom, diagramReferencesAtom, blueprintStateAtom, type DiagramState, type GitDiagramDecision, type BlueprintPanelState } from '@/atoms/sourceAtoms';
import { currentAppAtom } from '@/atoms/appAtoms';
import { cn } from '@/lib/utils';
import { MermaidRenderer } from '@/components/MermaidRenderer';
import { IpcClient } from '@/ipc/ipc_client';
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
    Info,
    Maximize2,
    ChevronDown,
} from 'lucide-react';
import { VaultPanel } from '@/components/preview_panel/VaultPanel';
import { BlueprintMiniCanvas } from '@/components/preview_panel/BlueprintMiniCanvas';
import { ReferenceProjectsCard } from '@/components/blueprint/ReferenceProjectsCard';
import type { Blueprint } from '@/shared/blueprint-types';
import type { PanelTab } from '@/atoms/sourceAtoms';

interface DiagramPanelProps {
    data: DiagramState | null;
    activeTab: string;
    setActiveTab?: (tab: PanelTab) => void;
}

type CompareMode = 'current' | 'before' | 'after' | 'side-by-side';

interface DiagramSnapshotEntry {
    turnId: string;
    timestamp: string;
    prompt?: string;
    isInitial?: boolean;
}

interface DiagramRecord {
    id: number;
    workspaceId: number | null;
    type: string;
    title: string;
    content: string;
    metadata?: unknown;
}

function blueprintPanelStateToBlueprint(panel: BlueprintPanelState): Blueprint {
    const edgeType = (t: string | undefined): "import" | "call" | "api" =>
        t === "import" || t === "api" ? t : "call";
    return {
        rooms: panel.rooms.map((r, idx) => ({
            id: r.id || `room-${idx}`,
            label: r.name || r.id,
            path: r.files?.[0],
            functions: (r.functions ?? []).slice(0, 25).map((name, j) => ({
                id: `${r.id}-fn-${j}`,
                name,
                kind: "function" as const,
            })),
        })),
        edges: panel.edges.map((e) => ({
            from: e.from,
            to: e.to,
            type: edgeType(e.type),
        })),
        envRefs: [],
    };
}

function isDiagramStateLike(v: unknown): v is DiagramState {
    if (!v || typeof v !== 'object') return false;
    const anyV = v as any;
    return typeof anyV.code === 'string' && typeof anyV.type === 'string' && typeof anyV.compareMode === 'string';
}

export function DiagramPanel({ data, activeTab, setActiveTab: _setActiveTab }: DiagramPanelProps) {
    const navigate = useNavigate();
    const [diagramState, setDiagramState] = useAtom(diagramStateAtom);
    const [staleness, setStaleness] = useAtom(diagramStalenessAtom);
    const [diagramRefs, setDiagramRefs] = useAtom(diagramReferencesAtom);
    const [blueprintPanel, setBlueprintPanel] = useAtom(blueprintStateAtom);
    const [activeRefId, setActiveRefId] = useState<string | null>(null);
    const [secBlueprintOpen, setSecBlueprintOpen] = useState(true);
    const [secDiagramOpen, setSecDiagramOpen] = useState(true);
    const [secRefOpen, setSecRefOpen] = useState(true);
    const app = useAtomValue(currentAppAtom);
    const [compareMode, setCompareMode] = useState<CompareMode>('current');
    const [snapshotEntries, setSnapshotEntries] = useState<DiagramSnapshotEntry[]>([]);
    const [showHistory, setShowHistory] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [loadingDiagram, setLoadingDiagram] = useState(false);
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

    // Pass 7: Blueprint AI-editing + onBlueprintUpdated subscriptions removed.

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

    const refreshSnapshotTimeline = useCallback(async (workspaceId: number) => {
        try {
            const result = await IpcClient.getInstance().getDiagramSnapshotTimeline(workspaceId);
            if (result.success) setSnapshotEntries(result.entries ?? []);
        } catch (e) {
            console.error("[DiagramPanel] Failed to refresh snapshot timeline:", e);
        }
    }, []);

    // Pass 7: Blueprint loading effect removed (subsystem deleted).

    const handleSelectDiagram = useCallback((record: DiagramRecord) => {
        setDiagramRefs([]);
        setActiveRefId(null);
        setDiagramState({
            id: record.id,
            code: record.content ?? '',
            type: record.type || 'mermaid',
            title: record.title,
            compareMode: 'current',
            workspaceId: app?.id ?? null,
        } as DiagramState);
    }, [app?.id, setDiagramState, setDiagramRefs]);

    useEffect(() => {
        if (app?.id != null) {
            void refreshSnapshotTimeline(app.id);
        }
    }, [app?.id, refreshSnapshotTimeline]);

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

    const appendReferenceMermaidSlice = useCallback(
        (p: string) => {
            const safe = p.replace(/"/g, "'").slice(0, 160);
            const short = p.split("/").filter(Boolean).pop() ?? "ref";
            const id = `ref-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const code = `flowchart LR\n  N["${safe}"]`;
            setDiagramRefs((prev) => {
                if (prev.some((x) => x.code === code)) return prev;
                return [...prev, { id, title: short, code, type: "mermaid" as const }].slice(-8);
            });
        },
        [setDiagramRefs],
    );

    useEffect(() => {
        if (blueprintPanel) setSecBlueprintOpen(true);
    }, [blueprintPanel]);

    // Only block the Diagram tab when there is no Mermaid diagram; Vault / logs still render.
    const showNoDiagram =
        activeTab === "diagram" && !diagram && !blueprintPanel;
    if (showNoDiagram) {
        return (
            <div className="flex flex-col h-full">
                <div className="flex flex-col items-center justify-center flex-1 text-muted-foreground p-6">
                    {loadingDiagram && (
                        <p className="text-xs text-muted-foreground/80 mb-3 flex items-center gap-2">
                            <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
                            Checking saved diagrams…
                        </p>
                    )}
                    <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                        <Code2 className="w-8 h-8 text-primary" />
                    </div>
                    <h3 className="text-lg font-medium text-foreground mb-2">No Diagram</h3>
                    <p className="text-sm text-center mb-4 max-w-sm">
                        Use the assistant tool <code className="text-xs bg-muted px-1 rounded">get_diagram</code> to generate a diagram, or pick a saved one from the dropdown when available.
                    </p>
                    {app?.id && (
                        <button
                            type="button"
                            onClick={() => void refreshDiagramsForWorkspace()}
                            disabled={isRefreshing}
                            className="px-4 py-2 border border-border rounded-lg hover:bg-muted transition-colors flex items-center gap-2 text-sm disabled:opacity-50"
                        >
                            {isRefreshing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                            Reload saved diagrams
                        </button>
                    )}
                </div>
            </div>
        );
    }

    if (loadingDiagram && activeTab === "diagram") {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-6">
                <RefreshCw className="w-8 h-8 animate-spin text-primary mb-4" />
                <p className="text-sm">Loading diagram...</p>
            </div>
        );
    }

    const hasCompareData = !!(diagram?.beforeCode && diagram?.afterCode);

    return (
        <div className="flex flex-col h-full">
            {activeTab === "diagram" && (
                <>
                    <div className="border-b border-border/50 shrink-0">
                        <div className="flex w-full items-center gap-2 px-3 py-2 bg-muted/10">
                            <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs font-medium"
                                onClick={() => setSecBlueprintOpen((v) => !v)}
                            >
                                {secBlueprintOpen ? (
                                    <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                                ) : (
                                    <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                                )}
                                <span>Blueprint (AI)</span>
                            </button>
                            {blueprintPanel ? (
                                <button
                                    type="button"
                                    className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground"
                                    onClick={() => setBlueprintPanel(null)}
                                >
                                    Clear
                                </button>
                            ) : null}
                        </div>
                        {secBlueprintOpen ? (
                            <div className="space-y-2 border-t border-border/40 px-3 pb-3 pt-2">
                                {blueprintPanel ? (
                                    <>
                                        {blueprintPanel.title ? (
                                            <p className="text-xs text-muted-foreground">{blueprintPanel.title}</p>
                                        ) : null}
                                        <BlueprintMiniCanvas
                                            blueprint={blueprintPanelStateToBlueprint(blueprintPanel)}
                                            heightPx={300}
                                        />
                                    </>
                                ) : (
                                    <p className="text-xs text-muted-foreground">
                                        No AI blueprint in the panel yet. The assistant can call{" "}
                                        <code className="text-[10px] bg-muted px-1 rounded">set_blueprint</code> or{" "}
                                        <code className="text-[10px] bg-muted px-1 rounded">get_blueprint</code> with{" "}
                                        <code className="text-[10px] bg-muted px-1 rounded">include_panel_graph</code>.
                                    </p>
                                )}
                            </div>
                        ) : null}
                    </div>

                    <div className="flex min-h-0 flex-1 flex-col border-b border-border/50">
                        <button
                            type="button"
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium bg-muted/10 hover:bg-muted/15"
                            onClick={() => setSecDiagramOpen((v) => !v)}
                        >
                            {secDiagramOpen ? (
                                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                            ) : (
                                <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                            )}
                            Architecture diagram (Mermaid)
                        </button>
                        {secDiagramOpen ? (
                            <div className="flex min-h-0 flex-1 flex-col border-t border-border/40">
                                {allDiagrams.length > 0 && (
                                    <div className="flex shrink-0 items-center gap-2 border-b border-border/50 bg-muted/10 px-3 py-1.5">
                                        <span className="text-xs text-muted-foreground">Diagram:</span>
                                        <select
                                            value={String((diagram as any)?.id ?? "")}
                                            onChange={(e) => {
                                                const id = Number(e.target.value);
                                                const record = allDiagrams.find((d) => d.id === id);
                                                if (record) handleSelectDiagram(record);
                                            }}
                                            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                                        >
                                            {allDiagrams.map((d) => (
                                                <option key={d.id} value={d.id}>
                                                    {d.title} ({d.type || "mermaid"})
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                                <div className="flex shrink-0 items-center gap-2 border-b border-border/50 bg-muted/5 px-3 py-1.5">
                                    <span className="text-xs text-muted-foreground">Live diagram</span>
                                    {app?.id ? (
                                        <button
                                            type="button"
                                            onClick={() => navigate({ to: "/diagram", search: { appId: app.id } })}
                                            className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                                        >
                                            <Maximize2 className="h-3.5 w-3.5" />
                                            Open in full screen
                                        </button>
                                    ) : null}
                                </div>
                                <div className="shrink-0 border-b border-border/50 bg-muted/5 px-3 py-1.5 text-xs text-muted-foreground">
                                    <p>
                                        Project structure and data flow. Update from chat via{" "}
                                        <code className="text-[10px] bg-muted px-1 rounded">get_diagram</code> or use
                                        Refresh when stale.
                                    </p>
                                </div>
                                {staleness &&
                                (staleness.isStale || staleness.gitDecision?.action !== "none") ? (
                                    <StalenessWarningBanner
                                        severity={staleness.severity === "none" ? "minor" : staleness.severity}
                                        reason={staleness.reason}
                                        onRefresh={handleRefreshDiagram}
                                        isRefreshing={isRefreshing}
                                        gitDecision={staleness.gitDecision}
                                    />
                                ) : null}
                                {diagram ? (
                                    <div className="min-h-0 flex-1">
                                        <DiagramViewer
                                            diagram={diagram}
                                            compareMode={compareMode}
                                            setCompareMode={setCompareMode}
                                            hasCompareData={hasCompareData}
                                            workspaceId={app?.id ?? null}
                                            snapshots={snapshotEntries}
                                            showHistory={showHistory}
                                            setShowHistory={setShowHistory}
                                            onAfterRestore={async () => {
                                                const id = (diagram as any).id as number | undefined;
                                                await refreshDiagramsForWorkspace({ preferDiagramId: id });
                                                if (app?.id != null) {
                                                    await refreshSnapshotTimeline(app.id);
                                                }
                                            }}
                                        />
                                    </div>
                                ) : (
                                    <div className="px-3 py-4 text-xs text-muted-foreground">
                                        No Mermaid diagram loaded. Use{" "}
                                        <code className="text-[10px] bg-muted px-1 rounded">get_diagram</code> or reload
                                        saved diagrams.
                                    </div>
                                )}
                            </div>
                        ) : null}
                    </div>

                    <div className="border-b border-border/50 shrink-0">
                        <button
                            type="button"
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium bg-muted/10 hover:bg-muted/15"
                            onClick={() => setSecRefOpen((v) => !v)}
                        >
                            {secRefOpen ? (
                                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                            ) : (
                                <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                            )}
                            Reference projects & diagram slices
                        </button>
                        {secRefOpen ? (
                            <div className="space-y-3 border-t border-border/40 px-3 pb-3 pt-2">
                                <ReferenceProjectsCard
                                    workspaceId={app?.id ?? null}
                                    onReferencePathAdded={appendReferenceMermaidSlice}
                                />
                                {diagramRefs.length > 0 ? (
                                    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/50 bg-muted/10 px-2 py-2">
                                        <span className="shrink-0 text-xs text-muted-foreground">Slices</span>
                                        <div className="flex flex-wrap gap-1">
                                            {diagramRefs.map((r) => (
                                                <button
                                                    key={r.id}
                                                    type="button"
                                                    onClick={() => setActiveRefId((cur) => (cur === r.id ? null : r.id))}
                                                    className={cn(
                                                        "rounded-md border px-2 py-1 text-xs transition-colors",
                                                        activeRefId === r.id
                                                            ? "border-primary bg-primary/10 text-foreground"
                                                            : "border-border bg-background text-muted-foreground hover:text-foreground",
                                                    )}
                                                >
                                                    {r.title || "Diagram slice"}
                                                </button>
                                            ))}
                                        </div>
                                        <button
                                            type="button"
                                            className="ml-auto text-xs text-muted-foreground hover:text-foreground"
                                            onClick={() => {
                                                setDiagramRefs([]);
                                                setActiveRefId(null);
                                            }}
                                        >
                                            Clear references
                                        </button>
                                    </div>
                                ) : null}
                                {activeRefId ? (
                                    <div className="max-h-[38vh] shrink-0 overflow-auto rounded-md border border-border bg-muted/20 px-3 py-2">
                                        {(() => {
                                            const sel = diagramRefs.find((r) => r.id === activeRefId);
                                            if (!sel?.code?.trim()) return null;
                                            return (
                                                <>
                                                    <p className="mb-2 text-xs text-muted-foreground">
                                                        Reference: {sel.title || "slice"}
                                                    </p>
                                                    <MermaidRenderer code={sel.code} className="min-h-[100px]" />
                                                </>
                                            );
                                        })()}
                                    </div>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                </>
            )}

            {activeTab === "vault" && (
                <div className="flex min-h-0 flex-1 flex-col">
                    <VaultPanel appId={app?.id ?? null} />
                </div>
            )}
            {activeTab === "logs" && <DiagramLogs />}
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
    workspaceId,
    snapshots,
    showHistory,
    setShowHistory,
    onAfterRestore,
}: {
    diagram: DiagramState;
    compareMode: CompareMode;
    setCompareMode: (mode: CompareMode) => void;
    hasCompareData: boolean;
    workspaceId: number | null;
    snapshots: DiagramSnapshotEntry[];
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
    const handleRestore = useCallback(
        async (entry: DiagramSnapshotEntry) => {
            if (workspaceId == null) return;
            try {
                const result = await IpcClient.getInstance().revertDiagramSnapshot({
                    workspaceId,
                    turnId: entry.turnId,
                });
                if (!result?.success) {
                    toast.error((result as any)?.error ?? "Failed to restore snapshot");
                    return;
                }
                setShowHistory(false);
                await onAfterRestore?.();
                toast.success("Restored from snapshot (files + diagram when captured)");
            } catch (error) {
                console.error("Failed to restore snapshot:", error);
                toast.error("Failed to restore snapshot");
            }
        },
        [workspaceId, onAfterRestore, setShowHistory],
    );

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
                        <p className="text-xs mt-1">Use get_diagram in chat or restore from history.</p>
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
                    {snapshots.length > 0 && (
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
                            {snapshots.length} snapshots
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
            {showHistory && snapshots.length > 0 && (
                <div className="absolute bottom-14 left-3 right-3 bg-background border border-border rounded-lg shadow-lg max-h-48 overflow-y-auto z-10">
                    <div className="p-2 text-xs font-medium text-muted-foreground border-b border-border">
                        Snapshot history
                    </div>
                    {snapshots.map((snap) => (
                        <div
                            key={snap.turnId}
                            className="flex items-center justify-between px-3 py-2 hover:bg-muted/50 border-b border-border last:border-0"
                        >
                            <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium truncate">
                                    {snap.isInitial
                                        ? "Initial diagram"
                                        : snap.prompt?.trim() || `Turn ${snap.turnId}`}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {new Date(snap.timestamp).toLocaleString()}
                                </p>
                            </div>
                            <button
                                onClick={() => handleRestore(snap)}
                                className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-primary hover:bg-primary/10"
                            >
                                <RotateCcw className="w-3 h-3" />
                                Revert
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
