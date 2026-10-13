import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitBranch } from "@/cli/tui/git-branch";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "branch-"));
  dirs.push(d);
  return d;
}
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe("gitBranch", () => {
  it("reads the branch from .git/HEAD, from a subfolder too", () => {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, ".git"));
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/feature/new-colours\n");
    fs.mkdirSync(path.join(repo, "src", "cli"), { recursive: true });
    expect(gitBranch(repo)).toBe("feature/new-colours");
    expect(gitBranch(path.join(repo, "src", "cli"))).toBe("feature/new-colours");
  });

  it("follows a worktree's .git file", () => {
    const main = tmp();
    const wtGit = path.join(main, ".git", "worktrees", "wt");
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(wtGit, "HEAD"), "ref: refs/heads/wt-branch\n");
    const wt = tmp();
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${wtGit}\n`);
    expect(gitBranch(wt)).toBe("wt-branch");
  });

  it("shows a detached HEAD as a short hash, and nothing outside a repository", () => {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, ".git"));
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "4d4217b9aa0000000000000000000000000000ff\n");
    expect(gitBranch(repo)).toBe("4d4217b");
    expect(gitBranch(tmp())).toBeNull();
  });
});
