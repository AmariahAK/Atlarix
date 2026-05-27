import { describe, expect, it } from "vitest";
import {
  isGitInitCommand,
  runCommandGitInitGateResult,
} from "@/lib/git-init-command-guard";

describe("git-init-command-guard", () => {
  it("detects git init variants", () => {
    expect(isGitInitCommand("git init")).toBe(true);
    expect(isGitInitCommand("git init --bare")).toBe(true);
    expect(isGitInitCommand('git -C "/tmp/proj" init')).toBe(true);
    expect(isGitInitCommand("cd /tmp && git init")).toBe(true);
    expect(isGitInitCommand("git status")).toBe(false);
    expect(isGitInitCommand("git commit -m x")).toBe(false);
  });

  it("blocks git init unless allowGitInit is true", () => {
    expect(runCommandGitInitGateResult("git init", false)).toContain("blocked");
    expect(runCommandGitInitGateResult("git init", undefined)).toContain(
      "blocked",
    );
    expect(runCommandGitInitGateResult("git init", true)).toBeNull();
    expect(runCommandGitInitGateResult("git status", false)).toBeNull();
  });
});
