import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Plus, Folder, MessageSquare, Search, EyeOff, FolderOpen, FileCode2 } from "lucide-react";
import { Trash2 } from "lucide-react";
import { useAtom, useSetAtom } from "jotai";
import { selectedAppIdAtom, selectedWorkspaceInfoAtom } from "@/atoms/appAtoms";
import {
  selectedErrorForCodeAtom,
  rightPanelVisibleAtom,
  aiPanelIntentAtom,
  previewTabAtom,
} from "@/atoms/sourceAtoms";
import { WorkspaceFileTree } from "@/components/workspace/WorkspaceFileTree";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { selectedChatIdAtom } from "@/atoms/chatAtoms";
import { useLoadApps } from "@/hooks/useLoadApps";
import { useEffect, useMemo, useState } from "react";
import { AppSearchDialog } from "./AppSearchDialog";
import { WorkspaceSelector } from "@/components/workspace/WorkspaceSelector";
import { Badge } from "@/components/ui/badge";
import { IpcClient } from "@/ipc/ipc_client";
import { useAuth } from "@/lib/auth/useAuth";

interface WorkspaceWithChats {
  id: number;
  name: string;
  path: string;
  chats: { id: number; title: string | null; createdAt: Date }[];
  isExpanded: boolean;
  files?: string[];
  filesLoading?: boolean;
}

export function AppList({ show }: { show?: boolean }) {
  const navigate = useNavigate();
  const [selectedAppId, setSelectedAppId] = useAtom(selectedAppIdAtom);
  const setSelectedWorkspaceInfo = useSetAtom(selectedWorkspaceInfoAtom);
  const [selectedChatId, setSelectedChatId] = useAtom(selectedChatIdAtom);
  const setSelectedErrorForCode = useSetAtom(selectedErrorForCodeAtom);
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const setAIPanelIntent = useSetAtom(aiPanelIntentAtom);
  const setPreviewTab = useSetAtom(previewTabAtom);
  const { apps, loading, error, refreshApps } = useLoadApps();

  // Auth hook for checking plan/workspace limits
  const { status, isAuthenticated } = useAuth();

  // Workspaces with nested chats
  const [workspaces, setWorkspaces] = useState<WorkspaceWithChats[]>([]);
  const [isSearchDialogOpen, setIsSearchDialogOpen] = useState(false);
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);

  // Check if user can add more workspaces (must be logged in AND either Pro OR Free with 0 workspaces)
  const canAddWorkspace = useMemo(() => {
    if (!isAuthenticated) return false; // Must be logged in
    if (!status) return false; // Wait for status to load
    if (status.plan === 'pro') return true; // Pro = unlimited
    return apps.length < 1; // Free = only if 0 workspaces
  }, [status, apps.length, isAuthenticated]);

  // Load chats for each workspace
  useEffect(() => {
    if (!apps || apps.length === 0) return;

    const loadChats = async () => {
      const workspacesWithChats = await Promise.all(
        apps.map(async (app) => {
          try {
            const chats = await IpcClient.getInstance().getChats(app.id);
            return {
              id: app.id,
              name: app.name,
              path: app.path || '',
              chats: chats.slice(0, 10),
              isExpanded: app.id === selectedAppId,
              files: undefined,
              filesLoading: false,
            };
          } catch {
            return {
              id: app.id,
              name: app.name,
              path: app.path || '',
              chats: [],
              isExpanded: false,
              files: undefined,
              filesLoading: false,
            };
          }
        })
      );
      setWorkspaces(workspacesWithChats);
    };

    loadChats();
  }, [apps, selectedAppId]);

  // Load files when workspace is expanded
  useEffect(() => {
    const expanded = workspaces.find((w) => w.isExpanded && !w.files && !w.filesLoading);
    if (!expanded) return;

    const loadFiles = async () => {
      setWorkspaces((prev) =>
        prev.map((w) =>
          w.id === expanded.id ? { ...w, filesLoading: true } : w
        )
      );
      try {
        const appData = await IpcClient.getInstance().getApp(expanded.id);
        const files = appData.files ?? [];
        setWorkspaces((prev) =>
          prev.map((w) =>
            w.id === expanded.id ? { ...w, files, filesLoading: false } : w
          )
        );
      } catch {
        setWorkspaces((prev) =>
          prev.map((w) =>
            w.id === expanded.id ? { ...w, files: [], filesLoading: false } : w
          )
        );
      }
    };
    loadFiles();
  }, [workspaces]);

  const allApps = useMemo(
    () =>
      apps.map((a) => ({
        id: a.id,
        name: a.name,
        createdAt: a.createdAt,
        matchedChatTitle: null,
        matchedChatMessage: null,
      })),
    [apps],
  );

  if (!show) {
    return null;
  }

  const toggleWorkspace = (workspaceId: number) => {
    setWorkspaces(prev => prev.map(w =>
      w.id === workspaceId ? { ...w, isExpanded: !w.isExpanded } : w
    ));
  };

  const handleChatClick = (workspaceId: number, chatId: number) => {
    setSelectedAppId(workspaceId);
    setSelectedChatId(chatId);
    navigate({ to: `/chat/${chatId}` });
  };

  const handleNewChatInWorkspace = async (workspaceId: number) => {
    try {
      const chatId = await IpcClient.getInstance().createChat(workspaceId);
      setSelectedAppId(workspaceId);
      setSelectedChatId(chatId);
      navigate({ to: `/chat/${chatId}` });
      refreshApps?.();
    } catch (error) {
      console.error('Failed to create chat:', error);
    }
  };

  const handleFileClick = (workspaceId: number, filePath: string) => {
    const ws = workspaces.find((w) => w.id === workspaceId);
    setSelectedAppId(workspaceId);
    if (ws) setSelectedWorkspaceInfo({ id: ws.id, name: ws.name, path: ws.path });
    setSelectedErrorForCode({ filePath });
    // Open right panel and switch to Code tab for IDE-like editing
    setRightPanelVisible(true);
    setPreviewTab("code");
    setAIPanelIntent({
      intent: 'show-preview',
      timestamp: Date.now(),
      source: 'user',
    });
  };

  const handleWorkspaceSelect = async (path: string) => {
    setShowWorkspacePicker(false);

    // Check if we already have this path in our local state
    const existingApp = apps.find(app => app.path === path);

    if (existingApp) {
      // Already in our list - just select it
      setSelectedAppId(existingApp.id);
      setSelectedWorkspaceInfo({ id: existingApp.id, name: existingApp.name });
      setWorkspaces(prev => prev.map(w =>
        w.id === existingApp.id ? { ...w, isExpanded: true } : w
      ));
      return;
    }

    // Check workspace limit before importing (Free tier = 1 workspace max)
    try {
      const ipcRenderer = window.electron?.ipcRenderer;
      if (ipcRenderer?.invoke) {
        const limitCheck = await ipcRenderer.invoke('auth:check-workspace-limit') as { allowed?: boolean; reason?: string };
        if (!limitCheck.allowed) {
          // Show upgrade prompt instead of importing
          import("@/hooks/useUpgrade").then(({ triggerUpgrade }) => {
            triggerUpgrade();
          });
          alert(`Workspace limit reached. ${limitCheck.reason ?? 'Upgrade to Pro for unlimited workspaces.'}`);
          return;
        }
      }
    } catch (error) {
      console.warn('Could not check workspace limit:', error);
      // Continue anyway if check fails (fail open)
    }

    // Try to import/register the workspace
    try {
      const appName = path.split('/').pop() || 'Workspace';
      const result = await IpcClient.getInstance().importApp({ path, appName });
      setSelectedAppId(result.appId);
      setSelectedWorkspaceInfo({ id: result.appId, name: appName });
      // Refresh to get the new/existing workspace in the list
      refreshApps?.();
      // Expand the workspace
      setWorkspaces(prev => prev.map(w =>
        w.id === result.appId ? { ...w, isExpanded: true } : w
      ));
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Failed to create workspace:', error);
      // Show user-friendly error
      alert(`Could not add workspace: ${errorMessage}`);
    }
  };

  const handleIncognitoMode = async () => {
    setSelectedAppId(null);
    setSelectedWorkspaceInfo(null);
    setSelectedChatId(null);
    navigate({ to: "/" });
  };

  return (
    <>
      <SidebarGroup
        className="overflow-y-auto h-[calc(100vh-112px)]"
        data-testid="app-list-container"
      >
        <SidebarGroupLabel className="flex items-center justify-between group/header">
          <span>Workspaces</span>
          <div className="flex items-center gap-1">
            {/* Only show delete button if user is authenticated */}
            {isAuthenticated && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 opacity-0 group-hover/header:opacity-100 transition-opacity hover:text-destructive"
                title="Delete ALL Workspaces"
                onClick={async () => {
                  if (confirm("WARNING: DELETE ALL WORKSPACES? This removes all workspaces from Atlarix.")) {
                    for (const app of apps) {
                      try {
                        await IpcClient.getInstance().deleteApp(app.id);
                      } catch {
                        // Ignore errors - some may already be deleted
                      }
                    }
                    refreshApps?.();
                    setSelectedAppId(null);
                    setSelectedWorkspaceInfo(null);
                    navigate({ to: "/" });
                  }
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
            {/* Only show + button if user can add workspace (Pro OR Free with 0 workspaces) */}
            {canAddWorkspace && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                title="Add Workspace"
                onClick={() => setShowWorkspacePicker(true)}
              >
                <Plus className="h-4 w-4" />
              </Button>
            )}
            {/* Show disabled + button with tooltip for Free tier users at limit */}
            {isAuthenticated && status?.plan === 'free' && apps.length >= 1 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 opacity-50 cursor-not-allowed"
                title="Upgrade to Pro for unlimited workspaces"
                disabled
              >
                <Plus className="h-4 w-4" />
              </Button>
            )}
          </div>
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <div className="flex flex-col">
            {/* Search Apps */}
            <Button
              onClick={() => setIsSearchDialogOpen(!isSearchDialogOpen)}
              variant="ghost"
              size="sm"
              className="flex items-center justify-start gap-2 mx-2 mb-2"
              data-testid="search-apps-button"
            >
              <Search size={14} />
              <span className="text-xs">Search</span>
            </Button>

            {/* Workspaces List */}
            {!isAuthenticated ? (
              <div className="py-3 px-4 text-sm text-muted-foreground text-center">
                <EyeOff className="w-5 h-5 mx-auto mb-2 opacity-50" />
                <p>Login to access workspaces</p>
              </div>
            ) : loading ? (
              <div className="py-2 px-4 text-sm text-muted-foreground">
                Loading...
              </div>
            ) : error ? (
              <div className="py-2 px-4 text-sm text-destructive">
                Error loading apps
              </div>
            ) : workspaces.length === 0 ? (
              <div className="py-2 px-4 text-sm text-muted-foreground">
                No workspaces
              </div>
            ) : (
              <SidebarMenu className="space-y-0.5" data-testid="app-list">
                {workspaces.map((ws) => (
                  <div key={ws.id} className="border-b border-border/50">
                    {/* Workspace Header */}
                    <div
                      className={`group flex items-center gap-1 px-2 py-1.5 cursor-pointer hover:bg-accent/50 transition-colors ${selectedAppId === ws.id ? 'bg-accent' : ''
                        }`}
                      onClick={() => {
                        // Just select and expand the workspace - don't auto-navigate to chat
                        setSelectedAppId(ws.id);
                        setSelectedWorkspaceInfo({ id: ws.id, name: ws.name });
                        // Collapse other workspaces for cleaner UI
                        setWorkspaces(prev => prev.map(w =>
                          w.id === ws.id
                            ? { ...w, isExpanded: true }
                            : { ...w, isExpanded: false }
                        ));
                      }}
                      onDoubleClick={() => {
                        // Double-click to start a new chat in this workspace
                        handleNewChatInWorkspace(ws.id);
                      }}
                    >
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleWorkspace(ws.id);
                        }}
                        className="p-0.5 hover:bg-accent rounded"
                      >
                        {ws.isExpanded ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                      </button>

                      <Folder className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />

                      <span className="flex-1 text-sm font-medium truncate">
                        {ws.name}
                      </span>

                      {ws.chats.length > 0 && (
                        <Badge variant="secondary" className="text-[10px] h-4">
                          {ws.chats.length}
                        </Badge>
                      )}

                      {/* New chat button - always visible when selected, hover otherwise */}
                      <div className={`flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity ${selectedAppId === ws.id ? 'opacity-100' : ''}`}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleNewChatInWorkspace(ws.id);
                          }}
                          className="p-1 hover:bg-emerald-500/20 rounded text-muted-foreground hover:text-emerald-500"
                          title="New chat in workspace"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>

                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (confirm(`Delete workspace "${ws.name}"? This will remove it from Atlarix.`)) {
                              // 🚀 Optimistic UI update - remove immediately
                              setWorkspaces(prev => prev.filter(w => w.id !== ws.id));

                              if (selectedAppId === ws.id) {
                                setSelectedAppId(null);
                                setSelectedWorkspaceInfo(null);
                                navigate({ to: "/" });
                              }

                              // Then do the actual delete in background
                              try {
                                await IpcClient.getInstance().deleteApp(ws.id);
                              } catch (err) {
                                // Ignore "not found" errors - workspace may have been auto-deleted
                                const errorMessage = err instanceof Error ? err.message : '';
                                if (!errorMessage.includes('not found') && !errorMessage.includes('already been deleted')) {
                                  console.error("Failed to delete workspace:", err);
                                }
                              }
                              // Refresh to sync with backend
                              refreshApps?.();
                            }
                          }}
                          className="p-1 hover:bg-destructive/10 rounded text-muted-foreground hover:text-destructive"
                          title="Delete workspace"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* File tree (IDE-style) - when expanded */}
                    {ws.isExpanded && (
                      <div className="pl-6 pr-2 pt-1">
                        {ws.filesLoading ? (
                          <div className="text-[10px] text-muted-foreground py-1">Loading files...</div>
                        ) : ws.files && ws.files.length > 0 ? (
                          <>
                            <div className="flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                              <FileCode2 className="h-3 w-3" />
                              Files
                            </div>
                            <WorkspaceFileTree
                              files={ws.files}
                              onFileClick={(path) => handleFileClick(ws.id, path)}
                              maxHeight="140px"
                            />
                          </>
                        ) : null}
                      </div>
                    )}

                    {/* Chats List (Collapsible) */}
                    {ws.isExpanded && ws.chats.length > 0 && (
                      <div className="pl-6 pr-2 pb-1 space-y-0.5">
                        {ws.chats.map((chat) => (
                          <div
                            key={chat.id}
                            onClick={() => handleChatClick(ws.id, chat.id)}
                            className={`flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-accent ${selectedChatId === chat.id ? 'bg-accent' : ''
                              }`}
                          >
                            <MessageSquare className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                            <span className="text-xs truncate flex-1">
                              {chat.title || 'New conversation'}
                            </span>
                          </div>
                        ))}

                        {ws.chats.length >= 10 && (
                          <button
                            className="text-[10px] text-muted-foreground hover:text-foreground pl-2 py-1"
                            onClick={() => {
                              setSelectedAppId(ws.id);
                              setIsSearchDialogOpen(true);
                            }}
                          >
                            See all...
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </SidebarMenu>
            )}

            {/* Incognito Mode */}
            <div className="p-2 border-t mt-2">
              <Button
                variant="ghost"
                size="sm"
                className={`w-full justify-start text-xs ${selectedAppId === null ? 'bg-accent' : ''
                  }`}
                onClick={handleIncognitoMode}
              >
                <EyeOff className="h-3.5 w-3.5 mr-2" />
                Chat Only (Incognito)
              </Button>
            </div>
          </div>
        </SidebarGroupContent>
      </SidebarGroup>

      {/* Workspace Picker Dialog */}
      <WorkspaceSelector
        isOpen={showWorkspacePicker}
        onClose={() => setShowWorkspacePicker(false)}
        onWorkspaceSelect={handleWorkspaceSelect}
        currentWorkspace=""
      />

      <AppSearchDialog
        open={isSearchDialogOpen}
        onOpenChange={setIsSearchDialogOpen}
        onSelectApp={(id) => {
          setSelectedAppId(id);
          setIsSearchDialogOpen(false);
        }}
        allApps={allApps}
      />
    </>
  );
}
