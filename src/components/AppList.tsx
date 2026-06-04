import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Plus, Folder, MessageSquare, Search, EyeOff, AppWindow } from "lucide-react";
import { Trash2 } from "lucide-react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { selectedAppIdAtom, selectedWorkspaceInfoAtom } from "@/atoms/appAtoms";
import { startNewWorkspaceConversation } from "@/lib/open-workspace-session";
import { activeWorkspaceSessionIdAtom } from "@/atoms/sessionAtoms";
import { WorkspaceSessionList } from "@/components/workspace/WorkspaceSessionList";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { activeChatIdAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";
import { useLoadApps } from "@/hooks/useLoadApps";
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { clearDeletedWorkspaceClientState } from "@/lib/workspace-delete-cleanup";
import { AppSearchDialog } from "./AppSearchDialog";
import { LocalDateTimeClock } from "@/components/LocalDateTimeClock";
import { pushRecentWorkspace } from "@/lib/workspace-recents";
import { openWorkspaceFolder } from "@/lib/open-workspace-session";
import { Badge } from "@/components/ui/badge";
import { IpcClient } from "@/ipc/ipc_client";
import { useAuth } from "@/lib/auth/useAuth";

interface WorkspaceWithChats {
  id: number;
  name: string;
  path: string;
  chats: { id: number; title: string | null; createdAt: Date }[];
  isExpanded: boolean;
  /** active = folder on disk; missing = path absent */
  workspaceStatus?: "active" | "missing";
}

export function AppList({ show }: { show?: boolean }) {
  const navigate = useNavigate();
  const [selectedAppId, setSelectedAppId] = useAtom(selectedAppIdAtom);
  const workspaceInfo = useAtomValue(selectedWorkspaceInfoAtom);
  const setSelectedWorkspaceInfo = useSetAtom(selectedWorkspaceInfoAtom);
  const [, setSelectedChatId] = useAtom(selectedChatIdAtom);
  const { apps, loading, error, refreshApps } = useLoadApps();
  const queryClient = useQueryClient();
  // Auth hook for checking plan/workspace limits
  const { status, isAuthenticated } = useAuth();

  // Workspaces with nested chats
  const [workspaces, setWorkspaces] = useState<WorkspaceWithChats[]>([]);
  const [isSearchDialogOpen, setIsSearchDialogOpen] = useState(false);
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
            const sessions = await IpcClient.getInstance().listWorkspaceSessions(
              app.id,
            );
            const chats = sessions.map(
              (s: { id: string; title: string | null; createdAt: Date }) => ({
                id: s.id as unknown as number,
                title: s.title,
                createdAt: s.createdAt,
                appId: app.id,
              }),
            );
            const workspaceStatus =
              app.status ?? (app.pathExists === false ? "missing" : "active");
            return {
              id: app.id,
              name: app.name,
              path: app.path || '',
              chats: chats.slice(0, 10),
              isExpanded: app.id === selectedAppId,
              workspaceStatus,
            };
          } catch {
            return {
              id: app.id,
              name: app.name,
              path: app.path || '',
              chats: [],
              isExpanded: false,
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

  /** When a workspace is open, show only that folder in the sidebar (switch via recents / +). */
  const visibleWorkspaces = useMemo(() => {
    if (selectedAppId == null) return workspaces;
    return workspaces
      .filter((w) => w.id === selectedAppId)
      .map((w) => ({ ...w, isExpanded: true }));
  }, [workspaces, selectedAppId]);

  const activeWorkspaceLabel = useMemo(() => {
    if (selectedAppId == null) return "Workspaces";
    const ws = workspaces.find((w) => w.id === selectedAppId);
    return ws?.name ?? "Workspace";
  }, [selectedAppId, workspaces]);

  const activeWorkspacePath = useMemo(() => {
    if (selectedAppId == null) return null;
    const ws = workspaces.find((w) => w.id === selectedAppId);
    const path = ws?.path?.trim() || workspaceInfo?.path?.trim();
    return path || null;
  }, [selectedAppId, workspaces, workspaceInfo?.path]);

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
    await startNewWorkspaceConversation({
      workspaceId,
      workspaceName: st?.name,
      workspacePath: st?.path,
      navigate: (opts) => navigate(opts),
      refreshApps,
    });
  };

  const handleNewChatInWorkspace = handleNewConversationInWorkspace;

  const handleBrowseWorkspace = async () => {
    try {
      const result = (await window.electron?.ipcRenderer.invoke(
        "dialog:openDirectory",
      )) as { canceled?: boolean; filePaths?: string[] } | undefined;
      if (result && !result.canceled && result.filePaths?.[0]) {
        pushRecentWorkspace(result.filePaths[0]);
        await handleWorkspaceSelect(result.filePaths[0]);
      }
    } catch (error) {
      console.error("Failed to open folder picker:", error);
    }
  };

  const handleWorkspaceSelect = async (folderPath: string) => {
    pushRecentWorkspace(folderPath);
    await openWorkspaceFolder({
      folderPath,
      navigate: (opts) => navigate(opts),
      refreshApps,
    });
  };

  const handleOpenInNewWindow = async () => {
    if (!activeWorkspacePath) return;
    try {
      await IpcClient.getInstance().openWorkspaceInNewWindow(activeWorkspacePath);
    } catch (error) {
      console.error("Failed to open workspace in new window:", error);
    }
  };

  return (
    <>
      <SidebarGroup
        className="flex min-h-0 flex-1 flex-col overflow-y-auto h-[calc(100vh-112px)]"
        data-testid="app-list-container"
      >
        <SidebarGroupLabel className="flex items-center justify-between group/header">
          <span className="truncate pr-1" title={activeWorkspaceLabel}>
            {activeWorkspaceLabel}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            <LocalDateTimeClock variant="compact" tickMs={1000} />
            {selectedAppId != null && activeWorkspacePath ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                title="Open this workspace in a new window"
                onClick={() => void handleOpenInNewWindow()}
              >
                <AppWindow className="h-4 w-4" />
              </Button>
            ) : null}
            {/* Only when browsing all workspaces (no folder open) */}
            {isAuthenticated && selectedAppId == null && (
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
            {/* Add workspace only when browsing the list (not while a folder is open) */}
            {selectedAppId == null && canAddWorkspace && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                title="Add workspace (browse folder)"
                onClick={() => void handleBrowseWorkspace()}
              >
                <Plus className="h-4 w-4" />
              </Button>
            )}
            {/* Show disabled + button with tooltip for Free tier users at limit */}
            {selectedAppId == null &&
              isAuthenticated &&
              status?.plan === "free" &&
              apps.length >= 1 && (
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
            ) : visibleWorkspaces.length === 0 ? (
              <div className="py-2 px-4 text-sm text-muted-foreground">
                {selectedAppId != null ? "Loading workspace…" : "No workspaces"}
              </div>
            ) : (
              <SidebarMenu className="space-y-0.5" data-testid="app-list">
                {visibleWorkspaces.map((ws) => {
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

                    {/* Sessions — when expanded (files live in the right-panel Code tab) */}
                    {ws.isExpanded && !isMissing && (
                      <div className="pl-6 pr-2 pt-1">
                        <div className="text-[10px] font-medium text-muted-foreground px-1 mb-1">
                          Sessions
                        </div>
                        <div data-onboarding="workspace-sessions">
                          <WorkspaceSessionList
                            workspaceId={ws.id}
                            activeSessionId={
                              selectedAppId === ws.id
                                ? activeWorkspaceSessionId
                                : null
                            }
                          />
                        </div>
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

          </div>
        </SidebarGroupContent>
      </SidebarGroup>

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
