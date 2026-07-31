/**
 * Clone handler behaviour that the reviewer-facing bug fix depends on:
 *
 * - a failed clone reports what git actually said, with the OAuth token stripped
 * - non-GitHub hosts clone, and do NOT get recorded as a GitHub-linked workspace
 *   (githubOrg/githubRepo drive the push URL — a GitLab repo would push to github.com)
 * - SSH URLs reach git verbatim instead of being rewritten to HTTPS
 * - the branch comes from the clone, not a hardcoded "main"
 * - progress from git is forwarded to the renderer instead of parking at 15%
 * - refused transports (ext::) never reach git at all
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted above module scope, so anything they close over
// must be created with vi.hoisted.
const { gitCloneMock, gitCurrentBranchMock, insertedRows } = vi.hoisted(() => ({
  gitCloneMock: vi.fn(),
  gitCurrentBranchMock: vi.fn(),
  insertedRows: [] as Record<string, unknown>[],
}));

vi.mock("@/ipc/utils/git_utils", () => ({
  gitClone: gitCloneMock,
  gitCurrentBranch: gitCurrentBranchMock,
  gitSetRemoteUrl: vi.fn(),
  gitPush: vi.fn(),
}));

vi.mock("@/main/settings", () => ({
  readSettings: vi.fn(() => ({
    githubAccessToken: { value: "ghp_SECRET123" },
  })),
  writeSettings: vi.fn(),
}));

vi.mock("@/config/github-oauth", () => ({
  getGithubDeviceFlowClientId: () => "client-id",
  isLegacyDyadGithubDeviceClient: () => false,
  looksLikeInvalidGithubOAuthClientId: () => false,
}));

vi.mock("@/db", () => ({
  db: {
    query: { apps: { findFirst: vi.fn(async () => undefined) } },
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        insertedRows.push(row);
        return {
          returning: async () => [{ id: 7, ...row }],
        };
      },
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

vi.mock("@/ipc/handlers/workspace_session_handlers", () => ({
  startWorkspaceSession: vi.fn(async () => ({ chatId: 42 })),
}));

vi.mock("node:fs", () => {
  const existsSync = vi.fn(() => false);
  const mkdirSync = vi.fn();
  const promises = { rm: vi.fn(async () => undefined) };
  return { default: { existsSync, mkdirSync, promises }, existsSync, mkdirSync, promises };
});

import { handleCloneRepoFromUrl } from "@/ipc/handlers/github_handlers";
import type { IpcMainInvokeEvent } from "electron";

const sent: Array<{ channel: string; payload: unknown }> = [];
const fakeEvent = {
  sender: {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
  },
} as unknown as IpcMainInvokeEvent;

beforeEach(() => {
  insertedRows.length = 0;
  sent.length = 0;
  // The GitHub repo pre-check runs before the clone when a token is present.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200 })),
  );
  gitCloneMock.mockReset();
  gitCloneMock.mockResolvedValue(undefined);
  gitCurrentBranchMock.mockReset();
  gitCurrentBranchMock.mockResolvedValue("trunk");
});

describe("clone failures are reported honestly and safely", () => {
  it("surfaces git's own stderr without the embedded token", async () => {
    gitCloneMock.mockRejectedValue(
      new Error(
        "fatal: could not read Username for 'https://ghp_SECRET123:x-oauth-basic@github.com/org/private.git': terminal prompts disabled",
      ),
    );

    const result = await handleCloneRepoFromUrl(fakeEvent, {
      url: "https://github.com/org/private.git",
      appName: "private",
      targetPath: "/tmp/atlarix-test/private",
    });

    expect("error" in result).toBe(true);
    const error = (result as { error: string }).error;
    expect(error).not.toContain("ghp_SECRET123");
    expect(error).toMatch(/private or the URL is wrong/i);
    // git's own words are kept, not replaced by a generic sentence
    expect(error).toContain("could not read Username");
  });

  it("reports an unknown failure with the tail of git's output", async () => {
    gitCloneMock.mockRejectedValue(
      new Error("error: something odd\nfatal: index-pack failed"),
    );

    const result = await handleCloneRepoFromUrl(fakeEvent, {
      url: "https://github.com/org/repo.git",
      appName: "repo",
      targetPath: "/tmp/atlarix-test/repo",
    });

    expect((result as { error: string }).error).toContain("index-pack failed");
  });

  it("gives host-appropriate advice — no GitHub sign-in prompt for a GitLab repo", async () => {
    gitCloneMock.mockRejectedValue(
      new Error("fatal: Authentication failed for 'https://gitlab.com/group/priv.git/'"),
    );

    const result = await handleCloneRepoFromUrl(fakeEvent, {
      url: "https://gitlab.com/group/priv.git",
      appName: "priv",
      targetPath: "/tmp/atlarix-test/priv",
    });

    const error = (result as { error: string }).error;
    expect(error).not.toMatch(/Connect a GitHub account/i);
    expect(error).toMatch(/SSH \(git@…\) URL/i);
  });

  it("points an SSH key rejection at the agent, not at GitHub sign-in", async () => {
    gitCloneMock.mockRejectedValue(
      new Error("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."),
    );

    const result = await handleCloneRepoFromUrl(fakeEvent, {
      url: "git@github.com:org/repo.git",
      appName: "repo-ssh",
      targetPath: "/tmp/atlarix-test/repo-ssh",
    });

    expect((result as { error: string }).error).toMatch(/SSH agent/i);
  });

  it("maps a DNS failure to connectivity guidance", async () => {
    gitCloneMock.mockRejectedValue(
      new Error("fatal: unable to access: Could not resolve host: github.com"),
    );

    const result = await handleCloneRepoFromUrl(fakeEvent, {
      url: "https://github.com/org/repo.git",
      appName: "repo",
      targetPath: "/tmp/atlarix-test/repo",
    });

    expect((result as { error: string }).error).toMatch(/internet connection or proxy/i);
  });
});

describe("host handling", () => {
  it("does not record a non-GitHub clone as GitHub-linked", async () => {
    const result = await handleCloneRepoFromUrl(fakeEvent, {
      url: "https://gitlab.com/group/sub/proj.git",
      appName: "proj",
      targetPath: "/tmp/atlarix-test/proj",
    });

    expect("app" in result).toBe(true);
    expect(insertedRows[0]).toMatchObject({
      githubOrg: null,
      githubRepo: null,
      githubBranch: "trunk",
    });
    // No token is attached to a non-GitHub clone.
    expect(gitCloneMock.mock.calls[0][0]).toMatchObject({
      url: "https://gitlab.com/group/sub/proj.git",
      accessToken: undefined,
    });
  });

  it("records a GitHub clone as GitHub-linked with the cloned branch", async () => {
    gitCurrentBranchMock.mockResolvedValue("master");

    await handleCloneRepoFromUrl(fakeEvent, {
      url: "https://github.com/org/repo.git",
      appName: "repo",
      targetPath: "/tmp/atlarix-test/repo",
    });

    expect(insertedRows[0]).toMatchObject({
      githubOrg: "org",
      githubRepo: "repo",
      githubBranch: "master",
    });
  });

  it("hands an SSH URL to git verbatim, with no token", async () => {
    await handleCloneRepoFromUrl(fakeEvent, {
      url: "git@github.com:org/repo.git",
      appName: "repo-ssh",
      targetPath: "/tmp/atlarix-test/repo-ssh",
    });

    expect(gitCloneMock.mock.calls[0][0]).toMatchObject({
      url: "git@github.com:org/repo.git",
    });
  });

  it("refuses ext:: before git is ever invoked", async () => {
    const result = await handleCloneRepoFromUrl(fakeEvent, {
      url: 'ext::sh -c "id > /tmp/pwned"',
      appName: "evil",
      targetPath: "/tmp/atlarix-test/evil",
    });

    expect((result as { error: string }).error).toMatch(/Unsupported URL type/);
    expect(gitCloneMock).not.toHaveBeenCalled();
  });
});

describe("progress", () => {
  it("forwards git's percentages into the 15-85 band", async () => {
    gitCloneMock.mockImplementation(
      async (params: {
        onProgress?: (p: { phase: string; percent?: number }) => void;
      }) => {
        params.onProgress?.({ phase: "Receiving objects", percent: 50 });
        params.onProgress?.({ phase: "Resolving deltas", percent: 100 });
        return undefined;
      },
    );

    await handleCloneRepoFromUrl(fakeEvent, {
      url: "https://github.com/org/repo.git",
      appName: "repo",
      targetPath: "/tmp/atlarix-test/repo",
    });

    const progressValues = sent
      .filter((s) => s.channel === "github:clone:progress")
      .map((s) => (s.payload as { progress: number; message: string }));

    expect(progressValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ progress: 50, message: "Receiving objects: 50%" }),
        expect.objectContaining({ progress: 85, message: "Resolving deltas: 100%" }),
      ]),
    );
  });
});
