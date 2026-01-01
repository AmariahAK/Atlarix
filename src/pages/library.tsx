/**
 * Library Page - Global + Workspace Prompts
 * ==========================================
 * - Global Prompt (1 max): Used in incognito chats
 * - Workspace Prompts (1 per workspace): Used when chatting with workspace
 * 
 * 750 character limit enforced.
 */

import React, { useState, useEffect, useCallback } from "react";
import { IpcClient } from "@/ipc/ipc_client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { showSuccess, showError } from "@/lib/toast";
import { Globe, Folder, Check, Plus, Edit2, Trash2, ChevronLeft, ChevronRight } from "lucide-react";

const MAX_PROMPT_LENGTH = 750;
const WORKSPACES_PER_PAGE = 7;

interface WorkspaceWithStatus {
  id: number;
  name: string;
  path: string;
  hasPrompt: boolean;
  promptContent?: string;
}

export default function LibraryPage() {
  // Global prompt state
  const [globalPrompt, setGlobalPrompt] = useState<string>("");
  const [originalGlobalPrompt, setOriginalGlobalPrompt] = useState<string>("");
  const [globalPromptId, setGlobalPromptId] = useState<number | null>(null);
  const [globalLoading, setGlobalLoading] = useState(true);
  const [globalSaving, setGlobalSaving] = useState(false);

  // Workspace prompts state
  const [workspaces, setWorkspaces] = useState<WorkspaceWithStatus[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(0);

  // Workspace prompt dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState<WorkspaceWithStatus | null>(null);
  const [workspacePromptDraft, setWorkspacePromptDraft] = useState("");
  const [workspaceSaving, setWorkspaceSaving] = useState(false);

  // Load global prompt
  useEffect(() => {
    const loadGlobalPrompt = async () => {
      try {
        setGlobalLoading(true);
        const prompt = await IpcClient.getInstance().getGlobalPrompt();
        if (prompt) {
          setGlobalPrompt(prompt.content);
          setOriginalGlobalPrompt(prompt.content);
          setGlobalPromptId(prompt.id);
        }
      } catch (error) {
        console.error("Failed to load global prompt:", error);
      } finally {
        setGlobalLoading(false);
      }
    };
    loadGlobalPrompt();
  }, []);

  // Load workspaces with prompt status
  const loadWorkspaces = useCallback(async () => {
    try {
      setWorkspacesLoading(true);
      const result = await IpcClient.getInstance().listWorkspacesWithPromptStatus();
      setWorkspaces(result);
    } catch (error) {
      console.error("Failed to load workspaces:", error);
    } finally {
      setWorkspacesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  // Pagination
  const totalPages = Math.ceil(workspaces.length / WORKSPACES_PER_PAGE);
  const paginatedWorkspaces = workspaces.slice(
    currentPage * WORKSPACES_PER_PAGE,
    (currentPage + 1) * WORKSPACES_PER_PAGE
  );

  // Character count styling
  const getCharCountClass = (length: number) => {
    if (length > MAX_PROMPT_LENGTH) return "text-red-500";
    if (length > MAX_PROMPT_LENGTH - 50) return "text-yellow-500";
    return "text-muted-foreground";
  };

  // Save global prompt
  const handleSaveGlobalPrompt = async () => {
    if (globalPrompt.length > MAX_PROMPT_LENGTH) {
      showError(`Prompt exceeds ${MAX_PROMPT_LENGTH} character limit`);
      return;
    }

    try {
      setGlobalSaving(true);
      const result = await IpcClient.getInstance().setGlobalPrompt(globalPrompt.trim());
      setGlobalPromptId(result.id);
      setOriginalGlobalPrompt(globalPrompt.trim());
      showSuccess("Global prompt saved!");
    } catch (error) {
      showError("Failed to save global prompt");
      console.error(error);
    } finally {
      setGlobalSaving(false);
    }
  };

  // Delete global prompt
  const handleDeleteGlobalPrompt = async () => {
    try {
      await IpcClient.getInstance().deleteGlobalPrompt();
      setGlobalPrompt("");
      setOriginalGlobalPrompt("");
      setGlobalPromptId(null);
      showSuccess("Global prompt deleted");
    } catch (error) {
      showError("Failed to delete global prompt");
      console.error(error);
    }
  };

  // Open workspace prompt dialog
  const openWorkspaceDialog = (workspace: WorkspaceWithStatus) => {
    setSelectedWorkspace(workspace);
    setWorkspacePromptDraft(workspace.promptContent || "");
    setDialogOpen(true);
  };

  // Save workspace prompt
  const handleSaveWorkspacePrompt = async () => {
    if (!selectedWorkspace) return;
    if (workspacePromptDraft.length > MAX_PROMPT_LENGTH) {
      showError(`Prompt exceeds ${MAX_PROMPT_LENGTH} character limit`);
      return;
    }

    try {
      setWorkspaceSaving(true);
      await IpcClient.getInstance().setWorkspacePrompt(
        selectedWorkspace.id,
        workspacePromptDraft.trim()
      );
      showSuccess(`Prompt saved for ${selectedWorkspace.name}!`);
      setDialogOpen(false);
      loadWorkspaces(); // Refresh list
    } catch (error) {
      showError("Failed to save workspace prompt");
      console.error(error);
    } finally {
      setWorkspaceSaving(false);
    }
  };

  // Delete workspace prompt
  const handleDeleteWorkspacePrompt = async () => {
    if (!selectedWorkspace) return;

    try {
      await IpcClient.getInstance().deleteWorkspacePrompt(selectedWorkspace.id);
      showSuccess(`Prompt deleted for ${selectedWorkspace.name}`);
      setDialogOpen(false);
      loadWorkspaces();
    } catch (error) {
      showError("Failed to delete workspace prompt");
      console.error(error);
    }
  };

  const hasGlobalChanges = globalPrompt.trim() !== originalGlobalPrompt;

  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="max-w-4xl mx-auto px-8 py-6 pb-20 space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold">Prompt Library</h1>
          <p className="text-muted-foreground mt-1">
            Customize how AI behaves in your chats
          </p>
        </div>

        {/* ════════════════════════════════════════════════════════════════════
            SECTION 1: GLOBAL AI BEHAVIOR
        ════════════════════════════════════════════════════════════════════ */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Globe className="w-5 h-5 text-primary" />
            <h2 className="text-xl font-semibold">Global AI Behavior</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Set how AI behaves in incognito chats (without workspaces). This applies to all general conversations.
          </p>

          {globalLoading ? (
            <div className="h-32 bg-muted/30 rounded-lg animate-pulse" />
          ) : (
            <div className="space-y-3">
              <Textarea
                value={globalPrompt}
                onChange={(e) => setGlobalPrompt(e.target.value)}
                placeholder="Example: Always be concise. Use British English. Assume I'm a senior developer. Skip explanations of basic concepts..."
                className="min-h-[120px] resize-none"
                maxLength={MAX_PROMPT_LENGTH + 50} // Allow slight overflow to show error
              />

              <div className="flex items-center justify-between">
                <span className={`text-sm ${getCharCountClass(globalPrompt.length)}`}>
                  {globalPrompt.length} / {MAX_PROMPT_LENGTH} characters
                </span>

                <div className="flex gap-2">
                  {globalPromptId && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={handleDeleteGlobalPrompt}
                    >
                      <Trash2 className="w-4 h-4 mr-1" />
                      Delete
                    </Button>
                  )}
                  <Button
                    onClick={handleSaveGlobalPrompt}
                    disabled={
                      globalSaving ||
                      !hasGlobalChanges ||
                      globalPrompt.length > MAX_PROMPT_LENGTH ||
                      globalPrompt.trim().length === 0
                    }
                    size="sm"
                  >
                    {globalSaving ? "Saving..." : "Save"}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Divider */}
        <hr className="border-border" />

        {/* ════════════════════════════════════════════════════════════════════
            SECTION 2: WORKSPACE PROMPTS
        ════════════════════════════════════════════════════════════════════ */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Folder className="w-5 h-5 text-primary" />
              <h2 className="text-xl font-semibold">Workspace Prompts</h2>
            </div>
            {totalPages > 1 && (
              <span className="text-sm text-muted-foreground">
                Page {currentPage + 1} of {totalPages}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Set project-specific guidance for each workspace. AI will follow these instructions when chatting about that project.
          </p>

          {workspacesLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-14 bg-muted/30 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : workspaces.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No workspaces yet. Create a workspace from the Apps page to add prompts.
            </div>
          ) : (
            <>
              <div className="space-y-2">
                {paginatedWorkspaces.map((workspace) => (
                  <div
                    key={workspace.id}
                    className="flex items-center justify-between p-4 rounded-lg border border-border bg-card/50 hover:bg-card transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Folder className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                      <div className="min-w-0">
                        <div className="font-medium truncate">{workspace.name}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {workspace.path}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 flex-shrink-0">
                      {workspace.hasPrompt ? (
                        <span className="flex items-center gap-1 text-sm text-green-500">
                          <Check className="w-4 h-4" />
                          Has prompt
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          No prompt
                        </span>
                      )}

                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openWorkspaceDialog(workspace)}
                      >
                        {workspace.hasPrompt ? (
                          <>
                            <Edit2 className="w-4 h-4 mr-1" />
                            Edit
                          </>
                        ) : (
                          <>
                            <Plus className="w-4 h-4 mr-1" />
                            Add
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex justify-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
                    disabled={currentPage === 0}
                  >
                    <ChevronLeft className="w-4 h-4 mr-1" />
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => p + 1)}
                    disabled={(currentPage + 1) * WORKSPACES_PER_PAGE >= workspaces.length}
                  >
                    Next
                    <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        {/* ════════════════════════════════════════════════════════════════════
            WORKSPACE PROMPT DIALOG
        ════════════════════════════════════════════════════════════════════ */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>
                {selectedWorkspace?.hasPrompt ? "Edit" : "Add"} Prompt: {selectedWorkspace?.name}
              </DialogTitle>
              <DialogDescription>
                Guide AI on project structure, conventions, or specific tasks for this workspace.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <Textarea
                value={workspacePromptDraft}
                onChange={(e) => setWorkspacePromptDraft(e.target.value)}
                placeholder="Example: This is a Next.js 14 app using App Router. Use server components by default. API routes in /app/api. Always include TypeScript types..."
                className="min-h-[150px] resize-none"
                maxLength={MAX_PROMPT_LENGTH + 50}
              />

              <div className="flex items-center justify-between">
                <span className={`text-sm ${getCharCountClass(workspacePromptDraft.length)}`}>
                  {workspacePromptDraft.length} / {MAX_PROMPT_LENGTH} characters
                </span>
              </div>
            </div>

            <DialogFooter className="flex justify-between sm:justify-between">
              {selectedWorkspace?.hasPrompt && (
                <Button
                  variant="destructive"
                  onClick={handleDeleteWorkspacePrompt}
                >
                  <Trash2 className="w-4 h-4 mr-1" />
                  Delete
                </Button>
              )}
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleSaveWorkspacePrompt}
                  disabled={
                    workspaceSaving ||
                    workspacePromptDraft.length > MAX_PROMPT_LENGTH ||
                    workspacePromptDraft.trim().length === 0
                  }
                >
                  {workspaceSaving ? "Saving..." : "Save"}
                </Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
