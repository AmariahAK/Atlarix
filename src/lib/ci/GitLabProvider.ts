/**
 * GitLab CI implementation of CIPlatform — v4.0 Workforce
 * Uses Token Vault for auth (service: "gitlab"). Scopes: read_api, read_repository.
 */

import * as TokenVault from "../auth/TokenVaultService";
import type {
  CIPlatform,
  WorkflowRun,
  WorkflowJob,
  WorkflowStep,
} from "./CIPlatform";
import log from "electron-log";

const logger = log.scope("GitLabProvider");

const GITLAB_SCOPES = ["read_api", "read_repository"];
const API_BASE = "https://gitlab.com/api/v4";

async function getToken(): Promise<string | null> {
  return TokenVault.getToken("gitlab", GITLAB_SCOPES);
}

function encodeProjectId(owner: string, repo: string): string {
  return encodeURIComponent(`${owner}/${repo}`);
}

function mapStatus(s: string): WorkflowRun["status"] {
  if (s === "success" || s === "failed" || s === "canceled") return "completed";
  if (s === "running" || s === "pending") return "in_progress";
  if (s === "created" || s === "waiting") return "queued";
  return "completed";
}

export const GitLabProvider: CIPlatform = {
  async listRuns(owner: string, repo: string, options?: { perPage?: number }): Promise<WorkflowRun[]> {
    const token = await getToken();
    if (!token) throw new Error("GitLab not connected (Token Vault)");
    const projectId = encodeProjectId(owner, repo);
    const perPage = options?.perPage ?? 20;
    const res = await fetch(`${API_BASE}/projects/${projectId}/pipelines?per_page=${perPage}`, {
      headers: { "PRIVATE-TOKEN": token },
    });
    if (!res.ok) throw new Error(`GitLab pipelines: ${res.status}`);
    const data = await res.json();
    return (Array.isArray(data) ? data : []).map((p: any) => ({
      id: p.id,
      name: p.ref ?? "pipeline",
      headBranch: p.ref ?? "",
      headSha: p.sha ?? "",
      status: mapStatus(p.status),
      conclusion: p.status === "success" ? "success" : p.status === "failed" ? "failure" : null,
      createdAt: new Date(p.created_at ?? 0),
      htmlUrl: p.web_url,
    }));
  },

  async getJobs(owner: string, repo: string, runId: number, _pipelineUuid?: string): Promise<WorkflowJob[]> {
    const token = await getToken();
    if (!token) throw new Error("GitLab not connected (Token Vault)");
    const projectId = encodeProjectId(owner, repo);
    const res = await fetch(
      `${API_BASE}/projects/${projectId}/pipelines/${runId}/jobs`,
      { headers: { "PRIVATE-TOKEN": token } }
    );
    if (!res.ok) throw new Error(`GitLab jobs: ${res.status}`);
    const data = await res.json();
    const jobs = Array.isArray(data) ? data : [];
    return jobs.map((j: any) => ({
      id: j.id,
      name: j.name ?? "Job",
      status: mapStatus(j.status) as WorkflowJob["status"],
      conclusion: j.status === "success" ? "success" : j.status === "failed" ? "failure" : null,
      steps: [], // GitLab jobs don't expose steps in same way; optional
      htmlUrl: j.web_url,
    }));
  },

  async getJobLogs(owner: string, repo: string, jobId: number, _pipelineUuid?: string): Promise<string> {
    const token = await getToken();
    if (!token) throw new Error("GitLab not connected (Token Vault)");
    const projectId = encodeProjectId(owner, repo);
    const res = await fetch(
      `${API_BASE}/projects/${projectId}/jobs/${jobId}/trace`,
      { headers: { "PRIVATE-TOKEN": token } }
    );
    if (!res.ok) throw new Error(`GitLab job trace: ${res.status}`);
    return res.text();
  },

  async *streamJobLogs(
    owner: string,
    repo: string,
    jobId: number,
    filter?: RegExp | null,
    _pipelineUuid?: string
  ): AsyncGenerator<string, void, unknown> {
    let lastLineCount = 0;
    while (true) {
      const logs = await this.getJobLogs(owner, repo, jobId);
      const lines = logs.split(/\r?\n/);
      for (let i = lastLineCount; i < lines.length; i++) {
        const line = lines[i];
        if (filter && !filter.test(line)) continue;
        yield line;
      }
      lastLineCount = lines.length;
      const token = await getToken();
      if (!token) return;
      const projectId = encodeProjectId(owner, repo);
      const statusRes = await fetch(
        `${API_BASE}/projects/${projectId}/jobs/${jobId}`,
        { headers: { "PRIVATE-TOKEN": token } }
      );
      if (!statusRes.ok) return;
      const job = await statusRes.json();
      if (job.status === "success" || job.status === "failed" || job.status === "canceled") break;
      await new Promise((r) => setTimeout(r, 8000));
    }
  },
};
