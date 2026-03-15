/**
 * GitHub Actions implementation of CIPlatform — v3.9
 * Uses @octokit/rest and GitHub OAuth token from Supabase session (session.provider_token).
 */

import { Octokit } from "@octokit/rest";
import { getSession } from "../../lib/auth/supabase-client";
import type {
  CIPlatform,
  WorkflowRun,
  WorkflowJob,
  WorkflowStep,
} from "./CIPlatform";
import log from "electron-log";

const logger = log.scope("GitHubProvider");

const RATE_LIMIT_WARN = 4500;
const POLL_INTERVAL_MS = 8000;

let requestCount = 0;
let countResetAt = Date.now() + 60 * 60 * 1000;

async function getToken(): Promise<string | null> {
  const session = await getSession();
  return session?.provider_token ?? null;
}

async function getClient(): Promise<Octokit | null> {
  const token = await getToken();
  if (!token) return null;
  return new Octokit({ auth: token });
}

function trackRequest(): void {
  requestCount++;
  if (Date.now() > countResetAt) {
    countResetAt = Date.now() + 60 * 60 * 1000;
    requestCount = 0;
  }
  if (requestCount >= RATE_LIMIT_WARN) {
    logger.warn(`GitHub API: approaching ${RATE_LIMIT_WARN} requests/hour`);
  }
}

function mapStatus(s: string): WorkflowRun["status"] {
  if (s === "completed" || s === "success" || s === "failure" || s === "cancelled") return "completed";
  if (s === "in_progress" || s === "in_progress") return "in_progress";
  if (s === "queued" || s === "waiting" || s === "pending") return "queued";
  return "completed";
}

export const GitHubProvider: CIPlatform = {
  async listRuns(owner: string, repo: string, options?: { perPage?: number }): Promise<WorkflowRun[]> {
    const octokit = await getClient();
    if (!octokit) throw new Error("GitHub not connected");
    trackRequest();
    const { data } = await octokit.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      per_page: options?.perPage ?? 20,
    });
    return (data.workflow_runs ?? []).map((r: any) => ({
      id: r.id,
      name: r.name ?? "Workflow",
      headBranch: r.head_branch ?? "",
      headSha: r.head_sha ?? "",
      status: mapStatus(r.status),
      conclusion: r.conclusion ?? null,
      createdAt: new Date(r.created_at),
      htmlUrl: r.html_url,
    }));
  },

  async getJobs(owner: string, repo: string, runId: number): Promise<WorkflowJob[]> {
    const octokit = await getClient();
    if (!octokit) throw new Error("GitHub not connected");
    trackRequest();
    const { data } = await octokit.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: runId,
    });
    return (data.jobs ?? []).map((j: any) => ({
      id: j.id,
      name: j.name ?? "Job",
      status: mapStatus(j.status) as WorkflowJob["status"],
      conclusion: j.conclusion ?? null,
      steps: (j.steps ?? []).map((s: any, i: number) => ({
        id: s.number ?? i,
        name: s.name ?? "",
        status: mapStatus(s.status) as WorkflowStep["status"],
        conclusion: s.conclusion ?? null,
        number: s.number ?? i + 1,
      })),
      htmlUrl: j.html_url,
    }));
  },

  async getJobLogs(owner: string, repo: string, jobId: number): Promise<string> {
    const token = await getToken();
    if (!token) throw new Error("GitHub not connected");
    trackRequest();
    const url = `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`;
    const res = await fetch(url, {
      redirect: "follow",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Failed to fetch logs: ${res.status}`);
    return res.text();
  },

  async *streamJobLogs(
    owner: string,
    repo: string,
    jobId: number,
    filter?: RegExp | null
  ): AsyncGenerator<string, void, unknown> {
    let lastLineCount = 0;
    const octokit = await getClient();
    if (!octokit) return;

    while (true) {
      const logs = await this.getJobLogs(owner, repo, jobId);
      const lines = logs.split(/\r?\n/);
      for (let i = lastLineCount; i < lines.length; i++) {
        const line = lines[i];
        if (filter && !filter.test(line)) continue;
        yield line;
      }
      lastLineCount = lines.length;

      trackRequest();
      const { data: job } = await octokit.actions.getJobForWorkflowRun({
        owner,
        repo,
        job_id: jobId,
      });
      if ((job as any).status === "completed") break;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  },
};