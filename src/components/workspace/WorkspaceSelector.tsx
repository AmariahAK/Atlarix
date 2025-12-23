/**
 * Atlarix Workspace Selector
 * ==========================
 * Visual folder picker for selecting project workspaces
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { FolderOpen, Check, Clock } from "lucide-react";

interface WorkspaceSelectorProps {
    isOpen: boolean;
    onClose: () => void;
    onWorkspaceSelect: (path: string) => void;
    currentWorkspace?: string;
}

export function WorkspaceSelector({
    isOpen,
    onClose,
    onWorkspaceSelect,
    currentWorkspace,
}: WorkspaceSelectorProps) {
    const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([]);

    useEffect(() => {
        // Load recent workspaces from localStorage
        const stored = localStorage.getItem("atlarix_recent_workspaces");
        if (stored) {
            setRecentWorkspaces(JSON.parse(stored));
        }
    }, []);

    const handleSelectFolder = async () => {
        try {
            // Use Electron's dialog API to show folder picker
            const result = await window.electron?.ipcRenderer.invoke(
                "dialog:openDirectory"
            );

            if (result && !result.canceled && result.filePaths[0]) {
                const selectedPath = result.filePaths[0];
                onWorkspaceSelect(selectedPath);

                // Save to recent workspaces
                const updated = [
                    selectedPath,
                    ...recentWorkspaces.filter((p) => p !== selectedPath),
                ].slice(0, 5); // Keep last 5

                setRecentWorkspaces(updated);
                localStorage.setItem(
                    "atlarix_recent_workspaces",
                    JSON.stringify(updated)
                );

                onClose();
            }
        } catch (error) {
            console.error("Failed to open folder picker:", error);
        }
    };

    const handleSelectRecent = (path: string) => {
        onWorkspaceSelect(path);
        onClose();
    };

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                    <DialogTitle>Select Workspace</DialogTitle>
                    <DialogDescription>
                        Choose a folder for Atlarix to work with. This will be the root
                        directory for file operations and code generation.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    {/* Browse Button */}
                    <Button
                        onClick={handleSelectFolder}
                        className="w-full justify-start gap-2 atlarix-glow"
                        variant="default"
                    >
                        <FolderOpen className="h-5 w-5" />
                        Browse for Folder...
                    </Button>

                    {/* Recent Workspaces */}
                    {recentWorkspaces.length > 0 && (
                        <div className="space-y-2">
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Clock className="h-4 w-4" />
                                Recent Workspaces
                            </div>

                            <div className="space-y-1">
                                {recentWorkspaces.map((path) => (
                                    <Button
                                        key={path}
                                        onClick={() => handleSelectRecent(path)}
                                        variant="ghost"
                                        className="w-full justify-start gap-2 text-left hover:bg-accent/10"
                                    >
                                        {currentWorkspace === path && (
                                            <Check className="h-4 w-4 text-primary" />
                                        )}
                                        <span className="truncate text-xs">{path}</span>
                                    </Button>
                                ))}
                            </div>
                        </div>
                    )}

                    {currentWorkspace && (
                        <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                            <div className="text-xs text-muted-foreground">
                                Current Workspace
                            </div>
                            <div className="font-mono text-sm break-all">{currentWorkspace}</div>
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
