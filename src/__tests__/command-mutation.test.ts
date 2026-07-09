/**
 * isMutatingCommand — the read-only-mode backstop. Compound-aware DENY detector
 * for source/repo/system mutations; reads/dev/build/test/installs are NOT
 * mutating (allowed in Explore/Plan/Review). Closes the old `cd x && git push`
 * bypass that slipped through classifyTerminalCommand.
 */
import { describe, it, expect } from "vitest";
import { isMutatingCommand } from "@/lib/command-mutation";

describe("isMutatingCommand — allowed in read-only modes (not mutating)", () => {
  it.each([
    "ls -la",
    "cat package.json",
    "grep -r foo src",
    "git status",
    "git log --oneline -5",
    "git diff HEAD~1",
    "git show",
    "npm run dev",
    "cd Telios_Frontend && npm run dev",
    "npm test",
    "npm run build",
    "npm install",
    "npm ci",
    "pnpm install",
    "pip install -r requirements.txt",
    "yarn add lodash",
    "npx tsc --noEmit",
    "curl https://example.com",
    "node -e \"console.log(1)\"",
    // Branch navigation is read-safe (allowed in read-only modes).
    "git checkout main",
    "git checkout feature/new-thing",
    "git switch main",
    "git switch -c feature/x",
  ])("not mutating: %s", (cmd) => {
    expect(isMutatingCommand(cmd)).toBe(false);
  });
});

describe("isMutatingCommand — blocked in read-only modes (mutating)", () => {
  it.each([
    "git add .",
    "git commit -m wip",
    "git push origin main",
    "git reset --hard",
    "git checkout -- .",
    "git checkout .",
    "git checkout -- src/file.ts",
    "git clean -fd",
    "git stash drop",
    "rm file.txt",
    "rm -rf dist",
    "rmdir build",
    "mv a b",
    "cp a b",
    "chmod +x run.sh",
    "chown me file",
    "kill 1234",
    "sudo apt-get update",
    "npm publish",
    "yarn version",
    "docker build .",
    "vercel deploy",
    "terraform apply",
  ])("mutating: %s", (cmd) => {
    expect(isMutatingCommand(cmd)).toBe(true);
  });

  it("compound: a mutating segment behind a benign prefix is caught", () => {
    expect(isMutatingCommand("cd app && git push")).toBe(true);
    expect(isMutatingCommand("npm run build && rm -rf cache")).toBe(true);
    expect(isMutatingCommand("git status; git commit -m x")).toBe(true);
    expect(isMutatingCommand("echo hi | grep h")).toBe(false);
  });

  it("background `&`: a mutating segment after a single & is caught (H-3)", () => {
    // `a & b` runs BOTH sides — the mutating half must not hide behind a benign
    // first segment. `&&` must still behave exactly as before.
    expect(isMutatingCommand("true & git push origin main")).toBe(true);
    expect(isMutatingCommand("echo ok & npm publish")).toBe(true);
    expect(isMutatingCommand("echo ok &git commit -m x")).toBe(true);
    expect(isMutatingCommand("true && echo done")).toBe(false); // && unaffected
    expect(isMutatingCommand("echo a & echo b")).toBe(false); // both benign
  });
});

describe("commandSegments — single & is a separator, && is not", () => {
  it("splits a standalone & but preserves &&", async () => {
    const { commandSegments } = await import("@/lib/command-mutation");
    expect(commandSegments("a & b")).toEqual(["a", "b"]);
    expect(commandSegments("a &b")).toEqual(["a", "b"]);
    expect(commandSegments("a && b")).toEqual(["a", "b"]);
    expect(commandSegments("echo ok & git push")).toEqual(["echo ok", "git push"]);
    // trailing background operator yields no empty phantom segment
    expect(commandSegments("sleep 1 &")).toEqual(["sleep 1"]);
  });
});
