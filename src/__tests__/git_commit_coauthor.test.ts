import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { exec } from "@/ipc/utils/system_git_exec";
import { gitCommit } from "@/ipc/utils/git_utils";

const mockExec = vi.mocked(exec);

describe("gitCommit authorship is always the user's own config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExec.mockImplementation(async (args: string[]) => {
      if (args[0] === "rev-parse") {
        return { exitCode: 0, stdout: "abc123\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
  });

  it("never passes --author", async () => {
    await gitCommit({ path: "/tmp/repo", message: "test commit" });

    const commitCall = mockExec.mock.calls.find((c) => c[0][0] === "commit");
    expect(commitCall).toBeDefined();
    expect(commitCall![0]).not.toContain("--author");
  });

  it("never appends a Co-authored-by trailer", async () => {
    await gitCommit({ path: "/tmp/repo", message: "no trailer" });

    const commitCall = mockExec.mock.calls.find((c) => c[0][0] === "commit");
    expect(commitCall).toBeDefined();
    const messageArg = commitCall![0][2];
    expect(messageArg).toBe("no trailer");
    expect(messageArg).not.toContain("Co-authored-by:");
  });

  it("does not read settings or git identity at all — the message is passed through verbatim", async () => {
    // Simulate a machine with NO git identity configured: no `user.email`.
    mockExec.mockImplementation(async (args: string[]) => {
      if (args[0] === "rev-parse") {
        return { exitCode: 0, stdout: "abc123\n", stderr: "" };
      }
      // No `config` call should ever happen for identity probing.
      if (args[0] === "config") {
        throw new Error("gitCommit must not probe git identity");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await gitCommit({ path: "/tmp/repo", message: "bare machine" });

    const commitCall = mockExec.mock.calls.find((c) => c[0][0] === "commit");
    expect(commitCall).toBeDefined();
    expect(commitCall![0]).toEqual(["commit", "-m", "bare machine"]);
    expect(mockExec.mock.calls.some((c) => c[0][0] === "config")).toBe(false);
  });
});
