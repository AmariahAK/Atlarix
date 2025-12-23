import { useNavigate } from "@tanstack/react-router";
import { PlusCircle, Search, FolderOpen, Plus } from "lucide-react";
import { useAtom, useSetAtom } from "jotai";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { selectedChatIdAtom } from "@/atoms/chatAtoms";
import { useLoadApps } from "@/hooks/useLoadApps";
import { useMemo, useState } from "react";
import { AppSearchDialog } from "./AppSearchDialog";
import { useAddAppToFavorite } from "@/hooks/useAddAppToFavorite";
import { AppItem } from "./appItem";
import { WorkspaceSelector } from "@/components/workspace/WorkspaceSelector";

export function AppList({ show }: { show?: boolean }) {
  const navigate = useNavigate();
  const [selectedAppId, setSelectedAppId] = useAtom(selectedAppIdAtom);
  const setSelectedChatId = useSetAtom(selectedChatIdAtom);
  const { apps, loading, error } = useLoadApps();
  const { toggleFavorite, isLoading: isFavoriteLoading } =
    useAddAppToFavorite();
  // search dialog state
  const [isSearchDialogOpen, setIsSearchDialogOpen] = useState(false);

  // Workspace state
  const [currentWorkspace, setCurrentWorkspace] = useState<string>("");
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);

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

  const favoriteApps = useMemo(
    () => apps.filter((app) => app.isFavorite),
    [apps],
  );

  const nonFavoriteApps = useMemo(
    () => apps.filter((app) => !app.isFavorite),
    [apps],
  );

  if (!show) {
    return null;
  }

  const handleAppClick = (id: number) => {
    setSelectedAppId(id);
    setSelectedChatId(null);
    setIsSearchDialogOpen(false);
    navigate({
      to: "/",
      search: { appId: id },
    });
  };

  const handleNewApp = () => {
    // Open workspace picker
    setShowWorkspacePicker(true);
  };

  const handleWorkspaceSelect = (path: string) => {
    setCurrentWorkspace(path);
    setShowWorkspacePicker(false);
    // TODO: Create new app with this workspace
    // For now, just navigate to home
    navigate({ to: "/" });
  };

  const handleToggleFavorite = (appId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    toggleFavorite(appId);
  };

  return (
    <>
      <SidebarGroup
        className="overflow-y-auto h-[calc(100vh-112px)]"
        data-testid="app-list-container"
      >
        <SidebarGroupLabel>Workspaces</SidebarGroupLabel>
        <SidebarGroupContent>
          <div className="flex flex-col space-y-2">
            {/* Workspace Picker - Integrated */}
            <div className="px-2 pb-3 border-b">
              {/* Workspace Selector - Always rendered as dialog */}
              <WorkspaceSelector
                isOpen={showWorkspacePicker}
                onClose={() => setShowWorkspacePicker(false)}
                onWorkspaceSelect={handleWorkspaceSelect}
                currentWorkspace={currentWorkspace}
              />

              {/* New Workspace Button - Always visible */}
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
                onClick={handleNewApp}
              >
                <Plus className="h-4 w-4" />
                <span>New Workspace</span>
              </Button>

              {/* Current Workspace Display */}
              {currentWorkspace && (
                <div
                  className="flex items-start gap-2 p-2 rounded-md bg-muted text-sm cursor-pointer hover:bg-muted/80"
                  onClick={() => setShowWorkspacePicker(true)}
                >
                  <FolderOpen className="h-4 w-4 mt-0.5 text-primary" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">
                      {currentWorkspace.split('/').pop() || 'Workspace'}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {currentWorkspace}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Search Apps */}
            <Button
              onClick={() => setIsSearchDialogOpen(!isSearchDialogOpen)}
              variant="outline"
              className="flex items-center justify-start gap-2 mx-2 py-3"
              data-testid="search-apps-button"
            >
              <Search size={16} />
              <span>Search Apps</span>
            </Button>

            {/* Apps List */}
            {loading ? (
              <div className="py-2 px-4 text-sm text-gray-500">
                Loading apps...
              </div>
            ) : error ? (
              <div className="py-2 px-4 text-sm text-red-500">
                Error loading apps
              </div>
            ) : apps.length === 0 ? (
              <div className="py-2 px-4 text-sm text-gray-500">
                No apps found
              </div>
            ) : (
              <SidebarMenu className="space-y-1" data-testid="app-list">
                <SidebarGroupLabel>Favorite apps</SidebarGroupLabel>
                {favoriteApps.map((app) => (
                  <AppItem
                    key={app.id}
                    app={app}
                    handleAppClick={handleAppClick}
                    selectedAppId={selectedAppId}
                    handleToggleFavorite={handleToggleFavorite}
                    isFavoriteLoading={isFavoriteLoading}
                  />
                ))}
                <SidebarGroupLabel>Other apps</SidebarGroupLabel>
                {nonFavoriteApps.map((app) => (
                  <AppItem
                    key={app.id}
                    app={app}
                    handleAppClick={handleAppClick}
                    selectedAppId={selectedAppId}
                    handleToggleFavorite={handleToggleFavorite}
                    isFavoriteLoading={isFavoriteLoading}
                  />
                ))}
              </SidebarMenu>
            )}
          </div>
        </SidebarGroupContent>
      </SidebarGroup>
      <AppSearchDialog
        open={isSearchDialogOpen}
        onOpenChange={setIsSearchDialogOpen}
        onSelectApp={handleAppClick}
        allApps={allApps}
      />
    </>
  );
}
