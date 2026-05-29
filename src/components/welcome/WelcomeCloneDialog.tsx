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
import { cn } from "@/lib/utils";

function extractRepoNameFromUrl(url: string): string | null {
  const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return match ? match[2] : null;
}

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

  const {
    targetParentDir,
    cloning,
    cloneProgress,
    cloneMessage,
    activeRepo,
    resolveTargetPath,
    chooseFolder,
    ensureFolder,
    cancelClone,
    runClone,
  } = useGithubCloneFlow();

  const workspaceNameForUrl = appName.trim() || extractRepoNameFromUrl(url.trim()) || "repo";
  const destinationPreview = resolveTargetPath(workspaceNameForUrl);

  const loadGithubRepos = async () => {
    setLoadingRepos(true);
    try {
      setRepos(await IpcClient.getInstance().listGithubRepos());
    } catch (e) {
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
    if (!(await ensureFolder())) return;

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
    const name = workspaceNameForUrl;
    await finishClone(trimmed, name);
  };

  const handleRepoClick = async (repo: GithubRepository) => {
    const name = appName.trim() || repo.name;
    await finishClone(
      `https://github.com/${repo.full_name}.git`,
      name,
      repo.full_name,
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

  const canCloneUrl = !!url.trim() && !!targetParentDir && !cloning;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Clone repository</DialogTitle>
          <DialogDescription>
            HTTPS or git@ SSH URL. Choose where to save the project on disk, then clone.
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

          <CloneDestinationFields
            targetParentDir={targetParentDir}
            destinationPreview={destinationPreview}
            onChooseFolder={() => void chooseFolder()}
            disabled={cloning}
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
              <Button
                className="w-full"
                disabled={!canCloneUrl}
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
            </TabsContent>
            <TabsContent value="github" className="pt-2 space-y-3">
              {!isAuthenticated ? (
                <UnconnectedGitHubConnector
                  appId={null}
                  folderName={appName.trim() || "cloned-repo"}
                  settings={settings}
                  refreshSettings={() => {
                    void refreshSettings();
                  }}
                  handleRepoSetupComplete={() => {}}
                  connectOnly
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
                  <Input
                    placeholder="Workspace name (optional)"
                    value={appName}
                    onChange={(e) => setAppName(e.target.value)}
                    disabled={cloning}
                  />
                  <ul className="max-h-48 overflow-y-auto space-y-1 border rounded-md p-2">
                    {repos.map((repo) => (
                      <li key={repo.full_name}>
                        <button
                          type="button"
                          className={cn(
                            "w-full text-left text-sm px-2 py-1.5 rounded hover:bg-accent",
                            activeRepo === repo.full_name && "bg-accent",
                          )}
                          disabled={cloning || !targetParentDir}
                          onClick={() => void handleRepoClick(repo)}
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
                  {!targetParentDir ? (
                    <p className="text-xs text-muted-foreground">
                      Choose a save folder above before selecting a repository.
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
