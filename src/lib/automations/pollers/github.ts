/**
 * Deterministic GitHub trigger poller — REST via the user's stored token
 * (github_handlers pattern), no gh CLI, and NO LLM: a fired trigger only
 * enqueues an agent run. A null cursor seeds silently (never fire on backlog).
 */

import log from "electron-log";
import { readSettings } from "@/main/settings";
import type { GithubCursor, GithubTrigger } from "../types";

const logger = log.scope("automations:github");

const GITHUB_API_BASE = "https://api.github.com";
const SEEN_REVIEW_IDS_CAP = 200;

export interface GithubPollResult {
  fired: boolean;
  context?: string;
  nextCursor: GithubCursor;
}

type FetchLike = typeof fetch;

async function ghGet(
  path: string,
  token: string,
  fetchImpl: FetchLike,
): Promise<unknown> {
  const res = await fetchImpl(`${GITHUB_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub ${path} → ${res.status} ${res.statusText}`);
  }
  return res.json();
}

let cachedLogin: string | null = null;

export async function pollGithub(
  trigger: GithubTrigger,
  cursor: GithubCursor | null,
  opts?: { token?: string; fetchImpl?: FetchLike },
): Promise<GithubPollResult> {
  const token =
    opts?.token ?? readSettings().githubAccessToken?.value ?? null;
  if (!token) {
    throw new Error("GitHub is not connected — connect GitHub in settings to use this trigger");
  }
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const seeding = cursor == null;
  const next: GithubCursor = {
    lastPrNumber: cursor?.lastPrNumber,
    seenReviewIds: cursor?.seenReviewIds ? [...cursor.seenReviewIds] : undefined,
    lastWorkflowRunId: cursor?.lastWorkflowRunId,
  };
  const findings: string[] = [];

  if (trigger.events.includes("new-pr")) {
    const prs = (await ghGet(
      `/repos/${trigger.repo}/pulls?state=open&sort=created&direction=desc&per_page=20`,
      token,
      fetchImpl,
    )) as Array<{ number: number; title: string; html_url: string; user?: { login?: string } }>;
    const maxSeen = next.lastPrNumber ?? 0;
    const fresh = prs.filter((p) => p.number > maxSeen);
    if (prs.length > 0) {
      next.lastPrNumber = Math.max(maxSeen, ...prs.map((p) => p.number));
    }
    if (!seeding) {
      for (const p of fresh) {
        findings.push(`New PR #${p.number} by ${p.user?.login ?? "?"}: "${p.title}" — ${p.html_url}`);
      }
    }
  }

  if (trigger.events.includes("review-requested")) {
    if (!cachedLogin) {
      const user = (await ghGet("/user", token, fetchImpl)) as { login?: string };
      cachedLogin = user.login ?? null;
    }
    if (cachedLogin) {
      const q = encodeURIComponent(
        `repo:${trigger.repo} type:pr state:open review-requested:${cachedLogin}`,
      );
      const result = (await ghGet(`/search/issues?q=${q}&per_page=20`, token, fetchImpl)) as {
        items?: Array<{ id: number; number: number; title: string; html_url: string }>;
      };
      const seen = new Set(next.seenReviewIds ?? []);
      for (const item of result.items ?? []) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        if (!seeding) {
          findings.push(`Review requested on PR #${item.number}: "${item.title}" — ${item.html_url}`);
        }
      }
      next.seenReviewIds = [...seen].slice(-SEEN_REVIEW_IDS_CAP);
    }
  }

  if (trigger.events.includes("ci-failed")) {
    const runs = (await ghGet(
      `/repos/${trigger.repo}/actions/runs?status=completed&per_page=20`,
      token,
      fetchImpl,
    )) as {
      workflow_runs?: Array<{
        id: number;
        name?: string;
        conclusion?: string;
        html_url: string;
        head_branch?: string;
      }>;
    };
    const all = runs.workflow_runs ?? [];
    const maxSeen = next.lastWorkflowRunId ?? 0;
    if (all.length > 0) {
      next.lastWorkflowRunId = Math.max(maxSeen, ...all.map((r) => r.id));
    }
    if (!seeding) {
      for (const r of all) {
        if (r.id <= maxSeen || r.conclusion !== "failure") continue;
        findings.push(
          `CI failed: ${r.name ?? "workflow"} on ${r.head_branch ?? "?"} — ${r.html_url}`,
        );
      }
    }
  }

  if (seeding) {
    logger.info(`seeded github cursor for ${trigger.repo} (no fire on backlog)`);
    return { fired: false, nextCursor: next };
  }
  if (findings.length === 0) return { fired: false, nextCursor: next };
  return {
    fired: true,
    context: findings.map((f) => `- ${f}`).join("\n"),
    nextCursor: next,
  };
}

export function resetGithubLoginCacheForTests(): void {
  cachedLogin = null;
}
