import { useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { FolderOpen, GitBranch, Settings, Trash2 } from "lucide-react";
import { DISCORD_INVITE_URL } from "@/lib/community/discord";
import { IpcClient } from "@/ipc/ipc_client";
import { PlanLimitError } from "@/lib/plan-limit-error";
import { showError } from "@/lib/toast";
import AtlarixAnimation from "@/components/atlarix/AtlarixAnimation";
import { AtlarixSignInHero } from "@/components/atlarix/AtlarixSignInHero";
import { useAuth } from "@/lib/auth/useAuth";
import { useLoadApps } from "@/hooks/useLoadApps";
import { formatCompassSubscriptionTier } from "@/shared/compass_product_copy";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { WelcomeCloneDialog } from "@/components/welcome/WelcomeCloneDialog";
import {
  openWorkspaceFromDirectoryPicker,
  openWorkspaceFolder,
} from "@/lib/open-workspace-session";
import { cn } from "@/lib/utils";
import { LocalDateTimeClock } from "@/components/LocalDateTimeClock";

const RECENT_PREVIEW = 8;

export default function WelcomeLauncher() {
  const navigate = useNavigate();
  const { user, status, isAuthenticated, signInWithGoogle } = useAuth();
  const { apps, refreshApps } = useLoadApps();
  const [cloneOpen, setCloneOpen] = useState(false);
  const [showAllRecents, setShowAllRecents] = useState(false);

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

  const visibleRecents = showAllRecents
    ? recentApps
    : recentApps.slice(0, RECENT_PREVIEW);

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center gap-4">
        <LocalDateTimeClock variant="welcome" className="mb-2" />
        <AtlarixSignInHero
          size="md"
          onSignIn={() => void signInWithGoogle()}
        />
        <p className="text-muted-foreground">Sign in to open a workspace.</p>
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

  const handleDeleteWorkspace = async (
    appId: number,
    name: string,
    appPath?: string | null,
  ) => {
    const managedHint =
      appPath &&
      (appPath.includes("atlarix-apps") ||
        appPath.includes(`${"/Documents/"}Atlarix`))
        ? ` Files at ${appPath} will also be deleted.`
        : " Project files on disk are kept unless they live under ~/atlarix-apps or ~/Documents/Atlarix.";
    if (
      !window.confirm(
        `Remove “${name}” from Atlarix?${managedHint}`,
      )
    ) {
      return;
    }
    try {
      await IpcClient.getInstance().deleteApp(appId);
      await refreshApps();
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
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
        <Link
          to="/settings"
          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <Settings className="h-3 w-3" />
          Settings & account
        </Link>
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
          <h2 className="text-sm font-medium text-muted-foreground mb-2">
            Recent workspaces
          </h2>
          <ul className="border rounded-lg divide-y max-h-64 overflow-y-auto">
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
                    void handleDeleteWorkspace(app.id, app.name, app.path)
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
          {recentApps.length > RECENT_PREVIEW ? (
            <button
              type="button"
              className="text-xs text-primary mt-2 hover:underline"
              onClick={() => setShowAllRecents((v) => !v)}
            >
              {showAllRecents ? "Show less" : "View all"}
            </button>
          ) : null}
        </section>
      ) : null}

      <WelcomeCloneDialog open={cloneOpen} onOpenChange={setCloneOpen} />
    </div>
  );
}
