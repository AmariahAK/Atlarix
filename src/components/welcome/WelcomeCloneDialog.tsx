import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IpcClient } from "@/ipc/ipc_client";
import { useSettings } from "@/hooks/useSettings";
import { UnconnectedGitHubConnector } from "@/components/GitHubConnector";
import { showSuccess } from "@/lib/toast";
import { Loader2 } from "lucide-react";
import type { GithubRepository } from "@/ipc/ipc_types";
import { openWorkspaceByAppId } from "@/lib/open-workspace-session";
import { GitHubIntegration } from "@/components/GitHubIntegration";
import { useNavigate } from "@tanstack/react-router";
import { useLoadApps } from "@/hooks/useLoadApps";
import { useGithubCloneFlow } from "@/hooks/useGithubCloneFlow";
import { CloneDestinationFields } from "@/components/welcome/CloneDestinationFields";
import { CloneProgressOverlay } from "@/components/welcome/CloneProgressOverlay";
import { repoNameFromUrl } from "@/shared/git_remote_url";
import { cn } from "@/lib/utils";

export function WelcomeCloneDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { refreshApps } = useLoadApps();
  const { settings, refreshSettings } = useSettings();
  const isAuthenticated = !!settings?.githubAccessToken;
  const [activeTab, setActiveTab] = useState<"url" | "github">("url");
  const [repos, setRepos] = useState<GithubRepository[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [url, setUrl] = useState("");
  const [appName, setAppName] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<GithubRepository | null>(null);

  const {
    parentDirInput,
    setParentDirInput,
    parentDirError,
    validatingParentDir,
    targetParentDir,
    cloning,
    cloneProgress,
    cloneMessage,
    activeRepo,
    resolveTargetPath,
    chooseFolder,
    cancelClone,
    runClone,
  } = useGithubCloneFlow();

  const workspaceNameForUrl =
    appName.trim() || repoNameFromUrl(url) || "repo";
  const workspaceNameForRepo =
    appName.trim() || selectedRepo?.name || "repo";

  const destination = (
    <CloneDestinationFields
      value={parentDirInput}
      onValueChange={setParentDirInput}
      error={parentDirError}
      validating={validatingParentDir}
      destinationPreview={resolveTargetPath(
        activeTab === "url" ? workspaceNameForUrl : workspaceNameForRepo,
      )}
      onChooseFolder={() => void chooseFolder()}
      disabled={cloning}
    />
  );

  const loadGithubRepos = async () => {
    setLoadingRepos(true);
    try {
      setRepos(await IpcClient.getInstance().listGithubRepos());
    } catch {
      setRepos([]);
    } finally {
      setLoadingRepos(false);
    }
  };

  useEffect(() => {
    if (open && isAuthenticated) {
      void loadGithubRepos();
    }
  }, [open, isAuthenticated]);

  useEffect(() => {
    const unsubSuccess = IpcClient.getInstance().onGithubDeviceFlowSuccess(() => {
      setActiveTab("github");
      void refreshSettings();
    });
    return unsubSuccess;
  }, [refreshSettings]);

  const finishClone = async (
    cloneUrl: string,
    name: string,
    repoLabel?: string,
  ) => {
    const result = await runClone({
      url: cloneUrl,
      appName: name,
      repoLabel,
    });
    if (!result) return;

    showSuccess(`Cloned ${result.app.name}`);
    onOpenChange(false);
    await openWorkspaceByAppId({
      appId: result.app.id,
      folderPath: result.app.path,
      navigate: (opts) => navigate(opts),
      refreshApps,
    });
  };

  const handleUrlClone = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    await finishClone(trimmed, workspaceNameForUrl);
  };

  const handleRepoClone = async () => {
    if (!selectedRepo) return;
    await finishClone(
      `https://github.com/${selectedRepo.full_name}.git`,
      workspaceNameForRepo,
      selectedRepo.full_name,
    );
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && cloning) return;
    if (!next) {
      IpcClient.getInstance().cancelGithubDeviceFlow();
    }
    onOpenChange(next);
  };

  const handleFooterCancel = () => {
    if (cloning) {
      cancelClone();
      return;
    }
    IpcClient.getInstance().cancelGithubDeviceFlow();
    onOpenChange(false);
  };

  /**
   * Why Clone is unavailable, in the user's words. A disabled primary action with no
   * stated reason is what made this dialog read as "GitHub sign-in required" — the
   * destination folder was the only thing missing.
   */
  const urlBlockedReason = !url.trim()
    ? "Paste a repository URL to continue."
    : !targetParentDir
      ? validatingParentDir
        ? "Checking that folder…"
        : "Choose where to save this repository to continue."
      : null;
  const repoBlockedReason = !selectedRepo
    ? "Select a repository above to continue."
    : !targetParentDir
      ? validatingParentDir
        ? "Checking that folder…"
        : "Choose where to save this repository to continue."
      : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Clone repository</DialogTitle>
          <DialogDescription>
            Any git host over HTTPS, or a git@ SSH URL. Choose where to save the project
            on disk, then clone.
          </DialogDescription>
        </DialogHeader>
        <div className="relative space-y-3">
          <CloneProgressOverlay
            visible={cloning}
            message={cloneMessage}
            progress={cloneProgress}
            activeRepo={activeRepo}
            onCancel={cancelClone}
          />

          <Tabs
            value={activeTab}
            onValueChange={(v) => !cloning && setActiveTab(v as "url" | "github")}
          >
            <TabsList>
              <TabsTrigger value="url" disabled={cloning}>
                URL
              </TabsTrigger>
              <TabsTrigger value="github" disabled={cloning}>
                GitHub
              </TabsTrigger>
            </TabsList>
            <TabsContent value="url" className="space-y-3 pt-2">
              <Input
                placeholder="https://github.com/org/repo.git or git@github.com:org/repo.git"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={cloning}
              />
              <Input
                placeholder="Workspace name"
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
                disabled={cloning}
              />
              {destination}
              <Button
                className="w-full"
                disabled={!!urlBlockedReason || cloning}
                onClick={() => void handleUrlClone()}
              >
                {cloning ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Cloning…
                  </>
                ) : (
                  "Clone"
                )}
              </Button>
              {urlBlockedReason && !cloning ? (
                <p className="text-xs text-muted-foreground text-center">
                  {urlBlockedReason}
                </p>
              ) : null}
            </TabsContent>
            <TabsContent value="github" className="pt-2 space-y-3">
              {!isAuthenticated ? (
                <UnconnectedGitHubConnector
                  appId={null}
                  settings={settings}
                  refreshSettings={() => {
                    void refreshSettings();
                  }}
                />
              ) : loadingRepos ? (
                <p className="text-sm text-muted-foreground">Loading repositories…</p>
              ) : repos.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No repositories found. Try again or use the URL tab.
                </p>
              ) : (
                <>
                  <GitHubIntegration />
                  <ul className="max-h-48 overflow-y-auto space-y-1 border rounded-md p-2">
                    {repos.map((repo) => (
                      <li key={repo.full_name}>
                        <button
                          type="button"
                          aria-pressed={selectedRepo?.full_name === repo.full_name}
                          className={cn(
                            "w-full text-left text-sm px-2 py-1.5 rounded hover:bg-accent",
                            (selectedRepo?.full_name === repo.full_name ||
                              activeRepo === repo.full_name) && "bg-accent",
                          )}
                          disabled={cloning}
                          onClick={() => setSelectedRepo(repo)}
                        >
                          {repo.full_name}
                          {repo.private ? (
                            <span className="ml-2 text-xs text-muted-foreground">
                              private
                            </span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <Input
                    placeholder="Workspace name (optional)"
                    value={appName}
                    onChange={(e) => setAppName(e.target.value)}
                    disabled={cloning}
                  />
                  {destination}
                  <Button
                    className="w-full"
                    disabled={!!repoBlockedReason || cloning}
                    onClick={() => void handleRepoClone()}
                  >
                    {cloning ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        Cloning…
                      </>
                    ) : (
                      "Clone"
                    )}
                  </Button>
                  {repoBlockedReason && !cloning ? (
                    <p className="text-xs text-muted-foreground text-center">
                      {repoBlockedReason}
                    </p>
                  ) : null}
                </>
              )}
            </TabsContent>
          </Tabs>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={handleFooterCancel}>
            {cloning ? "Cancel clone" : "Cancel"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
