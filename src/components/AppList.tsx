import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Plus, Folder, MessageSquare, Search, EyeOff, FolderOpen } from "lucide-react";
import { Trash2 } from "lucide-react";
import { getDefaultStore, useAtom, useSetAtom } from "jotai";
import { selectedAppIdAtom, selectedWorkspaceInfoAtom } from "@/atoms/appAtoms";
import {
  activeWorkspaceSessionIdAtom,
  loadedSessionResumeAtom,
  workspaceSidebarTabAtom,
  chatIdToSessionIdAtom,
  workspaceSessionsRefreshAtom,
} from "@/atoms/sessionAtoms";
import { activeChatIdAtom } from "@/atoms/chatAtoms";
import { WorkspaceSessionList } from "@/components/workspace/WorkspaceSessionList";
import { cn } from "@/lib/utils";
import {
  selectedErrorForCodeAtom,
  rightPanelVisibleAtom,
  rightPanelSuppressAutoOpenAtom,
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
import { useQueryClient } from "@tanstack/react-query";
import { clearDeletedWorkspaceClientState } from "@/lib/workspace-delete-cleanup";
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
  /** active = folder on disk; missing = path absent */
  workspaceStatus?: "active" | "missing";
}

export function AppList({ show }: { show?: boolean }) {
  const navigate = useNavigate();
  const [selectedAppId, setSelectedAppId] = useAtom(selectedAppIdAtom);
  const setSelectedWorkspaceInfo = useSetAtom(selectedWorkspaceInfoAtom);
  const [selectedChatId, setSelectedChatId] = useAtom(selectedChatIdAtom);
  const setSelectedErrorForCode = useSetAtom(selectedErrorForCodeAtom);
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const setSuppressRightAutoOpen = useSetAtom(rightPanelSuppressAutoOpenAtom);
  const setAIPanelIntent = useSetAtom(aiPanelIntentAtom);
  const setPreviewTab = useSetAtom(previewTabAtom);
  const { apps, loading, error, refreshApps } = useLoadApps();
  const queryClient = useQueryClient();
  // Auth hook for checking plan/workspace limits
  const { status, isAuthenticated } = useAuth();

  // Workspaces with nested chats
  const [workspaces, setWorkspaces] = useState<WorkspaceWithChats[]>([]);
  const [isSearchDialogOpen, setIsSearchDialogOpen] = useState(false);
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [sidebarTab, setSidebarTab] = useAtom(workspaceSidebarTabAtom);
  const setActiveWorkspaceSessionId = useSetAtom(activeWorkspaceSessionIdAtom);
  const setLoadedSessionResume = useSetAtom(loadedSessionResumeAtom);
  const setChatIdToSessionId = useSetAtom(chatIdToSessionIdAtom);
  const setActiveChatId = useSetAtom(activeChatIdAtom);
  const [activeWorkspaceSessionId] = useAtom(activeWorkspaceSessionIdAtom);

  // Paid tiers + main-process limit (Workforce was incorrectly gated as Free before)
  const canAddWorkspace = useMemo(() => {
    if (!isAuthenticated || !status) return false;
    if (status.canCreateWorkspace) return true;
    if (status.plan === "pro" || status.plan === "workforce") return true;
    return apps.length < 1;
  }, [status, apps.length, isAuthenticated]);

  // Load chats for each workspace
  useEffect(() => {
    if (!apps || apps.length === 0) return;

    const loadChats = async () => {
      const workspacesWithChats = await Promise.all(
        apps.map(async (app) => {
          try {
            const chats = await IpcClient.getInstance().getChats(app.id);
            const workspaceStatus =
              app.status ?? (app.pathExists === false ? "missing" : "active");
            return {
              id: app.id,
              name: app.name,
              path: app.path || '',
              chats: chats.slice(0, 10),
              isExpanded: app.id === selectedAppId,
              files: undefined,
              filesLoading: false,
              workspaceStatus,
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
              workspaceStatus:
                app.status ?? (app.pathExists === false ? "missing" : "active"),
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
    const appMeta = apps.find((a) => a.id === expanded.id);
    if (appMeta?.status === "missing" || appMeta?.pathExists === false) return;

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
  }, [workspaces, apps]);

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

  const handleNewConversationInWorkspace = async (workspaceId: number) => {
    const st = apps.find((a) => a.id === workspaceId);
    if (st?.status === "missing" || st?.pathExists === false) return;
    try {
      const session = await IpcClient.getInstance().createWorkspaceSession(
        workspaceId,
      );
      const chatId = await IpcClient.getInstance().createChat(workspaceId);
      setSelectedAppId(workspaceId);
      setActiveWorkspaceSessionId(session.id);
      setLoadedSessionResume(false);
      setChatIdToSessionId((prev) => {
        const next = new Map(prev);
        next.set(chatId, session.id);
        return next;
      });
      setActiveChatId(chatId);
      setSelectedChatId(chatId);
      getDefaultStore().set(workspaceSessionsRefreshAtom, (n) => n + 1);
      navigate({ to: "/" });
      refreshApps?.();
    } catch (error) {
      console.error("Failed to create conversation:", error);
    }
  };

  const handleNewChatInWorkspace = handleNewConversationInWorkspace;

  const handleFileClick = (workspaceId: number, filePath: string) => {
    const st = apps.find((a) => a.id === workspaceId);
    if (st?.status === "missing" || st?.pathExists === false) return;
    const ws = workspaces.find((w) => w.id === workspaceId);
    setSelectedAppId(workspaceId);
    if (ws) setSelectedWorkspaceInfo({ id: ws.id, name: ws.name, path: ws.path });
    setSelectedErrorForCode({ filePath });
    // Open right panel and switch to Code tab for IDE-like editing
    setSuppressRightAutoOpen(false);
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
        className="flex min-h-0 flex-1 flex-col overflow-y-auto h-[calc(100vh-112px)]"
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
                      clearDeletedWorkspaceClientState(app.id, queryClient);
                      try {
                        await IpcClient.getInstance().deleteApp(app.id);
                      } catch {
                        // Ignore errors - some may already be deleted
                      }
                    }
                    refreshApps?.();
                    setSelectedAppId(null);
                    setSelectedWorkspaceInfo(null);
                    setActiveChatId(null);
                    setSelectedChatId(null);
                    navigate({ to: "/" });
                    try {
                      const ipc = window.electron?.ipcRenderer;
                      if (ipc?.invoke) await ipc.invoke("onboarding:set-completed", false);
                    } catch {
                      // ignore
                    }
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
        <SidebarGroupContent className="min-h-0">
          <div className="flex min-h-0 flex-col">
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
                {workspaces.map((ws) => {
                  const isMissing = ws.workspaceStatus === "missing";
                  const runDeleteWorkspace = async () => {
                    clearDeletedWorkspaceClientState(ws.id, queryClient);
                    setWorkspaces((prev) => prev.filter((w) => w.id !== ws.id));
                    if (selectedAppId === ws.id) {
                      navigate({ to: "/" });
                    }
                    try {
                      await IpcClient.getInstance().deleteApp(ws.id);
                    } catch (err) {
                      const errorMessage = err instanceof Error ? err.message : "";
                      if (
                        !errorMessage.includes("not found") &&
                        !errorMessage.includes("already been deleted")
                      ) {
                        console.error("Failed to delete workspace:", err);
                      }
                    }
                    refreshApps?.();
                    if (apps.length <= 1) {
                      try {
                        const ipc = window.electron?.ipcRenderer;
                        if (ipc?.invoke) await ipc.invoke("onboarding:set-completed", false);
                      } catch {
                        /* ignore */
                      }
                    }
                  };
                  return (
                  <div
                    key={ws.id}
                    className={`border-b border-border/50 ${isMissing ? "opacity-50" : ""}`}
                  >
                    {/* Workspace Header */}
                    <div
                      className={`group flex items-center gap-1 px-2 py-1.5 transition-colors ${isMissing ? "cursor-default" : "cursor-pointer hover:bg-accent/50"} ${selectedAppId === ws.id && !isMissing ? "bg-accent" : ""
                        }`}
                      onClick={() => {
                        if (isMissing) return;
                        setSelectedAppId(ws.id);
                        setSelectedWorkspaceInfo({
                          id: ws.id,
                          name: ws.name,
                          path: ws.path,
                        });
                        setWorkspaces((prev) =>
                          prev.map((w) =>
                            w.id === ws.id
                              ? { ...w, isExpanded: true }
                              : { ...w, isExpanded: false },
                          ),
                        );
                      }}
                      onDoubleClick={() => {
                        if (isMissing) return;
                        handleNewChatInWorkspace(ws.id);
                      }}
                    >
                      <button
                        type="button"
                        disabled={isMissing}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isMissing) return;
                          toggleWorkspace(ws.id);
                        }}
                        className="p-0.5 hover:bg-accent rounded disabled:opacity-40 disabled:pointer-events-none"
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

                      {isMissing ? (
                        <Badge variant="outline" className="text-[10px] h-4 shrink-0 text-muted-foreground">
                          Folder not found
                        </Badge>
                      ) : null}

                      {ws.chats.length > 0 && !isMissing ? (
                        <Badge variant="secondary" className="text-[10px] h-4">
                          {ws.chats.length}
                        </Badge>
                      ) : null}

                      {isMissing ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs shrink-0 pointer-events-auto"
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (
                              confirm(
                                `Remove workspace "${ws.name}" from Atlarix? The folder is missing on disk.`,
                              )
                            ) {
                              await runDeleteWorkspace();
                            }
                          }}
                        >
                          Remove
                        </Button>
                      ) : (
                      <div className={`flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity ${selectedAppId === ws.id ? "opacity-100" : ""}`}>
                        <button
                          type="button"
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
                          type="button"
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (confirm(`Delete workspace "${ws.name}"? This will remove it from Atlarix.`)) {
                              await runDeleteWorkspace();
                            }
                          }}
                          className="p-1 hover:bg-destructive/10 rounded text-muted-foreground hover:text-destructive"
                          title="Delete workspace"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      )}
                    </div>

                    {/* Files / Sessions tabs — when expanded */}
                    {ws.isExpanded && !isMissing && (
                      <div className="pl-6 pr-2 pt-1">
                        <div className="flex gap-1 mb-1 px-1">
                          <button
                            type="button"
                            className={cn(
                              "flex-1 text-[10px] font-medium py-0.5 rounded",
                              sidebarTab === "files"
                                ? "bg-accent text-foreground"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSidebarTab("files");
                            }}
                          >
                            Files
                          </button>
                          <button
                            type="button"
                            className={cn(
                              "flex-1 text-[10px] font-medium py-0.5 rounded",
                              sidebarTab === "sessions"
                                ? "bg-accent text-foreground"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSidebarTab("sessions");
                            }}
                          >
                            Sessions
                          </button>
                        </div>
                        {sidebarTab === "files" ? (
                          ws.filesLoading ? (
                            <div className="text-[10px] text-muted-foreground py-1">
                              Loading files...
                            </div>
                          ) : ws.files && ws.files.length > 0 ? (
                            <WorkspaceFileTree
                              files={ws.files}
                              onFileClick={(path) => handleFileClick(ws.id, path)}
                            />
                          ) : (
                            <div className="text-[10px] text-muted-foreground py-1 px-2">
                              No files indexed.
                            </div>
                          )
                        ) : (
                          <WorkspaceSessionList
                            workspaceId={ws.id}
                            activeSessionId={
                              selectedAppId === ws.id
                                ? activeWorkspaceSessionId
                                : null
                            }
                          />
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="w-full justify-start text-xs mt-2 h-8"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleNewConversationInWorkspace(ws.id);
                          }}
                        >
                          <MessageSquare className="h-3.5 w-3.5 mr-2" />
                          New conversation
                        </Button>
                      </div>
                    )}
                  </div>
                  );
                })}
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
