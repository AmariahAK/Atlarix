import { describe, expect, it, vi } from "vitest";
import {
  pollGithub,
  resetGithubLoginCacheForTests,
} from "@/lib/automations/pollers/github";
import { stableStringify } from "@/lib/automations/pollers/mcp";
import type { GithubTrigger } from "@/lib/automations/types";

function fakeFetch(routes: Record<string, unknown>) {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    const key = Object.keys(routes).find((k) => u.includes(k));
    if (!key) return { ok: false, status: 404, statusText: "not found" } as Response;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => routes[key],
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const trigger: GithubTrigger = {
  kind: "github",
  repo: "owner/repo",
  events: ["new-pr", "ci-failed"],
  intervalMinutes: 5,
};

describe("pollGithub", () => {
  it("seeds the cursor WITHOUT firing on a null cursor", async () => {
    resetGithubLoginCacheForTests();
    const fetchImpl = fakeFetch({
      "/pulls": [
        { number: 41, title: "Old PR", html_url: "u", user: { login: "a" } },
      ],
      "/actions/runs": { workflow_runs: [{ id: 900, conclusion: "failure", html_url: "u" }] },
    });
    const result = await pollGithub(trigger, null, { token: "tok", fetchImpl });
    expect(result.fired).toBe(false);
    expect(result.nextCursor.lastPrNumber).toBe(41);
    expect(result.nextCursor.lastWorkflowRunId).toBe(900);
  });

  it("fires on new PRs and failed CI runs past the cursor", async () => {
    resetGithubLoginCacheForTests();
    const fetchImpl = fakeFetch({
      "/pulls": [
        { number: 43, title: "Newest", html_url: "u43", user: { login: "bob" } },
        { number: 41, title: "Old", html_url: "u41", user: { login: "a" } },
      ],
      "/actions/runs": {
        workflow_runs: [
          { id: 950, name: "CI", conclusion: "failure", html_url: "u950", head_branch: "main" },
          { id: 900, name: "CI", conclusion: "success", html_url: "u900", head_branch: "main" },
        ],
      },
    });
    const result = await pollGithub(
      trigger,
      { lastPrNumber: 41, lastWorkflowRunId: 900 },
      { token: "tok", fetchImpl },
    );
    expect(result.fired).toBe(true);
    expect(result.context).toContain("New PR #43");
    expect(result.context).toContain("CI failed");
    expect(result.context).not.toContain("#41");
    expect(result.nextCursor.lastPrNumber).toBe(43);
    expect(result.nextCursor.lastWorkflowRunId).toBe(950);
  });

  it("does not fire when nothing changed", async () => {
    resetGithubLoginCacheForTests();
    const fetchImpl = fakeFetch({
      "/pulls": [{ number: 41, title: "Old", html_url: "u", user: { login: "a" } }],
      "/actions/runs": { workflow_runs: [] },
    });
    const result = await pollGithub(
      trigger,
      { lastPrNumber: 41, lastWorkflowRunId: 900 },
      { token: "tok", fetchImpl },
    );
    expect(result.fired).toBe(false);
  });

  it("throws an actionable error when GitHub is not connected", async () => {
    await expect(
      pollGithub(trigger, null, { token: undefined, fetchImpl: fakeFetch({}) }),
    ).rejects.toThrow(/not connected/);
  });
});

describe("stableStringify", () => {
  it("is key-order independent", () => {
    expect(stableStringify({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(
      stableStringify({ a: [{ x: 1, y: 2 }], b: 1 }),
    );
  });
});
