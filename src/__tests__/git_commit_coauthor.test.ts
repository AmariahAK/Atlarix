import { describe, it, expect, vi, beforeEach } from "vitest";
import { ATLARIX_CO_AUTHOR_TRAILER } from "@/ipc/utils/git_author";

vi.mock("@/main/settings", () => ({
  readSettings: vi.fn(),
}));

vi.mock("@/ipc/utils/system_git_exec", () => ({
  exec: vi.fn(),
  isGitAvailable: vi.fn(async () => true),
  isGitMissingResult: (r: { exitCode: number }) => r.exitCode === 127,
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

import { readSettings } from "@/main/settings";
import { exec } from "@/ipc/utils/system_git_exec";
import { gitCommit } from "@/ipc/utils/git_utils";

const mockReadSettings = vi.mocked(readSettings);
const mockExec = vi.mocked(exec);

describe("gitCommit co-authored-by live settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadSettings.mockReturnValue({
      includeAtlarixCoAuthor: true,
    } as ReturnType<typeof readSettings>);
    // Default: git identity IS configured (user.email resolves) → user authors.
    mockExec.mockImplementation(async (args: string[]) => {
      if (args[0] === "rev-parse") {
        return { exitCode: 0, stdout: "abc123\n", stderr: "" };
      }
      if (args[0] === "config" && args.includes("user.email")) {
        return { exitCode: 0, stdout: "user@example.com\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
  });

  it("appends co-author trailer when includeAtlarixCoAuthor is true", async () => {
    mockReadSettings.mockReturnValue({
      includeAtlarixCoAuthor: true,
    } as ReturnType<typeof readSettings>);

    await gitCommit({ path: "/tmp/repo", message: "test commit" });

    const commitCall = mockExec.mock.calls.find((c) => c[0][0] === "commit");
    expect(commitCall).toBeDefined();
    const messageArg = commitCall![0][2];
    expect(messageArg).toContain(ATLARIX_CO_AUTHOR_TRAILER);
  });

  it("does NOT pass --author when the machine has a git identity (user authors)", async () => {
    mockReadSettings.mockReturnValue({
      includeAtlarixCoAuthor: true,
    } as ReturnType<typeof readSettings>);

    await gitCommit({ path: "/tmp/repo", message: "configured" });

    const commitCall = mockExec.mock.calls.find((c) => c[0][0] === "commit");
    expect(commitCall).toBeDefined();
    expect(commitCall![0]).not.toContain("--author");
  });

  it("falls back to agent identity as author only when git is unconfigured", async () => {
    mockReadSettings.mockReturnValue({
      includeAtlarixCoAuthor: true,
    } as ReturnType<typeof readSettings>);
    // No user.email configured → empty stdout.
    mockExec.mockImplementation(async (args: string[]) => {
      if (args[0] === "rev-parse") {
        return { exitCode: 0, stdout: "abc123\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await gitCommit({ path: "/tmp/repo", message: "bare machine" });

    const commitCall = mockExec.mock.calls.find((c) => c[0][0] === "commit");
    expect(commitCall).toBeDefined();
    expect(commitCall![0]).toContain("--author");
    expect(commitCall![0].join(" ")).toContain(
      "atlarix-agent <agent@atlarix.dev>",
    );
  });

  it("omits co-author trailer when includeAtlarixCoAuthor is false (fresh read)", async () => {
    mockReadSettings.mockReturnValue({
      includeAtlarixCoAuthor: false,
    } as ReturnType<typeof readSettings>);

    await gitCommit({ path: "/tmp/repo", message: "no trailer" });

    const commitCall = mockExec.mock.calls.find((c) => c[0][0] === "commit");
    expect(commitCall).toBeDefined();
    const messageArg = commitCall![0][2];
    expect(messageArg).toBe("no trailer");
    expect(messageArg).not.toContain("Co-authored-by:");
  });

  it("reads settings again on a second commit without module reload", async () => {
    mockReadSettings.mockReturnValue({
      includeAtlarixCoAuthor: true,
    } as ReturnType<typeof readSettings>);
    await gitCommit({ path: "/tmp/repo", message: "first" });

    mockReadSettings.mockReturnValue({
      includeAtlarixCoAuthor: false,
    } as ReturnType<typeof readSettings>);
    mockExec.mockClear();
    mockExec.mockImplementation(async (args: string[]) => {
      if (args[0] === "rev-parse") {
        return { exitCode: 0, stdout: "def456\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await gitCommit({ path: "/tmp/repo", message: "second" });

    const commitCall = mockExec.mock.calls.find((c) => c[0][0] === "commit");
    expect(commitCall![0][2]).toBe("second");
    expect(mockReadSettings.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
