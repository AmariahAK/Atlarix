/**
 * WorkspaceLimitModal - Upgrade prompt for free tier workspace limit
 * =================================================================
 * Shown when free user tries to create workspace #2.
 * Options: Upgrade to Pro or Delete existing workspace.
 */

import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Rocket, Trash2 } from "lucide-react";

interface WorkspaceLimitModalProps {
    isOpen: boolean;
    onClose: () => void;
    onUpgrade: () => void;
    onDeleteWorkspace: () => void;
    currentWorkspace?: {
        id: number;
        name: string;
        diagramCount: number;
    } | null;
}

export function WorkspaceLimitModal({
    isOpen,
    onClose,
    onUpgrade,
    onDeleteWorkspace,
    currentWorkspace,
}: WorkspaceLimitModalProps) {
    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Rocket className="h-5 w-5 text-primary" />
                        Free Tier: 1 Workspace
                    </DialogTitle>
                    <DialogDescription>
                        Your free plan includes one full-featured workspace.
                        To create another, upgrade to Pro or delete your current workspace.
                    </DialogDescription>
                </DialogHeader>

                {currentWorkspace && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950 p-4">
                        <div className="flex items-start gap-3">
                            <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5" />
                            <div>
                                <p className="font-medium text-foreground">
                                    Current workspace: "{currentWorkspace.name}"
                                </p>
                                <p className="text-sm text-muted-foreground mt-1">
                                    • {currentWorkspace.diagramCount} diagram{currentWorkspace.diagramCount !== 1 ? 's' : ''} saved
                                </p>
                                <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
                                    ⚠️ Deleting will permanently remove all diagrams, prompts, and history.
                                </p>
                            </div>
                        </div>
                    </div>
                )}

                <div className="flex flex-col gap-3 mt-4">
                    <Button
                        onClick={onUpgrade}
                        className="w-full bg-gradient-to-r from-purple-500 to-indigo-600 hover:from-purple-600 hover:to-indigo-700"
                    >
                        <Rocket className="h-4 w-4 mr-2" />
                        Upgrade to Pro ($19/mo) →
                    </Button>

                    <Button
                        variant="destructive"
                        onClick={onDeleteWorkspace}
                        className="w-full"
                    >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete Workspace & Continue Free
                    </Button>

                    <Button
                        variant="ghost"
                        onClick={onClose}
                        className="w-full"
                    >
                        Cancel
                    </Button>
                </div>

                <p className="text-xs text-center text-muted-foreground mt-2">
                    Pro includes unlimited workspaces, cross-project memory, and priority support.
                </p>
            </DialogContent>
        </Dialog>
    );
}

export default WorkspaceLimitModal;
