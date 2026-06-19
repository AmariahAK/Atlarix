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

  it("allows git init by default; blocks only when allowGitInit is explicitly false", () => {
    // v13.8: allowed by default (undefined/true) — run_command approval covers it.
    expect(runCommandGitInitGateResult("git init", undefined)).toBeNull();
    expect(runCommandGitInitGateResult("git init", true)).toBeNull();
    // Explicit opt-out still blocks.
    expect(runCommandGitInitGateResult("git init", false)).toContain("disabled");
    // Non-init git commands are never gated.
    expect(runCommandGitInitGateResult("git status", false)).toBeNull();
  });
});
