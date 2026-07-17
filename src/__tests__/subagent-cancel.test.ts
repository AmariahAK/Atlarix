import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "@/ipc/utils/system_git_exec";
import {
  createSubagentWorktree,
  isGitRepo,
} from "@/lib/agents/subagent-worktree";

/**
 * v14.8.7 §C — a user cancel must kill a writer sub-agent's git worktree
 * children (the CPU-spike source), not let them run to completion. The abort
 * signal is now threaded into the heavy worktree git ops; an already-aborted
 * signal must short-circuit worktree creation instead of shelling out fully.
 */

// Real git init/commit/worktree subprocesses are slow under full-suite parallel
// load; give the hooks and tests the same 30s budget as subagent-worktree.test.ts
// (and the eval project) so they don't flake on the default 5s test / 10s hook.
const GIT_IO_TIMEOUT_MS = 30_000;

let repo: string;
let gitAvailable = false;

beforeAll(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-cancel-"));
  await exec(["init"], repo);
  await exec(["config", "user.email", "t@t.dev"], repo);
  await exec(["config", "user.name", "t"], repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
  await exec(["add", "-A"], repo);
  await exec(["commit", "-m", "init"], repo);
  gitAvailable = await isGitRepo(repo);
}, GIT_IO_TIMEOUT_MS);

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("writer worktree honors an abort signal", () => {
  it("does not create a worktree when the signal is already aborted", { timeout: GIT_IO_TIMEOUT_MS }, async () => {
    if (!gitAvailable) return; // git not on PATH — skip (CI has git)
    const aborted = AbortSignal.abort();
    const wt = await createSubagentWorktree(repo, "cancel-task", aborted);
    // Seed + add git children are killed by the aborted signal → creation bails.
    expect(wt).toBeNull();
  });

  it("still creates a worktree with a live (non-aborted) signal", { timeout: GIT_IO_TIMEOUT_MS }, async () => {
    if (!gitAvailable) return;
    const ac = new AbortController();
    const wt = await createSubagentWorktree(repo, "live-task", ac.signal);
    expect(wt).not.toBeNull();
    expect(wt?.worktreePath).toContain("live-task");
    // Cleanup the created worktree.
    const { removeSubagentWorktree } = await import("@/lib/agents/subagent-worktree");
    if (wt) await removeSubagentWorktree(repo, wt);
  });
});
