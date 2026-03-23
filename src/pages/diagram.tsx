/**
 * Diagrams Page
 * =============
 * View, generate, and manage workspace architecture diagrams.
 * When opened with ?appId= (full screen), shows Chat panel on the right (same session).
 */

import { useState, useEffect, useCallback } from "react";
import { useSearch } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { activeChatIdAtom } from "@/atoms/chatAtoms";
import { onboardingStepAtom } from "@/atoms/viewAtoms";
import { useLoadApps } from "@/hooks/useLoadApps";
import { App } from "@/ipc/ipc_types";
import { IpcClient } from "@/ipc/ipc_client";
import { MermaidRenderer } from "@/components/MermaidRenderer";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
    GitBranch,
    Folder,
    Plus,
    Trash2,
    RefreshCw,
    Download,
    Copy,
    Layout,
    Check,
    Sparkles,
    History,
    RotateCcw,
    Calendar,
    X,
    MessageSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useNavigate } from "@tanstack/react-router";

interface Diagram {
    id: number;
    workspaceId: number | null;
    type: string;
    title: string;
    content: string;
    createdAt: Date;
    updatedAt: Date;
}

interface DiagramVersion {
    id: number;
    diagramId: number;
    content: string;
    summary?: string;
    trigger?: string;
    changeDescription?: string;
    createdAt: Date;
}

export default function DiagramPage() {
    const search = useSearch({ strict: false }) as { appId?: number | string };
    const appIdFromRoute = search?.appId != null ? Number(search.appId) : undefined;
    const activeChatId = useAtomValue(activeChatIdAtom);
    const onboardingStep = useAtomValue(onboardingStepAtom);
    const setOnboardingStep = useSetAtom(onboardingStepAtom);
    const navigate = useNavigate();
    const { apps, loading: isLoading } = useLoadApps();
    const [selectedWorkspace, setSelectedWorkspace] = useState<App | null>(null);
    const [diagrams, setDiagrams] = useState<Diagram[]>([]);
    const [selectedDiagram, setSelectedDiagram] = useState<Diagram | null>(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [copied, setCopied] = useState(false);
    const [loadingDiagrams, setLoadingDiagrams] = useState(false);

    // History state
    const [showHistory, setShowHistory] = useState(false);
    const [versions, setVersions] = useState<DiagramVersion[]>([]);
    const [loadingHistory, setLoadingHistory] = useState(false);

    // Auto-select workspace: from route appId or first
    useEffect(() => {
        if (!apps || apps.length === 0) return;
        if (appIdFromRoute != null) {
            const match = apps.find((a) => a.id === appIdFromRoute);
            if (match) setSelectedWorkspace(match);
            return;
        }
        if (!selectedWorkspace) setSelectedWorkspace(apps[0]);
    }, [apps, selectedWorkspace, appIdFromRoute]);

    // Load diagrams when workspace changes
    useEffect(() => {
        if (selectedWorkspace) {
            // Reset selected diagram when switching workspaces
            setSelectedDiagram(null);
            loadDiagrams(selectedWorkspace.id);
        }
    }, [selectedWorkspace]);

    const loadDiagrams = async (workspaceId: number) => {
        console.log(`[DiagramPage] Loading diagrams for workspace ${workspaceId}`);
        setLoadingDiagrams(true);
        try {
            const result = await IpcClient.getInstance().listDiagrams({ workspaceId });
            console.log(`[DiagramPage] Result:`, result);

            if (result.success) {
                setDiagrams(result.diagrams);
                // Auto-select first diagram
                if (result.diagrams.length > 0) {
                    setSelectedDiagram(result.diagrams[0]);
                    console.log(`[DiagramPage] Selected diagram content:`, result.diagrams[0].content?.substring(0, 100) || 'EMPTY');
                }
                console.log(`[DiagramPage] Loaded ${result.diagrams.length} diagrams`);
            } else {
                console.error(`[DiagramPage] Error:`, result.error);
                setDiagrams([]);
            }
        } catch (error) {
            console.error("📊 [DiagramPage] Failed to load diagrams:", error);
            setDiagrams([]);
        } finally {
            setLoadingDiagrams(false);
        }
    };

    const handleGenerateDiagram = async () => {
        if (!selectedWorkspace) return;

        setIsGenerating(true);
        try {
            console.log(`[DiagramPage] Requesting AI generation for workspace ${selectedWorkspace.id}...`);

            // Call the AI generation handler
            const result = await IpcClient.getInstance().generateAiDiagram({
                workspaceId: selectedWorkspace.id,
                title: `${selectedWorkspace.name} Architecture`,
            });

            console.log("[DiagramPage] Generation result:", result);

            if (result.success && result.diagram) {
                setDiagrams((prev) => [result.diagram, ...prev]);
                setSelectedDiagram(result.diagram);
                console.log("[DiagramPage] Diagram added to state");
            } else {
                console.error("[DiagramPage] Generation failed:", result.error);
                alert(`Failed to generate diagram: ${result.error}`);
            }
        } catch (error) {
            console.error("[DiagramPage] Failed to generate diagram:", error);
        } finally {
            setIsGenerating(false);
        }
    };

    const handleDeleteDiagram = async (id: number) => {
        try {
            const result = await IpcClient.getInstance().deleteDiagram(id);
            if (result.success) {
                setDiagrams((prev) => prev.filter((d) => d.id !== id));
                if (selectedDiagram?.id === id) {
                    setSelectedDiagram(diagrams.find((d) => d.id !== id) || null);
                }
            }
        } catch (error) {
            console.error("Failed to delete diagram:", error);
        }
    };

    const handleCopyCode = () => {
        if (selectedDiagram) {
            navigator.clipboard.writeText(selectedDiagram.content);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    const handleExportSVG = () => {
        const svgElement = document.querySelector('.diagram-preview svg');
        if (svgElement) {
            const svgData = new XMLSerializer().serializeToString(svgElement);
            const blob = new Blob([svgData], { type: 'image/svg+xml' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${selectedDiagram?.title || 'diagram'}.svg`;
            a.click();
            URL.revokeObjectURL(url);
        }
    };

    // Load version history for selected diagram
    const loadHistory = async (diagramId: number) => {
        setLoadingHistory(true);
        try {
            const result = await IpcClient.getInstance().getDiagramHistory(diagramId);
            if (result.success) {
                setVersions(result.versions || []);
            }
        } catch (error) {
            console.error("Failed to load diagram history:", error);
            setVersions([]);
        } finally {
            setLoadingHistory(false);
        }
    };

    // Load history when showing panel and diagram is selected
    useEffect(() => {
        if (showHistory && selectedDiagram) {
            loadHistory(selectedDiagram.id);
        }
    }, [showHistory, selectedDiagram]);

    // Restore a previous version
    const handleRestoreVersion = async (version: DiagramVersion) => {
        if (!selectedDiagram) return;
        try {
            const result = await IpcClient.getInstance().restoreDiagramVersion({
                diagramId: selectedDiagram.id,
                versionId: version.id
            });
            if (result.success) {
                // Reload diagrams to get updated content
                if (selectedWorkspace) {
                    await loadDiagrams(selectedWorkspace.id);
                }
                setShowHistory(false);
            }
        } catch (error) {
            console.error("Failed to restore diagram version:", error);
        }
    };

    if (isLoading) {
        return (
            <div className="flex-1 flex items-center justify-center bg-background">
                <p className="text-muted-foreground">Loading workspaces...</p>
            </div>
        );
    }

    if (!apps || apps.length === 0) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center bg-background p-8">
                <div className="max-w-2xl w-full text-center space-y-4">
                    <GitBranch className="h-16 w-16 mx-auto text-muted-foreground" />
                    <h2 className="text-2xl font-bold text-foreground">No Workspaces Yet</h2>
                    <p className="text-muted-foreground">
                        Create a workspace to visualize its project structure and dependencies
                    </p>
                </div>
            </div>
        );
    }

    const showChatPanel = appIdFromRoute != null;
    const showOnboardingPanel = onboardingStep === 3;

    const handleOnboardingNext = () => {
        setOnboardingStep(4);
        navigate({ to: "/" });
    };

    return (
        <div className="flex-1 flex bg-background h-screen">
            <div className={cn("flex flex-1 min-w-0", showChatPanel && "flex-row")}>
            {/* Workspace Selector Sidebar (slim to give diagram canvas more room) */}
            <div className="w-56 flex-shrink-0 border-r border-border flex flex-col">
                <div className="p-4 border-b border-border flex items-center justify-between">
                    <h3 className="font-semibold text-foreground">Workspaces</h3>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                        title="Delete All Workspaces (Debug)"
                        onClick={async () => {
                            if (confirm("DELETE ALL WORKSPACES? This cannot be undone.")) {
                                console.log("Deleting all workspaces...");
                                try {
                                    for (const app of apps) {
                                        console.log("Deleting app:", app.id);
                                        await IpcClient.getInstance().deleteApp(app.id);
                                    }
                                    setDiagrams([]);
                                    setSelectedWorkspace(null);
                                    // Helper to force refresh apps list would be better, but this works
                                    window.location.reload();
                                } catch (e) {
                                    console.error("Failed to delete all:", e);
                                    alert("Failed to delete some workspaces. Check console.");
                                }
                            }
                        }}
                    >
                        <Trash2 className="h-4 w-4" />
                    </Button>
                </div>
                <div className="p-4 pt-0">
                    <ScrollArea className="h-[200px]">
                        <div className="space-y-1">
                            {apps.map((app) => (
                                <Button
                                    key={app.id}
                                    variant={selectedWorkspace?.id === app.id ? "default" : "ghost"}
                                    size="sm"
                                    className="w-full justify-start gap-2"
                                    onClick={() => setSelectedWorkspace(app)}
                                >
                                    <Folder className="h-4 w-4" />
                                    <span className="truncate">{app.name}</span>
                                </Button>
                            ))}
                        </div>
                    </ScrollArea>
                </div>

                {/* Diagrams List */}
                <div className="flex-1 p-4 overflow-hidden flex flex-col">
                    <div className="flex items-center justify-between mb-3">
                        <h4 className="font-medium text-sm text-foreground">Diagrams</h4>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleGenerateDiagram}
                            disabled={isGenerating || !selectedWorkspace}
                            className="h-7 px-2"
                        >
                            {isGenerating ? (
                                <RefreshCw className="h-4 w-4 animate-spin" />
                            ) : (
                                <Plus className="h-4 w-4" />
                            )}
                        </Button>
                    </div>

                    {loadingDiagrams ? (
                        <p className="text-xs text-muted-foreground">Loading...</p>
                    ) : diagrams.length === 0 ? (
                        <div className="flex-1 flex flex-col items-center justify-center text-center p-4">
                            <Layout className="h-8 w-8 text-muted-foreground mb-2" />
                            <p className="text-xs text-muted-foreground">
                                No diagrams yet
                            </p>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleGenerateDiagram}
                                disabled={isGenerating}
                                className="mt-3"
                            >
                                <Sparkles className="h-3 w-3 mr-1" />
                                Generate
                            </Button>
                        </div>
                    ) : (
                        <ScrollArea className="flex-1">
                            <div className="space-y-1">
                                {diagrams.map((diagram) => {
                                    // Format date for display
                                    const date = new Date(diagram.updatedAt);
                                    const dateStr = date.toLocaleDateString(undefined, {
                                        month: 'short',
                                        day: 'numeric',
                                        year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
                                    });

                                    return (
                                        <div
                                            key={diagram.id}
                                            className={cn(
                                                "group flex items-center gap-2 p-2 rounded-md cursor-pointer transition-colors",
                                                selectedDiagram?.id === diagram.id
                                                    ? "bg-primary/10 text-primary"
                                                    : "hover:bg-muted"
                                            )}
                                            onClick={() => setSelectedDiagram(diagram)}
                                        >
                                            <Layout className="h-4 w-4 flex-shrink-0" />
                                            <div className="flex-1 min-w-0">
                                                <p className="text-xs font-medium truncate">
                                                    {diagram.title}
                                                </p>
                                                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                                    <span className="capitalize">{diagram.type}</span>
                                                    <span>•</span>
                                                    <span>{dateStr}</span>
                                                </div>
                                            </div>
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleDeleteDiagram(diagram.id);
                                                }}
                                                className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-500/10 rounded text-red-500"
                                            >
                                                <Trash2 className="h-3 w-3" />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        </ScrollArea>
                    )}
                </div>
            </div>

            {/* Diagram View */}
            <div className="flex-1 flex flex-col overflow-hidden">
                {selectedDiagram ? (
                    <>
                        {/* Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
                            <div>
                                <h1 className="text-xl font-bold text-foreground">
                                    {selectedDiagram.title}
                                </h1>
                                <p className="text-sm text-muted-foreground capitalize">
                                    {selectedDiagram.type} diagram
                                </p>
                            </div>
                            <div className="flex items-center gap-2">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={handleCopyCode}
                                >
                                    {copied ? (
                                        <Check className="h-4 w-4 text-green-500" />
                                    ) : (
                                        <Copy className="h-4 w-4" />
                                    )}
                                    <span className="ml-1">{copied ? "Copied!" : "Copy"}</span>
                                </Button>
                                <Button variant="ghost" size="sm" onClick={handleExportSVG}>
                                    <Download className="h-4 w-4" />
                                    <span className="ml-1">SVG</span>
                                </Button>
                                <div className="w-px h-5 bg-border" />
                                <Button
                                    variant={showHistory ? "default" : "ghost"}
                                    size="sm"
                                    onClick={() => setShowHistory(!showHistory)}
                                >
                                    <History className="h-4 w-4" />
                                    <span className="ml-1">History</span>
                                </Button>
                            </div>
                        </div>

                        {/* Diagram Preview with History Sidebar */}
                        <div className="flex-1 flex overflow-hidden">
                            {/* Main Diagram Area */}
                            <div className="flex-1 overflow-auto p-6">
                                <div className="diagram-preview bg-card rounded-lg border border-border min-h-[500px] h-full" data-tour="tour-blueprint-canvas">
                                    <MermaidRenderer
                                        code={selectedDiagram.content}
                                        className="w-full h-full"
                                        onError={(err) => console.error('[DiagramPage] Mermaid error:', err)}
                                        onRender={() => console.log('[DiagramPage] Diagram rendered successfully')}
                                    />
                                </div>
                            </div>

                            {/* History Sidebar */}
                            {showHistory && (
                                <div className="w-80 border-l border-border bg-muted/30 flex flex-col overflow-hidden">
                                    <div className="flex items-center justify-between p-4 border-b border-border">
                                        <div className="flex items-center gap-2">
                                            <Calendar className="h-4 w-4 text-primary" />
                                            <h3 className="font-semibold text-sm">Version History</h3>
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-6 w-6"
                                            onClick={() => setShowHistory(false)}
                                        >
                                            <X className="h-4 w-4" />
                                        </Button>
                                    </div>

                                    <ScrollArea className="flex-1 p-4">
                                        {loadingHistory ? (
                                            <div className="flex items-center justify-center py-8">
                                                <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
                                            </div>
                                        ) : versions.length === 0 ? (
                                            <div className="text-center py-8 text-muted-foreground">
                                                <History className="h-8 w-8 mx-auto mb-2 opacity-50" />
                                                <p className="text-sm">No version history yet</p>
                                                <p className="text-xs mt-1">Versions are saved when diagrams are updated</p>
                                            </div>
                                        ) : (
                                            <div className="space-y-2">
                                                {versions.map((version, index) => {
                                                    const date = new Date(version.createdAt);
                                                    const isToday = date.toDateString() === new Date().toDateString();
                                                    const timeStr = date.toLocaleTimeString(undefined, {
                                                        hour: '2-digit',
                                                        minute: '2-digit',
                                                    });
                                                    const dateStr = isToday
                                                        ? `Today at ${timeStr}`
                                                        : date.toLocaleDateString(undefined, {
                                                            month: 'short',
                                                            day: 'numeric',
                                                            hour: '2-digit',
                                                            minute: '2-digit',
                                                        });

                                                    return (
                                                        <div
                                                            key={version.id}
                                                            className="p-3 bg-background rounded-lg border border-border hover:border-primary/50 transition-colors group"
                                                        >
                                                            <div className="flex items-start justify-between gap-2">
                                                                <div className="flex-1 min-w-0">
                                                                    <p className="text-sm font-medium text-foreground">
                                                                        {index === 0 ? 'Current' : `Version ${versions.length - index}`}
                                                                    </p>
                                                                    <p className="text-xs text-muted-foreground mt-0.5">
                                                                        {dateStr}
                                                                    </p>
                                                                    {version.summary && (
                                                                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                                                                            {version.summary}
                                                                        </p>
                                                                    )}
                                                                </div>
                                                                {index !== 0 && (
                                                                    <Button
                                                                        variant="ghost"
                                                                        size="sm"
                                                                        className="opacity-0 group-hover:opacity-100 transition-opacity h-7 px-2"
                                                                        onClick={() => handleRestoreVersion(version)}
                                                                    >
                                                                        <RotateCcw className="h-3 w-3 mr-1" />
                                                                        Restore
                                                                    </Button>
                                                                )}
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </ScrollArea>
                                </div>
                            )}
                        </div>

                        {/* Code Preview */}
                        <div className="border-t border-border bg-muted/30">
                            <details className="group">
                                <summary className="px-6 py-3 cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                                    View Mermaid Code
                                </summary>
                                <pre className="px-6 pb-4 text-xs font-mono text-foreground overflow-x-auto max-h-48">
                                    {selectedDiagram.content}
                                </pre>
                            </details>
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center">
                        <div className="text-center">
                            <Layout className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
                            <p className="text-muted-foreground">
                                Select a diagram or generate a new one
                            </p>
                        </div>
                    </div>
                )}
            </div>

            {/* Onboarding step 3: Blueprint intro panel */}
            {showOnboardingPanel && (
                <div className="w-80 flex-shrink-0 border-l border-border bg-card flex flex-col p-4 shadow-lg">
                    <h3 className="font-semibold text-foreground mb-2">About the Blueprint</h3>
                    <p className="text-sm text-muted-foreground mb-3">
                        <strong>Containers</strong> are the main building blocks of your architecture (e.g. services, apps, databases).
                    </p>
                    <p className="text-sm text-muted-foreground mb-3">
                        <strong>Beacons</strong> are entry points or landmarks (e.g. APIs, queues) that connect containers.
                    </p>
                    <p className="text-sm text-muted-foreground mb-4">
                        The diagram you see was built from your project&apos;s code by the RTE (Round-Trip Engineering) parser — this is your real project structure.
                    </p>
                    <div className="flex items-center justify-between gap-2">
                        <button type="button" className="text-muted-foreground hover:text-foreground text-xs" onClick={() => { setOnboardingStep(4); navigate({ to: "/" }); }}>Skip</button>
                        <Button onClick={handleOnboardingNext} className="gap-2">
                            <MessageSquare className="h-4 w-4" />
                            Got it, show me the chat
                        </Button>
                    </div>
                </div>
            )}

            {/* Right Chat panel (full-screen mode: same session as main) */}
            {showChatPanel && (
                <div className="w-96 flex-shrink-0 border-l border-border flex flex-col bg-[#1e1e1e]">
                    <div className="px-3 py-2 border-b border-zinc-800 text-sm font-medium text-zinc-300">
                        Chat
                    </div>
                    <DiagramPageChatTab chatId={activeChatId} />
                </div>
            )}
            </div>
        </div>
    );
}

function DiagramPageChatTab({ chatId }: { chatId: number | null }) {
    const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
    const [loading, setLoading] = useState(!!chatId);

    useEffect(() => {
        if (!chatId) {
            setMessages([]);
            setLoading(false);
            return;
        }
        setLoading(true);
        IpcClient.getInstance()
            .getChat(chatId)
            .then((chat) => {
                setMessages(
                    (chat.messages ?? []).map((m) => ({
                        role: m.role,
                        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
                    }))
                );
            })
            .catch(() => setMessages([]))
            .finally(() => setLoading(false));
    }, [chatId]);

    if (!chatId) {
        return (
            <div className="p-4 text-center text-sm text-zinc-500">
                No active chat. Start a conversation on the home page.
            </div>
        );
    }
    if (loading) {
        return (
            <div className="p-4 text-center text-sm text-zinc-500">
                Loading…
            </div>
        );
    }
    return (
        <div className="p-3 space-y-3 overflow-auto flex-1">
            {messages.map((m, i) => (
                <div
                    key={i}
                    className={cn(
                        "rounded-md px-3 py-2 text-sm",
                        m.role === "user"
                            ? "bg-primary/10 text-primary-foreground"
                            : "bg-zinc-800 text-zinc-200"
                    )}
                >
                    <div className="font-medium text-xs text-zinc-400 mb-1">{m.role}</div>
                    <div className="whitespace-pre-wrap break-words">{m.content}</div>
                </div>
            ))}
        </div>
    );
}
