/**
 * GitHub Actions panel — v3.9
 * Lists workflow runs, jobs, logs; stream logs; Send to AI.
 */

import { useState, useEffect, useCallback } from "react";
import { IpcClient } from "@/ipc/ipc_client";
import { Button } from "@/components/ui/button";
import { RefreshCw, ChevronDown, ChevronRight, GitBranch, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { chatInputValueAtom } from "@/atoms/chatAtoms";
import { useSetAtom } from "jotai";
import { useSettings } from "@/hooks/useSettings";

interface GitHubActionsPanelProps {
  workspacePath: string;
  appId: number | null;
}

type Run = {
  id: number;
  name: string;
  headBranch: string;
  status: string;
  conclusion: string | null;
  createdAt: Date;
  htmlUrl?: string;
};

type Job = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  steps: unknown[];
  htmlUrl?: string;
};

export function GitHubActionsPanel({ workspacePath, appId }: GitHubActionsPanelProps) {
  const [repo, setRepo] = useState<{ owner: string; repo: string } | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<number | null>(null);
  const [jobsByRunId, setJobsByRunId] = useState<Record<number, Job[]>>({});
  const [logContent, setLogContent] = useState("");
  const [streamingJobId, setStreamingJobId] = useState<number | null>(null);
  const setChatInput = useSetAtom(chatInputValueAtom);
  const { settings } = useSettings();
  const hasToken = !!settings?.githubAccessToken?.value;

  const fetchRuns = useCallback(async () => {
    if (!workspacePath) {
      setRepo(null);
      setRuns([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await IpcClient.getInstance().githubActionsListRuns(workspacePath);
      setRepo(result.repo);
      setRuns(result.runs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRepo(null);
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  useEffect(() => {
    if (!repo || runs.length === 0) return;
    const t = setInterval(fetchRuns, 30_000);
    return () => clearInterval(t);
  }, [repo, runs.length, fetchRuns]);

  const loadJobs = async (runId: number) => {
    if (!repo) return;
    try {
      const jobs = await IpcClient.getInstance().githubActionsGetJobs(repo.owner, repo.repo, runId);
      setJobsByRunId((prev) => ({ ...prev, [runId]: jobs }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleExpandRun = (runId: number) => {
    setExpandedRunId((prev) => (prev === runId ? null : runId));
    if (!jobsByRunId[runId]) loadJobs(runId);
  };

  const loadLogs = async (jobId: number) => {
    if (!repo) return;
    setLogContent("Loading…");
    try {
      const logs = await IpcClient.getInstance().githubActionsGetLogs(repo.owner, repo.repo, jobId);
      setLogContent(logs);
    } catch (err) {
      setLogContent(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const startStream = async (jobId: number) => {
    if (!repo) return;
    setStreamingJobId(jobId);
    setLogContent("");
    await IpcClient.getInstance().githubActionsStartStream(repo.owner, repo.repo, jobId);
  };

  const stopStream = () => {
    if (streamingJobId != null) {
      IpcClient.getInstance().githubActionsStopStream(streamingJobId);
      setStreamingJobId(null);
    }
  };

  useEffect(() => {
    if (streamingJobId == null) return;
    const unsub = IpcClient.getInstance().onGitHubActionsLogChunk((payload) => {
      if (payload.jobId !== streamingJobId) return;
      if (payload.error) setLogContent((c) => c + `\n${payload.error}`);
      if (payload.line) setLogContent((c) => c + (c ? "\n" : "") + payload.line);
    });
    return unsub;
  }, [streamingJobId]);

  const sendToAI = () => {
    if (logContent.trim()) {
      setChatInput((prev) => `${prev ? prev + "\n\n" : ""}GitHub Actions log:\n\n${logContent.trim()}`);
    }
  };

  if (!hasToken) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center text-muted-foreground">
        <GitBranch className="h-10 w-10 mb-3 opacity-50" />
        <p className="text-sm font-medium">Connect GitHub</p>
        <p className="text-xs mt-1">Sign in with GitHub in Settings to view Actions.</p>
      </div>
    );
  }

  if (!workspacePath) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center text-muted-foreground">
        <GitBranch className="h-10 w-10 mb-3 opacity-50" />
        <p className="text-sm font-medium">No workspace</p>
        <p className="text-xs mt-1">Open a workspace to see GitHub Actions.</p>
      </div>
    );
  }

  if (loading && runs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!repo) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center text-muted-foreground">
        <AlertCircle className="h-10 w-10 mb-3 opacity-50" />
        <p className="text-sm font-medium">No GitHub repo detected</p>
        <p className="text-xs mt-1">This workspace does not have a GitHub remote (origin).</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border flex-shrink-0">
        <h3 className="text-sm font-semibold">GitHub Actions</h3>
        <Button variant="ghost" size="sm" onClick={fetchRuns} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </div>
      <div className="px-3 py-1.5 text-xs text-muted-foreground border-b border-border/50">
        {repo.owner}/{repo.repo}
      </div>
      {error && (
        <div className="px-3 py-2 text-xs text-destructive bg-destructive/10">{error}</div>
      )}
      <div className="flex-1 overflow-auto min-h-0 flex flex-col">
        <div className="flex-1 overflow-auto p-2 space-y-1">
          {runs.map((run) => (
            <div key={run.id} className="rounded border border-border/60 bg-card overflow-hidden">
              <button
                type="button"
                className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted/50"
                onClick={() => handleExpandRun(run.id)}
              >
                {expandedRunId === run.id ? (
                  <ChevronDown className="h-4 w-4 shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0" />
                )}
                <span
                  className={cn(
                    "w-2 h-2 rounded-full shrink-0",
                    run.status === "completed" && run.conclusion === "success" && "bg-green-500",
                    run.status === "completed" && run.conclusion === "failure" && "bg-red-500",
                    run.status === "in_progress" && "bg-amber-500 animate-pulse"
                  )}
                />
                <span className="truncate flex-1">{run.name}</span>
                <span className="text-xs text-muted-foreground shrink-0">{run.headBranch}</span>
              </button>
              {expandedRunId === run.id && (
                <div className="border-t border-border/50 px-2 py-1.5 space-y-1">
                  {(jobsByRunId[run.id] ?? []).map((job) => (
                    <div key={job.id} className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate">{job.name}</span>
                      <div className="flex gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5"
                          onClick={() => loadLogs(job.id)}
                        >
                          Logs
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5"
                          onClick={() => (streamingJobId === job.id ? stopStream() : startStream(job.id))}
                        >
                          {streamingJobId === job.id ? "Stop" : "Stream"}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        {logContent && (
          <div className="border-t border-border flex flex-col flex-1 min-h-0">
            <div className="flex justify-end gap-1 px-2 py-1 border-b border-border/50">
              <Button size="sm" variant="outline" onClick={sendToAI}>
                Send to AI
              </Button>
            </div>
            <pre
              className={cn(
                "flex-1 overflow-auto p-2 text-xs font-mono whitespace-pre-wrap break-words bg-muted/30",
                "min-h-[120px]"
              )}
            >
              {logContent.split("\n").map((line, i) => (
                <span
                  key={i}
                  className={cn(
                    /error|Error|ERROR/i.test(line) && "text-red-600 dark:text-red-400",
                    /warn|Warning|WARNING/i.test(line) && "text-amber-600 dark:text-amber-400"
                  )}
                >
                  {line}
                  {"\n"}
                </span>
              ))}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
