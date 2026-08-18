import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { FolderOpen, GitBranch, LogOut, Search, Settings, Trash2 } from "lucide-react";
import { DISCORD_INVITE_URL } from "@/lib/community/discord";
import { IpcClient } from "@/ipc/ipc_client";
import { PlanLimitError } from "@/lib/plan-limit-error";
import { showError } from "@/lib/toast";
import AtlarixAnimation from "@/components/atlarix/AtlarixAnimation";
import { OAuthSignInButtons } from "@/components/auth/OAuthSignInButtons";
import { useAuth } from "@/lib/auth/useAuth";
import { useLoadApps } from "@/hooks/useLoadApps";
import { formatCompassSubscriptionTier } from "@/shared/compass_product_copy";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { WelcomeCloneDialog } from "@/components/welcome/WelcomeCloneDialog";
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
import {
  openWorkspaceFromDirectoryPicker,
  openWorkspaceFolder,
} from "@/lib/open-workspace-session";
import { cn } from "@/lib/utils";
import { LocalDateTimeClock } from "@/components/LocalDateTimeClock";

/** Past this many workspaces the list gains search + scroll instead of a toggle. */
const RECENT_SEARCH_THRESHOLD = 5;

/**
 * Does removing this workspace also DELETE its folder?
 *
 * Only for the Atlarix-managed clone roots — `delete-app` rm -rf's the folder for
 * those and leaves every other path alone (`isAtlarixManagedWorkspacePath`, which
 * lives in main because it needs the home directory).
 *
 * Matched on path SEGMENTS with either separator: the previous check was
 * `includes("/Documents/Atlarix")`, which can never match a Windows path, so a
 * managed workspace there was described as safe and then had its files deleted.
 * Over-matching is the safe direction — it shows the stronger confirmation for a
 * folder that merely happens to be named this, which costs a sentence.
 */
export function removalAlsoDeletesFiles(appPath?: string | null): boolean {
  if (!appPath) return false;
  const segs = appPath.split(/[\\/]+/).filter(Boolean);
  const has = (...want: string[]) =>
    want.every((w) => segs.some((seg) => seg.toLowerCase() === w));
  return has("atlarix-apps") || has("documents", "atlarix");
}

export default function WelcomeLauncher() {
  const navigate = useNavigate();
  const { user, status, isAuthenticated, authResolved, signOut } = useAuth();
  const { apps, refreshApps } = useLoadApps();
  const [cloneOpen, setCloneOpen] = useState(false);
  const [recentQuery, setRecentQuery] = useState("");
  /** Restore has been pending long enough to say so. */
  const [restoreSlow, setRestoreSlow] = useState(false);
  /**
   * Workspace awaiting a remove confirmation.
   *
   * An in-app dialog rather than `window.confirm`: the native one renders as an
   * OS-chrome modal that reads as an alarming system warning (particularly on
   * Windows) for what is usually just taking a row off a list — and it blocks the
   * renderer while it is open.
   */
  const [pendingRemoval, setPendingRemoval] = useState<{
    id: number;
    name: string;
    path?: string | null;
  } | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (authResolved) return;
    const id = window.setTimeout(() => setRestoreSlow(true), 5_000);
    return () => window.clearTimeout(id);
  }, [authResolved]);

  const displayName =
    user?.name?.trim() ||
    user?.email?.split("@")[0]?.trim() ||
    "there";

  const tierLabel = formatCompassSubscriptionTier(
    status?.plan ?? "free",
  );

  const recentApps = useMemo(() => {
    return [...apps]
      .sort((a, b) => {
        const ta = a.lastOpenedAt ? new Date(a.lastOpenedAt).getTime() : 0;
        const tb = b.lastOpenedAt ? new Date(b.lastOpenedAt).getTime() : 0;
        if (tb !== ta) return tb - ta;
        return (
          new Date(b.updatedAt ?? 0).getTime() -
          new Date(a.updatedAt ?? 0).getTime()
        );
      })
      .filter((a) => a.path);
  }, [apps]);

  /**
   * Search appears only once the list stops being scannable. Below the
   * threshold every workspace is already on screen, so a search box would be
   * pure chrome; above it, scrolling alone means hunting.
   */
  const isSearchable = recentApps.length > RECENT_SEARCH_THRESHOLD;

  const visibleRecents = useMemo(() => {
    const q = recentQuery.trim().toLowerCase();
    if (!isSearchable || !q) return recentApps;
    // Match on path as well as name: sibling checkouts of the same repo differ
    // only by directory, which is exactly when search is needed most.
    return recentApps.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.path ?? "").toLowerCase().includes(q),
    );
  }, [recentApps, recentQuery, isSearchable]);

  // Auth not known yet — main's session restore is deferred so the window can
  // open instantly even on a network that would otherwise hang it for minutes.
  // Until it settles, `!isAuthenticated` means "no answer", not "signed out";
  // showing the sign-in screen here is what made a signed-in user watch their
  // app log them out and then back in on every launch.
  if (!authResolved && !isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center gap-4">
        <LocalDateTimeClock variant="welcome" className="mb-2" />
        <AtlarixAnimation size="sm" phase="thinking" minimalChrome theme="auto" className="shadow-sm" />
        <p className="text-muted-foreground">Restoring your session…</p>
        {/*
          A spinner with no text and no affordance is why a stuck restore went
          unreported: the user could not tell a slow launch from a broken one,
          and had nothing to do either way. `useAuth` now guarantees this screen
          resolves on its own, so this is reassurance plus an early way out —
          not the recovery mechanism.
        */}
        {restoreSlow && (
          <div className="flex flex-col items-center gap-3">
            <p className="text-xs text-muted-foreground/70 max-w-xs">
              Taking longer than usual — still checking with the server.
            </p>
            <Button asChild variant="ghost" size="sm">
              <Link to="/sign-in">Sign in instead</Link>
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center gap-4">
        <LocalDateTimeClock variant="welcome" className="mb-2" />
        <AtlarixAnimation size="sm" phase="done" minimalChrome theme="auto" className="shadow-sm" />
        <p className="text-muted-foreground">Sign in to open a workspace.</p>
        <div className="w-full max-w-xs">
          <OAuthSignInButtons size="md" />
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/sign-in">More about sign in</Link>
        </Button>
      </div>
    );
  }

  const ensureCanAddWorkspace = async (): Promise<boolean> => {
    const ipcRenderer = window.electron?.ipcRenderer;
    if (!ipcRenderer?.invoke) return true;
    const limitCheck = (await ipcRenderer.invoke("auth:check-workspace-limit")) as {
      allowed?: boolean;
      reason?: string;
    };
    if (limitCheck.allowed !== false) return true;
    const { triggerUpgrade } = await import("@/hooks/useUpgrade");
    void triggerUpgrade();
    showError(limitCheck.reason ?? "Free plan allows one workspace.");
    return false;
  };

  const confirmRemove = async () => {
    if (!pendingRemoval) return;
    const { id } = pendingRemoval;
    setRemoving(true);
    try {
      await IpcClient.getInstance().deleteApp(id);
      await refreshApps();
      setPendingRemoval(null);
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="relative flex flex-col items-center w-full max-w-4xl mx-auto px-6 sm:px-10 py-10 gap-8">
      <a
        href={DISCORD_INVITE_URL}
        target="_blank"
        rel="noreferrer"
        className="absolute top-4 right-4 text-foreground hover:opacity-80"
        title="Join Discord"
        onClick={(e) => {
          e.preventDefault();
          void IpcClient.getInstance().openExternalUrl(DISCORD_INVITE_URL);
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037 12.3 12.3 0 0 0-.608 1.25 18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
        </svg>
      </a>
      <header className="flex flex-col items-center gap-3 w-full">
        <LocalDateTimeClock variant="welcome" className="mb-1" />
        <AtlarixAnimation size="sm" phase="done" minimalChrome theme="auto" className="shadow-sm" />
        <div className="flex flex-wrap items-center justify-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">
            Hello, {displayName}
          </h1>
          <Badge variant="secondary" className="font-normal">
            {tierLabel}
          </Badge>
        </div>
        <div className="flex items-center gap-3">
          <Link
            to="/settings"
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <Settings className="h-3 w-3" />
            Settings & account
          </Link>
          <button
            type="button"
            onClick={() => void signOut()}
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <LogOut className="h-3 w-3" />
            Sign out
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-xl">
        <Button
          variant="outline"
          className="h-auto py-4 flex flex-col gap-2"
          data-onboarding="welcome-open-folder"
          onClick={() =>
            void (async () => {
              if (!(await ensureCanAddWorkspace())) return;
              try {
                await openWorkspaceFromDirectoryPicker({
                  navigate: (opts) => navigate(opts),
                  refreshApps,
                });
              } catch (e) {
                if (!(e instanceof PlanLimitError)) {
                  showError(e instanceof Error ? e.message : String(e));
                }
              }
            })()
          }
        >
          <FolderOpen className="h-5 w-5" />
          <span>Open folder</span>
        </Button>
        <Button
          variant="outline"
          className="h-auto py-4 flex flex-col gap-2"
          onClick={() =>
            void (async () => {
              if (!(await ensureCanAddWorkspace())) return;
              setCloneOpen(true);
            })()
          }
        >
          <GitBranch className="h-5 w-5" />
          <span>Clone repo</span>
        </Button>
      </div>

      {recentApps.length > 0 ? (
        <section className="w-full">
          <div className="flex items-center gap-3 mb-2">
            <h2 className="text-sm font-medium text-muted-foreground">
              Recent workspaces
            </h2>
            {isSearchable ? (
              <span className="text-xs text-muted-foreground">
                {recentQuery.trim()
                  ? `${visibleRecents.length} of ${recentApps.length}`
                  : recentApps.length}
              </span>
            ) : null}
          </div>
          {/* Past a handful of projects, scanning the list stops working and a
              "View all" toggle just makes it longer. Search + scroll replaces
              both — and stays out of the way entirely below the threshold, where
              the whole list is already visible. */}
          {isSearchable ? (
            <div className="relative mb-2">
              <Search
                className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground"
                aria-hidden
              />
              <input
                type="text"
                value={recentQuery}
                onChange={(e) => setRecentQuery(e.target.value)}
                placeholder="Search workspaces by name or path…"
                aria-label="Search recent workspaces"
                className="w-full rounded-md border border-border bg-background/60 pl-8 pr-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          ) : null}
          <ul className="border rounded-lg divide-y max-h-64 overflow-y-auto">
            {visibleRecents.length === 0 ? (
              <li className="px-4 py-6 text-center text-xs text-muted-foreground">
                No workspace matches “{recentQuery.trim()}”.
              </li>
            ) : null}
            {visibleRecents.map((app) => (
              <li key={app.id} className="flex items-stretch">
                <button
                  type="button"
                  className={cn(
                    "flex-1 flex items-center justify-between gap-4 px-4 py-3 text-left min-w-0",
                    "hover:bg-accent/50 transition-colors",
                  )}
                  onClick={() =>
                    void openWorkspaceFolder({
                      folderPath: app.path!,
                      appName: app.name,
                      navigate: (opts) => navigate(opts),
                      refreshApps,
                    })
                  }
                >
                  <span className="font-medium truncate">{app.name}</span>
                  <span className="text-xs text-muted-foreground truncate max-w-[50%]">
                    {app.path}
                  </span>
                </button>
                <button
                  type="button"
                  className="px-3 text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
                  title="Remove workspace"
                  onClick={() =>
                    setPendingRemoval({
                      id: app.id,
                      name: app.name,
                      path: app.path,
                    })
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <WelcomeCloneDialog open={cloneOpen} onOpenChange={setCloneOpen} />

      {/*
        Removing a workspace is two very different actions wearing one icon, and
        the old copy hedged across both — every removal warned about deletion
        conditions, so taking a project off the list read as though it might erase
        your code. Say only what this particular removal does.
      */}
      <AlertDialog
        open={pendingRemoval != null}
        onOpenChange={(open) => {
          if (!open && !removing) setPendingRemoval(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingRemoval && removalAlsoDeletesFiles(pendingRemoval.path)
                ? `Delete “${pendingRemoval.name}” and its files?`
                : `Remove “${pendingRemoval?.name}” from Atlarix?`}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                {pendingRemoval && removalAlsoDeletesFiles(pendingRemoval.path) ? (
                  <>
                    <p>
                      This workspace lives in a folder Atlarix created, so its
                      files are deleted along with it.
                    </p>
                    <pre className="overflow-auto rounded border border-border bg-muted/40 p-2 font-mono text-xs">
                      {pendingRemoval.path}
                    </pre>
                    <p className="text-amber-600 dark:text-amber-500">
                      This cannot be undone.
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      It comes off this list along with its saved chat sessions.
                    </p>
                    <p className="text-muted-foreground">
                      Nothing on disk changes — your project stays exactly where
                      it is, and you can open the folder again any time.
                    </p>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={removing}
              onClick={(e) => {
                // Keep the dialog up while the removal runs, so a failure can be
                // reported rather than vanishing with the dialog.
                e.preventDefault();
                void confirmRemove();
              }}
            >
              {removing
                ? "Removing…"
                : pendingRemoval && removalAlsoDeletesFiles(pendingRemoval.path)
                  ? "Delete files"
                  : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
