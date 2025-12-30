import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Plus, Folder, MessageSquare, Search, EyeOff, FolderOpen } from "lucide-react";
import { useAtom, useSetAtom } from "jotai";
import { selectedAppIdAtom, selectedWorkspaceInfoAtom } from "@/atoms/appAtoms";
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

interface WorkspaceWithChats {
  id: number;
  name: string;
  path: string;
  chats: { id: number; title: string | null; createdAt: Date }[];
  isExpanded: boolean;
}

export function AppList({ show }: { show?: boolean }) {
  const navigate = useNavigate();
  const [selectedAppId, setSelectedAppId] = useAtom(selectedAppIdAtom);
  const setSelectedWorkspaceInfo = useSetAtom(selectedWorkspaceInfoAtom);
  const [selectedChatId, setSelectedChatId] = useAtom(selectedChatIdAtom);
  const { apps, loading, error, refreshApps } = useLoadApps();

  // Workspaces with nested chats
  const [workspaces, setWorkspaces] = useState<WorkspaceWithChats[]>([]);
  const [isSearchDialogOpen, setIsSearchDialogOpen] = useState(false);
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);

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
              chats: chats.slice(0, 10), // Limit to 10 most recent
              isExpanded: app.id === selectedAppId,
            };
          } catch {
            return {
              id: app.id,
              name: app.name,
              path: app.path || '',
              chats: [],
              isExpanded: false,
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
      // Refresh workspaces to show new chat
      refreshApps?.();
    } catch (error) {
      console.error('Failed to create chat:', error);
    }
  };

  const handleWorkspaceSelect = async (path: string) => {
    setShowWorkspacePicker(false);

    const existingApp = apps.find(app => app.path === path);

    if (existingApp) {
      setSelectedAppId(existingApp.id);
      setSelectedWorkspaceInfo({ id: existingApp.id, name: existingApp.name });
      // Expand the workspace
      setWorkspaces(prev => prev.map(w =>
        w.id === existingApp.id ? { ...w, isExpanded: true } : w
      ));
    } else {
      try {
        const appName = path.split('/').pop() || 'Workspace';
        const result = await IpcClient.getInstance().importApp({ path, appName });
        setSelectedAppId(result.appId);
        setSelectedWorkspaceInfo({ id: result.appId, name: appName });
        refreshApps?.();
      } catch (error) {
        console.error('Failed to create workspace:', error);
      }
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
        <SidebarGroupLabel className="flex items-center justify-between">
          <span>Workspaces</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => setShowWorkspacePicker(true)}
          >
            <Plus className="h-4 w-4" />
          </Button>
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
            {loading ? (
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
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleNewChatInWorkspace(ws.id);
                        }}
                        className={`p-1 hover:bg-emerald-500/20 rounded transition-opacity ${selectedAppId === ws.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                          }`}
                        title="New chat in workspace"
                      >
                        <Plus className="h-3.5 w-3.5 text-emerald-500" />
                      </button>
                    </div>

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
