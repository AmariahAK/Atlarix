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
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IpcClient } from "@/ipc/ipc_client";
import { useSettings } from "@/hooks/useSettings";
import { UnconnectedGitHubConnector } from "@/components/GitHubConnector";
import { showError, showSuccess } from "@/lib/toast";
import { Loader2 } from "lucide-react";
import type { GithubRepository } from "@/ipc/ipc_types";
import { openWorkspaceFolder } from "@/lib/open-workspace-session";
import { useNavigate } from "@tanstack/react-router";
import { useLoadApps } from "@/hooks/useLoadApps";

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
  const { settings } = useSettings();
  const isAuthenticated = !!settings?.githubAccessToken;
  const [repos, setRepos] = useState<GithubRepository[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [url, setUrl] = useState("");
  const [appName, setAppName] = useState("");
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (open && isAuthenticated) {
      void (async () => {
        setLoadingRepos(true);
        try {
          setRepos(await IpcClient.getInstance().listGithubRepos());
        } catch (e) {
          showError(String(e));
        } finally {
          setLoadingRepos(false);
        }
      })();
    }
  }, [open, isAuthenticated]);

  const finishClone = async (cloneUrl: string, name: string) => {
    setImporting(true);
    try {
      const result = await IpcClient.getInstance().cloneRepoFromUrl({
        url: cloneUrl,
        appName: name,
      });
      if ("error" in result) {
        showError(result.error);
        return;
      }
      const folderPath = result.app.path;
      if (!folderPath) {
        showError("Clone succeeded but path is missing.");
        return;
      }
      showSuccess(`Cloned ${result.app.name}`);
      onOpenChange(false);
      await openWorkspaceFolder({
        folderPath,
        appName: result.app.name,
        navigate: (opts) => navigate(opts),
        refreshApps,
      });
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const handleUrlClone = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const name = appName.trim() || extractRepoNameFromUrl(trimmed) || "repo";
    await finishClone(trimmed, name);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Clone repository</DialogTitle>
          <DialogDescription>
            HTTPS or git@ SSH URL. Opens as a workspace when clone completes.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Tabs defaultValue="url">
            <TabsList>
              <TabsTrigger value="url">URL</TabsTrigger>
              <TabsTrigger value="github">GitHub</TabsTrigger>
            </TabsList>
            <TabsContent value="url" className="space-y-3 pt-2">
              <Input
                placeholder="https://github.com/org/repo.git or git@github.com:org/repo.git"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <Input
                placeholder="Workspace name"
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
              />
              <Button
                className="w-full"
                disabled={importing || !url.trim()}
                onClick={() => void handleUrlClone()}
              >
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : "Clone"}
              </Button>
            </TabsContent>
            <TabsContent value="github" className="pt-2">
              {!isAuthenticated ? (
                <UnconnectedGitHubConnector />
              ) : loadingRepos ? (
                <p className="text-sm text-muted-foreground">Loading repositories…</p>
              ) : (
                <ul className="max-h-48 overflow-y-auto space-y-1 border rounded-md p-2">
                  {repos.map((repo) => (
                    <li key={repo.id}>
                      <button
                        type="button"
                        className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-accent"
                        disabled={importing}
                        onClick={() =>
                          void finishClone(
                            `https://github.com/${repo.full_name}.git`,
                            appName.trim() || repo.name,
                          )
                        }
                      >
                        {repo.full_name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>
          </Tabs>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
