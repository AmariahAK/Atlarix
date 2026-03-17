/**
 * CI/CD platform abstraction — v3.9
 * Implementations: GitHub Actions (GitHubProvider).
 */

export interface WorkflowRun {
  id: number;
  name: string;
  headBranch: string;
  headSha: string;
  status: "completed" | "in_progress" | "queued" | "cancelled" | "failure" | "success";
  conclusion: string | null;
  createdAt: Date;
  htmlUrl?: string;
  /** Optional platform-specific run id (e.g. Bitbucket pipeline UUID) for getJobs/getJobLogs */
  pipelineUuid?: string;
}

export interface WorkflowStep {
  id: number;
  name: string;
  status: "completed" | "in_progress" | "queued" | "pending";
  conclusion: "success" | "failure" | "skipped" | "cancelled" | null;
  number: number;
}

export interface WorkflowJob {
  id: number;
  name: string;
  status: "completed" | "in_progress" | "queued" | "waiting" | "pending";
  conclusion: "success" | "failure" | "cancelled" | "skipped" | null;
  steps: WorkflowStep[];
  htmlUrl?: string;
}

export interface CIPlatform {
  listRuns(owner: string, repo: string, options?: { perPage?: number }): Promise<WorkflowRun[]>;
  getJobs(owner: string, repo: string, runId: number, pipelineUuid?: string): Promise<WorkflowJob[]>;
  getJobLogs(owner: string, repo: string, jobId: number, pipelineUuid?: string): Promise<string>;
  streamJobLogs(
    owner: string,
    repo: string,
    jobId: number,
    filter?: RegExp | null,
    pipelineUuid?: string
  ): AsyncGenerator<string, void, unknown>;
}
