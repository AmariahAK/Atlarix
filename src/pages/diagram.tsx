/**
 * Diagrams Page
 * =============
 * View, generate, and manage workspace architecture diagrams
 */

import { useState, useEffect, useCallback } from "react";
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
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Diagram {
    id: number;
    workspaceId: number | null;
    type: string;
    title: string;
    content: string;
    createdAt: Date;
    updatedAt: Date;
}

export default function DiagramPage() {
    const { apps, loading: isLoading } = useLoadApps();
    const [selectedWorkspace, setSelectedWorkspace] = useState<App | null>(null);
    const [diagrams, setDiagrams] = useState<Diagram[]>([]);
    const [selectedDiagram, setSelectedDiagram] = useState<Diagram | null>(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [copied, setCopied] = useState(false);
    const [loadingDiagrams, setLoadingDiagrams] = useState(false);

    // Auto-select first workspace
    useEffect(() => {
        if (apps && apps.length > 0 && !selectedWorkspace) {
            setSelectedWorkspace(apps[0]);
        }
    }, [apps, selectedWorkspace]);

    // Load diagrams when workspace changes
    useEffect(() => {
        if (selectedWorkspace) {
            // Reset selected diagram when switching workspaces
            setSelectedDiagram(null);
            loadDiagrams(selectedWorkspace.id);
        }
    }, [selectedWorkspace]);

    const loadDiagrams = async (workspaceId: number) => {
        console.log(`📊 [DiagramPage] Loading diagrams for workspace ${workspaceId}`);
        setLoadingDiagrams(true);
        try {
            const result = await IpcClient.getInstance().listDiagrams({ workspaceId });
            console.log(`📊 [DiagramPage] Result:`, result);

            if (result.success) {
                setDiagrams(result.diagrams);
                // Auto-select first diagram
                if (result.diagrams.length > 0) {
                    setSelectedDiagram(result.diagrams[0]);
                }
                console.log(`📊 [DiagramPage] Loaded ${result.diagrams.length} diagrams`);
            } else {
                console.error(`📊 [DiagramPage] Error:`, result.error);
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
            // Generate a simple architecture diagram
            const mermaidCode = `graph TB
    subgraph ${selectedWorkspace.name}
        A[Frontend] --> B[Components]
        A --> C[Pages]
        A --> D[Hooks]
        B --> E[UI Components]
        D --> F[API Calls]
        F --> G[Backend]
    end
    
    style A fill:#10B981,stroke:#059669,color:#fff
    style G fill:#F59E0B,stroke:#D97706,color:#fff`;

            const result = await IpcClient.getInstance().generateDiagram({
                workspaceId: selectedWorkspace.id,
                type: "architecture",
                title: `${selectedWorkspace.name} Architecture`,
                content: mermaidCode,
                metadata: { focus: "full-stack" },
            });

            if (result.success && result.diagram) {
                setDiagrams((prev) => [result.diagram, ...prev]);
                setSelectedDiagram(result.diagram);
            }
        } catch (error) {
            console.error("Failed to generate diagram:", error);
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

    return (
        <div className="flex-1 flex bg-background h-screen">
            {/* Workspace Selector Sidebar */}
            <div className="w-64 border-r border-border flex flex-col">
                <div className="p-4 border-b border-border">
                    <h3 className="font-semibold text-foreground mb-3">Workspaces</h3>
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
                            </div>
                        </div>

                        {/* Diagram Preview */}
                        <div className="flex-1 overflow-auto p-6">
                            <div className="diagram-preview bg-card rounded-lg border border-border p-6 min-h-[400px]">
                                <MermaidRenderer
                                    code={selectedDiagram.content}
                                    className="w-full"
                                />
                            </div>
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
        </div>
    );
}
