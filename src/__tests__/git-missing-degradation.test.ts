import { describe, it, expect, vi } from "vitest";

/**
 * With no git binary (exec resolves exit 127), READ operations degrade to
 * neutral values instead of throwing; WRITE operations keep throwing with the
 * actionable install message.
 */

vi.mock("@/ipc/utils/system_git_exec", () => {
  const GIT_NOT_INSTALLED_MESSAGE =
    "Git is not installed (or not on PATH). Install Git — on macOS run `xcode-select --install` — to enable version control features.";
  return {
    GIT_NOT_INSTALLED_MESSAGE,
    exec: vi.fn(async () => ({
      exitCode: 127,
      stdout: "",
      stderr: GIT_NOT_INSTALLED_MESSAGE,
    })),
    isGitAvailable: vi.fn(async () => false),
    isGitMissingResult: (r: { exitCode: number }) => r.exitCode === 127,
  };
});

vi.mock("@/main/settings", () => ({
  readSettings: vi.fn(() => ({ includeAtlarixCoAuthor: true })),
}));

vi.mock("@/ipc/utils/git_author", () => ({
  ATLARIX_CO_AUTHOR_TRAILER: "Co-authored-by: Atlarix <agent@atlarix.dev>",
  getGitAuthor: vi.fn(async () => ({
    name: "atlarix-agent",
    email: "agent@atlarix.dev",
  })),
}));

vi.mock("node:fs", () => {
  const existsSync = vi.fn((filePath: string) =>
    String(filePath).includes(".git"),
  );
  return {
    default: { existsSync },
    existsSync,
  };
});

vi.mock("isomorphic-git", () => ({
  default: {
    clone: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("isomorphic-git/http/node", () => ({ default: {} }));

import {
  gitLog,
  gitCurrentBranch,
  gitListBranches,
  getGitUncommittedFiles,
  isGitStatusClean,
  gitIsIgnored,
  getCurrentCommitHash,
  gitCommit,
  gitClone,
} from "@/ipc/utils/git_utils";
import isomorphicGit from "isomorphic-git";

describe("git read operations degrade gracefully when git is missing", () => {
  it("gitLog returns []", async () => {
    await expect(gitLog({ path: "/tmp/repo" })).resolves.toEqual([]);
  });

  it("gitCurrentBranch returns null", async () => {
    await expect(gitCurrentBranch({ path: "/tmp/repo" })).resolves.toBeNull();
  });

  it("gitListBranches returns []", async () => {
    await expect(gitListBranches({ path: "/tmp/repo" })).resolves.toEqual([]);
  });

  it("getGitUncommittedFiles returns []", async () => {
    await expect(
      getGitUncommittedFiles({ path: "/tmp/repo" }),
    ).resolves.toEqual([]);
  });

  it("isGitStatusClean returns true", async () => {
    await expect(isGitStatusClean({ path: "/tmp/repo" })).resolves.toBe(true);
  });

  it("gitIsIgnored returns false", async () => {
    await expect(
      gitIsIgnored({ path: "/tmp/repo", filepath: "a.txt" }),
    ).resolves.toBe(false);
  });

  it("getCurrentCommitHash returns empty string", async () => {
    await expect(getCurrentCommitHash({ path: "/tmp/repo" })).resolves.toBe(
      "",
    );
  });
});

describe("git write operations still throw when git is missing", () => {
  it("gitCommit rejects with the install message", async () => {
    await expect(
      gitCommit({ path: "/tmp/repo", message: "test" }),
    ).rejects.toThrow(/Git is not installed/);
  });
});

describe("network flows fall back to isomorphic-git when git is missing", () => {
  it("gitClone uses isomorphic-git with onAuth", async () => {
    await gitClone({
      path: "/tmp/clone-target",
      url: "https://github.com/a/b.git",
      accessToken: "tok",
    });
    const clone = vi.mocked(isomorphicGit.clone);
    expect(clone).toHaveBeenCalledTimes(1);
    const args = clone.mock.calls[0][0] as { url: string; onAuth?: () => unknown };
    expect(args.url).toBe("https://github.com/a/b.git");
    expect(args.onAuth?.()).toEqual({
      username: "tok",
      password: "x-oauth-basic",
    });
  });
});
