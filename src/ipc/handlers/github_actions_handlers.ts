/**
 * GitHub Actions IPC handlers — v3.9
 * List runs, get jobs, get logs, stream logs to renderer.
 */

import path from "node:path";
import { ipcMain, IpcMainInvokeEvent } from "electron";
import { GitHubProvider } from "../../lib/ci/GitHubProvider";
import { detectGitHubRepo } from "../../lib/ci/repo-detector";
import { resolveAppPath } from "../../paths/paths";
import { safeSend } from "../utils/safe_sender";

const streamListeners = new Map<
  number,
  { abort: () => void }
>();

export function registerGitHubActionsHandlers(): void {
  ipcMain.handle(
    "github-actions:list-runs",
    async (_event, workspacePath: string) => {
      const resolvedPath = path.isAbsolute(workspacePath) ? workspacePath : resolveAppPath(workspacePath);
      const repo = await detectGitHubRepo(resolvedPath);
      if (!repo) return { repo: null, runs: [] };
      const runs = await GitHubProvider.listRuns(repo.owner, repo.repo, {
        perPage: 20,
      });
      return { repo: { owner: repo.owner, repo: repo.repo }, runs };
    }
  );

  ipcMain.handle(
    "github-actions:get-jobs",
    async (_event, owner: string, repo: string, runId: number) => {
      return GitHubProvider.getJobs(owner, repo, runId);
    }
  );

  ipcMain.handle(
    "github-actions:get-logs",
    async (_event, owner: string, repo: string, jobId: number) => {
      return GitHubProvider.getJobLogs(owner, repo, jobId);
    }
  );

  ipcMain.handle(
    "github-actions:start-stream",
    async (
      event: IpcMainInvokeEvent,
      owner: string,
      repo: string,
      jobId: number,
      filter?: string | null
    ) => {
      const re = filter ? new RegExp(filter, "i") : null;
      const aborted = { current: false };
      streamListeners.set(jobId, {
        abort: () => { aborted.current = true; },
      });
      (async () => {
        try {
          for await (const line of GitHubProvider.streamJobLogs(
            owner,
            repo,
            jobId,
            re
          )) {
            if (aborted.current) break;
            safeSend(event.sender, "github-actions:log-chunk", {
              jobId,
              line,
            });
          }
        } catch (err) {
          if (!aborted.current) {
            safeSend(event.sender, "github-actions:log-chunk", {
              jobId,
              error: String(err),
            });
          }
        } finally {
          streamListeners.delete(jobId);
        }
      })();
      return { success: true, jobId };
    }
  );

  ipcMain.handle("github-actions:stop-stream", (_event, jobId: number) => {
    const entry = streamListeners.get(jobId);
    if (entry) {
      entry.abort();
      streamListeners.delete(jobId);
    }
    return { success: true };
  });
}
