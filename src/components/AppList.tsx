import { useNavigate } from "@tanstack/react-router";
import {
  Folder,
  FolderOpen,
  MessageSquare,
  MoreHorizontal,
  Search,
  Trash2,
  EyeOff,
} from "lucide-react";
import { useAtom, useSetAtom } from "jotai";
import { selectedAppIdAtom, selectedWorkspaceInfoAtom } from "@/atoms/appAtoms";
import { appSearchOpenAtom } from "@/atoms/appAtoms";
import { startNewWorkspaceConversation } from "@/lib/open-workspace-session";
import { activeWorkspaceSessionIdAtom } from "@/atoms/sessionAtoms";
import { WorkspaceSessionList } from "@/components/workspace/WorkspaceSessionList";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { activeChatIdAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";
import { useLoadApps } from "@/hooks/useLoadApps";
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { clearDeletedWorkspaceClientState } from "@/lib/workspace-delete-cleanup";
import { Badge } from "@/components/ui/badge";
import { IpcClient } from "@/ipc/ipc_client";
import { useAuth } from "@/lib/auth/useAuth";
import { SHORTCUTS, formatCombo, isMacPlatform } from "@/lib/shortcuts";
import { removalAlsoDeletesFiles } from "@/pages/welcome-launcher";

interface WorkspaceWithChats {
  id: number;
  name: string;
  path: string;
  chats: { id: number; title: string | null; createdAt: Date }[];
  /** active = folder on disk; missing = path absent */
  workspaceStatus?: "active" | "missing";
}

/** The advertised chord for workspace search, read from the table it is dispatched from. */
function appSearchChord(): string | undefined {
  const row = SHORTCUTS.find((s) => s.id === "app-search");
  return row ? formatCombo(row.combo, isMacPlatform()) : undefined;
}

/**
 * The workspace `⋯` — the rare actions, off the header's critical path.
 *
 * NO "SWITCH WORKSPACE" HERE, deliberately. A new window opens an unbound
 * window that lands on the chooser (`window:open-blank`), and that is the
 * designed way to work on a second project: one workspace per window, so a
 * command cannot run against the folder you were not looking at.
 *
 * Remove routes to the launcher's own dialog copy rather than a bare
 * `confirm()`. The sidebar used to claim removal only "removes it from
 * Atlarix", which is untrue for a workspace inside Atlarix's own apps
 * directory — `removalAlsoDeletesFiles` is the predicate that tells them
 * apart, and the launcher has honoured it since it was written.
 */
function WorkspaceOverflowMenu({
  name,
  path,
  onRemove,
}: {
  name: string;
  path: string;
  onRemove: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const alsoDeletesFiles = removalAlsoDeletesFiles(path);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 shrink-0 p-0"
            aria-label="Workspace options"
            data-testid="workspace-overflow"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            disabled={!path}
            onClick={() => {
              if (path) void IpcClient.getInstance().showItemInFolder(path);
            }}
          >
            <FolderOpen className="mr-2 h-4 w-4" />
            Reveal in file manager
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {alsoDeletesFiles ? "Delete workspace…" : "Remove workspace…"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {alsoDeletesFiles
                ? `Delete “${name}” and its files?`
                : `Remove “${name}” from Atlarix?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {alsoDeletesFiles
                ? "This workspace lives inside Atlarix, so removing it deletes the folder and everything in it. This cannot be undone."
                : "Atlarix forgets this workspace and its sessions. The folder on disk is left exactly as it is."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                onRemove();
              }}
            >
              {alsoDeletesFiles ? "Delete files" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * The workspace panel.
 *
 * IT ALWAYS SHOWS EXACTLY ONE WORKSPACE. `AppSidebar` mounts only when
 * `selectedAppId != null` (`app/layout.tsx:306,484`), so every branch this file
 * used to carry for "browsing all workspaces with none open" — a delete-ALL
 * button, an add-workspace `+`, a "No workspaces" empty state, a "Workspaces"
 * fallback title — was unreachable code describing a screen that cannot occur.
 * They are gone. Adding and switching workspaces happen on the welcome
 * launcher, which is where a list of workspaces actually exists.
 */
export function AppList({ show }: { show?: boolean }) {
  const navigate = useNavigate();
  const [selectedAppId, setSelectedAppId] = useAtom(selectedAppIdAtom);
  const setSelectedWorkspaceInfo = useSetAtom(selectedWorkspaceInfoAtom);
  const [, setSelectedChatId] = useAtom(selectedChatIdAtom);
  const { apps, loading, error, refreshApps } = useLoadApps();
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();

  const [workspaces, setWorkspaces] = useState<WorkspaceWithChats[]>([]);
  const setSearchOpen = useSetAtom(appSearchOpenAtom);
  const setActiveChatId = useSetAtom(activeChatIdAtom);
  const [activeWorkspaceSessionId] = useAtom(activeWorkspaceSessionIdAtom);

  // Load chats for each workspace
  useEffect(() => {
    if (!apps || apps.length === 0) return;

    const loadChats = async () => {
      const workspacesWithChats = await Promise.all(
        apps.map(async (app) => {
          try {
            const sessions =
              await IpcClient.getInstance().listWorkspaceSessions(app.id);
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
              path: app.path || "",
              chats: chats.slice(0, 10),
              workspaceStatus,
            };
          } catch {
            return {
              id: app.id,
              name: app.name,
              path: app.path || "",
              chats: [],
              workspaceStatus:
                app.status ?? (app.pathExists === false ? "missing" : "active"),
            };
          }
        }),
      );
      setWorkspaces(workspacesWithChats);
    };

    loadChats();
  }, [apps, selectedAppId]);

  /** The one open workspace. `undefined` only while its row is still loading. */
  const openWorkspace = useMemo(
    () => workspaces.find((w) => w.id === selectedAppId),
    [workspaces, selectedAppId],
  );

  const workspaceLabel = openWorkspace?.name ?? "Workspace";
  const sessionCount = openWorkspace?.chats.length ?? 0;
  const chord = appSearchChord();

  if (!show) {
    return null;
  }

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

  const removeWorkspace = async (workspaceId: number) => {
    clearDeletedWorkspaceClientState(workspaceId, queryClient);
    setWorkspaces((prev) => prev.filter((w) => w.id !== workspaceId));
    if (selectedAppId === workspaceId) {
      // Removing the workspace you are inside leaves nowhere to be: drop the
      // selection so the layout falls back to the welcome launcher.
      setSelectedAppId(null);
      setSelectedWorkspaceInfo(null);
      setActiveChatId(null);
      setSelectedChatId(null);
      navigate({ to: "/" });
    }
    try {
      await IpcClient.getInstance().deleteApp(workspaceId);
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
  };

  const isMissing = openWorkspace?.workspaceStatus === "missing";

  return (
    <SidebarGroup
      className="flex min-h-0 flex-1 flex-col overflow-y-auto h-[calc(100vh-112px)]"
      data-testid="app-list-container"
    >
      {/*
        THE WORKSPACE IDENTITY BAR — a header, not a row in a list.

        It was dressed as a tree row: a disclosure chevron that could only hide
        the panel's only content, a count badge, a `+` duplicating the "New
        conversation" button 200px below it, and a destructive delete one pixel
        from that `+`. All four are gone, and dropping them is what gives the
        name room — at 240px wide with six controls beside it, "wisdom-drop"
        truncated to "wisdom-dr…" at ELEVEN characters.

        Not `SidebarGroupLabel`: that is hard-coded `h-8` (`ui/sidebar.tsx:384`)
        and this bar is two lines. Nothing queries `data-sidebar="group-label"`.
      */}
      <div className="flex items-start gap-2 border-b border-border/60 px-2 pb-2.5 pt-1">
        <Folder
          className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" title={workspaceLabel}>
            {workspaceLabel}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {isMissing ? (
              <Badge
                variant="outline"
                className="h-4 text-[10px] text-muted-foreground"
              >
                Folder not found
              </Badge>
            ) : (
              `${sessionCount} session${sessionCount === 1 ? "" : "s"}`
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 shrink-0 p-0"
          title={chord ? `Search workspaces (${chord})` : "Search workspaces"}
          aria-label="Search workspaces"
          data-testid="search-apps-button"
          onClick={() => setSearchOpen(true)}
        >
          <Search className="h-3.5 w-3.5" />
        </Button>
        {openWorkspace && (
          <WorkspaceOverflowMenu
            name={openWorkspace.name}
            path={openWorkspace.path}
            onRemove={() => void removeWorkspace(openWorkspace.id)}
          />
        )}
      </div>

      <SidebarGroupContent className="min-h-0">
        <div className="flex min-h-0 flex-col pt-2">
          {!isAuthenticated ? (
            <div className="px-4 py-3 text-center text-sm text-muted-foreground">
              <EyeOff className="mx-auto mb-2 h-5 w-5 opacity-50" />
              <p>Login to access workspaces</p>
            </div>
          ) : error ? (
            <div className="px-4 py-2 text-sm text-destructive">
              Error loading apps
            </div>
          ) : !openWorkspace ? (
            <div className="px-4 py-2 text-sm text-muted-foreground">
              {loading ? "Loading…" : "Loading workspace…"}
            </div>
          ) : isMissing ? (
            <div className="space-y-2 px-2 py-2">
              <p className="text-xs text-muted-foreground">
                This folder is no longer on disk, so its sessions cannot be
                opened.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 w-full text-xs"
                onClick={() => void removeWorkspace(openWorkspace.id)}
              >
                Remove from Atlarix
              </Button>
            </div>
          ) : (
            <SidebarMenu className="space-y-0.5" data-testid="app-list">
              <div className="px-2">
                <div className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Sessions
                </div>
                <div data-onboarding="workspace-sessions">
                  <WorkspaceSessionList
                    workspaceId={openWorkspace.id}
                    activeSessionId={activeWorkspaceSessionId}
                  />
                </div>
                {/*
                  ONE "new conversation" control. The header used to carry a `+`
                  doing exactly this, 200px above the button that says so in
                  words — `handleNewChatInWorkspace` was a bare alias of this
                  same handler.
                */}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-2 h-8 w-full justify-start text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleNewConversationInWorkspace(openWorkspace.id);
                  }}
                >
                  <MessageSquare className="mr-2 h-3.5 w-3.5" />
                  New conversation
                </Button>
              </div>
            </SidebarMenu>
          )}
        </div>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
