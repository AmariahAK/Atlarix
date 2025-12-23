import { useState, useEffect } from "react";
import { useLoadApps } from "@/hooks/useLoadApps";
import { App } from "@/ipc/ipc_types";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GitBranch, Folder } from "lucide-react";

export default function DiagramPage() {
    const { apps, loading: isLoading } = useLoadApps();
    const [selectedWorkspace, setSelectedWorkspace] = useState<App | null>(null);

    useEffect(() => {
        // Auto-select first workspace if available
        if (apps && apps.length > 0 && !selectedWorkspace) {
            setSelectedWorkspace(apps[0]);
        }
    }, [apps, selectedWorkspace]);

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
        <div className="flex-1 flex bg-background">
            {/* Workspace Selector Sidebar */}
            <div className="w-64 border-r border-border p-4 space-y-4">
                <h3 className="font-semibold text-foreground">Select Workspace</h3>
                <ScrollArea className="h-[calc(100vh-120px)]">
                    <div className="space-y-2">
                        {apps.map((app) => (
                            <Button
                                key={app.id}
                                variant={selectedWorkspace?.id === app.id ? "default" : "ghost"}
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

            {/* Diagram View */}
            <div className="flex-1 p-8">
                {selectedWorkspace ? (
                    <div className="space-y-6">
                        <div>
                            <h1 className="text-3xl font-bold text-foreground mb-2">
                                {selectedWorkspace.name}
                            </h1>
                            <p className="text-sm text-muted-foreground">
                                {selectedWorkspace.path}
                            </p>
                        </div>

                        <div className="mt-8 p-6 border border-border rounded-lg bg-card">
                            <h3 className="text-lg font-semibold text-foreground mb-4">
                                Project Structure Diagram
                            </h3>
                            <p className="text-muted-foreground mb-6">
                                Interactive visualization coming soon...
                            </p>

                            <div className="space-y-4">
                                <div className="p-4 border border-border rounded-lg">
                                    <h4 className="font-medium text-foreground mb-2">📊 Dependency Graph</h4>
                                    <p className="text-sm text-muted-foreground">
                                        Visualize import relationships and module dependencies
                                    </p>
                                </div>

                                <div className="p-4 border border-border rounded-lg">
                                    <h4 className="font-medium text-foreground mb-2">🗂️ File Structure</h4>
                                    <p className="text-sm text-muted-foreground">
                                        Navigate through your project's folder hierarchy
                                    </p>
                                </div>

                                <div className="p-4 border border-border rounded-lg">
                                    <h4 className="font-medium text-foreground mb-2">🔄 Component Flow</h4>
                                    <p className="text-sm text-muted-foreground">
                                        Understand data flow between React components
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="flex items-center justify-center h-full">
                        <p className="text-muted-foreground">Select a workspace to view its diagram</p>
                    </div>
                )}
            </div>
        </div>
    );
}
