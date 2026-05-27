import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findGitRepositoryRoot,
  hasGitRepository,
  gitCommit,
  gitLog,
} from "@/ipc/utils/git_utils";

describe("git repository guard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-git-guard-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("findGitRepositoryRoot returns null when no .git exists", () => {
    expect(findGitRepositoryRoot(tmpDir)).toBeNull();
  });

  it("hasGitRepository is false for plain folders", async () => {
    await expect(hasGitRepository(tmpDir)).resolves.toBe(false);
  });

  it("gitCommit no-ops without a repository", async () => {
    const hash = await gitCommit({
      path: tmpDir,
      message: "should not run",
    });
    expect(hash).toBe("");
  });

  it("gitLog returns empty array without a repository", async () => {
    const entries = await gitLog({ path: tmpDir, depth: 10 });
    expect(entries).toEqual([]);
  });

  it("writing files does not create .git when no repository exists", async () => {
    const filePath = path.join(tmpDir, "hello.txt");
    fs.writeFileSync(filePath, "hi");
    await gitCommit({ path: tmpDir, message: "noop" });
    expect(fs.existsSync(path.join(tmpDir, ".git"))).toBe(false);
  });
});
