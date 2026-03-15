/**
 * GitHub Actions panel wrapper for the left panel.
 * Resolves workspace path from currentApp and shows upgrade CTA when not Pro.
 */

import { useAtomValue } from "jotai";
import { currentAppAtom } from "@/atoms/appAtoms";
import { useAuth } from "@/lib/auth/useAuth";
import { GitHubActionsPanel } from "@/components/panels/GitHubActionsPanel";
import { Button } from "@/components/ui/button";
import { GitBranch } from "lucide-react";

export interface GitHubActionsPanelWrapperProps {
  workspaceId: number | null;
}

export function GitHubActionsPanelWrapper({ workspaceId }: GitHubActionsPanelWrapperProps) {
  const currentApp = useAtomValue(currentAppAtom);
  const { status, isAuthenticated } = useAuth();

  const isPro = status?.plan === "pro";
  const workspacePath = workspaceId != null && currentApp?.id === workspaceId ? (currentApp.path ?? "") : "";
  const appId = workspaceId != null && currentApp?.id === workspaceId ? currentApp.id : null;

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center p-4 text-center text-sm text-muted-foreground">
        <GitBranch className="h-10 w-10 mb-3 opacity-50" />
        <p className="font-medium text-foreground mb-1">Log in to use GitHub Actions</p>
        <p className="mb-3">Sign in with Google or GitHub to access Extensions.</p>
        <Button size="sm" asChild>
          <a href="/sign-in">Log in</a>
        </Button>
      </div>
    );
  }

  if (!isPro) {
    return (
      <div className="flex flex-col items-center justify-center p-4 text-center text-sm text-muted-foreground">
        <GitBranch className="h-10 w-10 mb-3 opacity-50" />
        <p className="font-medium text-foreground mb-1">Upgrade to use GitHub Actions</p>
        <p className="mb-3">View workflow runs and job logs in the left panel. Upgrade to Pro to enable.</p>
        <Button size="sm" onClick={() => window.dispatchEvent(new CustomEvent("atlarix:trigger-upgrade"))}>
          Upgrade
        </Button>
      </div>
    );
  }

  return (
    <GitHubActionsPanel workspacePath={workspacePath} appId={appId} />
  );
}
