import { useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { FolderOpen, GitBranch, Settings } from "lucide-react";
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
    status?.plan ?? status?.effectiveTier ?? "free",
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

  return (
    <div className="flex flex-col items-center w-full max-w-2xl mx-auto px-6 py-10 gap-8">
      <header className="flex flex-col items-center gap-3 w-full">
        <LocalDateTimeClock variant="welcome" className="mb-1" />
        <AtlarixAnimation size="sm" phase="done" minimalChrome className="shadow-sm" />
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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-md">
        <Button
          variant="outline"
          className="h-auto py-4 flex flex-col gap-2"
          data-onboarding="welcome-open-folder"
          onClick={() =>
            void openWorkspaceFromDirectoryPicker({
              navigate: (opts) => navigate(opts),
              refreshApps,
            })
          }
        >
          <FolderOpen className="h-5 w-5" />
          <span>Open folder</span>
        </Button>
        <Button
          variant="outline"
          className="h-auto py-4 flex flex-col gap-2"
          onClick={() => setCloneOpen(true)}
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
          <ul className="border rounded-lg divide-y">
            {visibleRecents.map((app) => (
              <li key={app.id}>
                <button
                  type="button"
                  className={cn(
                    "w-full flex items-center justify-between gap-4 px-4 py-3 text-left",
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
