/**
 * Bitbucket Pipelines implementation of CIPlatform — v4.0 Workforce
 * Uses Token Vault for auth (service: "bitbucket"). Scopes: pipeline:read, repository:read.
 */

import * as TokenVault from "../auth/TokenVaultService";
import type {
  CIPlatform,
  WorkflowRun,
  WorkflowJob,
} from "./CIPlatform";
import log from "electron-log";

const logger = log.scope("BitbucketProvider");

const BITBUCKET_SCOPES = ["pipeline:read", "repository:read"];
const API_BASE = "https://api.bitbucket.org/2.0";

async function getToken(): Promise<string | null> {
  return TokenVault.getToken("bitbucket", BITBUCKET_SCOPES);
}

function mapStatus(s: string): WorkflowRun["status"] {
  if (s === "COMPLETED") return "completed";
  if (s === "IN_PROGRESS" || s === "PENDING") return "in_progress";
  return "completed";
}

export const BitbucketProvider: CIPlatform = {
  async listRuns(owner: string, repo: string, options?: { perPage?: number }): Promise<WorkflowRun[]> {
    const token = await getToken();
    if (!token) throw new Error("Bitbucket not connected (Token Vault)");
    const perPage = Math.min(options?.perPage ?? 20, 100);
    const res = await fetch(
      `${API_BASE}/repositories/${owner}/${repo}/pipelines/?pagelen=${perPage}&sort=-created_on`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    if (!res.ok) throw new Error(`Bitbucket pipelines: ${res.status}`);
    const data = await res.json();
    const values = data?.values ?? [];
    return values.map((p: any) => ({
      id: p.build_number ?? (p.uuid ? parseInt(p.uuid.replace(/-/g, "").slice(0, 8), 16) : 0),
      name: p.target?.ref_name ?? String(p.build_number ?? "pipeline"),
      headBranch: p.target?.ref_name ?? "",
      headSha: p.target?.commit?.hash ?? "",
      status: mapStatus(p.state?.name ?? "COMPLETED"),
      conclusion: p.state?.name === "COMPLETED" ? (p.state?.result?.name === "SUCCESSFUL" ? "success" : "failure") : null,
      createdAt: new Date(p.created_on ?? 0),
      htmlUrl: p.links?.html?.href,
      pipelineUuid: p.uuid,
    }));
  },

  async getJobs(owner: string, repo: string, runId: number, pipelineUuid?: string): Promise<WorkflowJob[]> {
    const token = await getToken();
    if (!token) throw new Error("Bitbucket not connected (Token Vault)");
    const runKey = pipelineUuid ?? runId;
    const res = await fetch(
      `${API_BASE}/repositories/${owner}/${repo}/pipelines/${runKey}/steps/`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) {
      return [];
    }
    const data = await res.json();
    const values = data?.values ?? [];
    return values.map((s: any, i: number) => ({
      id: s.uuid ? parseInt(s.uuid.replace(/-/g, "").slice(0, 8), 16) : i,
      name: s.name ?? `Step ${i + 1}`,
      status: mapStatus(s.state?.name ?? "COMPLETED") as WorkflowJob["status"],
      conclusion: s.state?.result?.name === "SUCCESSFUL" ? "success" : "failure",
      steps: [],
      htmlUrl: undefined,
    }));
  },

  async getJobLogs(owner: string, repo: string, jobId: number, _pipelineUuid?: string): Promise<string> {
    const token = await getToken();
    if (!token) throw new Error("Bitbucket not connected (Token Vault)");
    const res = await fetch(
      `${API_BASE}/repositories/${owner}/${repo}/pipelines/steps/${jobId}/log`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return "";
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
      await new Promise((r) => setTimeout(r, 8000));
    }
  },
};
