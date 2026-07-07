import { describe, expect, it } from "vitest";
import {
  isSystemScopeCommand,
  getSystemScopeExplanation,
  systemScopeLabel,
} from "@/lib/system-scope-commands";

const WS = "/Users/me/project";

describe("system-scope-commands — on-device installs", () => {
  it("flags package / toolchain installers", () => {
    for (const cmd of [
      "brew install ripgrep",
      "sudo apt-get install nginx",
      "apt install cowsay",
      "dnf install gcc",
      "pacman -S neovim",
      "rustup default stable",
      "cargo install ripgrep",
      "npm install -g typescript",
      "pnpm add --global vite",
      "yarn global add eslint",
      "pipx install black",
      "pip install --user requests",
      "gem install bundler",
      "go install golang.org/x/tools/gopls@latest",
      "choco install git",
      "winget install Git.Git",
      "asdf install nodejs 20",
    ]) {
      expect(isSystemScopeCommand(cmd, WS), cmd).toBe(true);
    }
  });

  it("does NOT flag ordinary in-project commands", () => {
    for (const cmd of [
      "npm install",
      "npm install lodash",
      "npm run build",
      "pip install -r requirements.txt",
      "cargo build",
      "go build ./...",
      "ls -la",
      "cat package.json",
      "git status",
      "python3 manage.py test",
    ]) {
      expect(isSystemScopeCommand(cmd, WS), cmd).toBe(false);
    }
  });

  it("catches an installer hidden behind a benign prefix (compound)", () => {
    expect(isSystemScopeCommand("echo hi && brew install jq", WS)).toBe(true);
    expect(isSystemScopeCommand("cd sub && sudo rm -rf /tmp/x", WS)).toBe(true);
  });
});

describe("system-scope-commands — outside-workspace paths", () => {
  it("flags cd / redirection escaping the workspace", () => {
    expect(isSystemScopeCommand("cd /etc && cat hosts", WS)).toBe(true);
    expect(isSystemScopeCommand("echo x > /usr/local/bin/thing", WS)).toBe(true);
    expect(isSystemScopeCommand("echo x >> ~/.zshrc", WS)).toBe(true);
  });

  it("does NOT flag cd / writes that stay inside the workspace", () => {
    expect(isSystemScopeCommand("cd /Users/me/project/sub && ls", WS)).toBe(false);
    expect(isSystemScopeCommand("echo x > ./out.txt", WS)).toBe(false);
    expect(isSystemScopeCommand("cat /etc/hosts", WS)).toBe(false); // read, not a write/cd
  });
});

describe("system-scope-commands — explanation + label", () => {
  it("gives a descriptive explanation", () => {
    expect(getSystemScopeExplanation("brew install jq", WS)).toMatch(/Homebrew/);
    expect(getSystemScopeExplanation("echo x > ~/.zshrc", WS)).toMatch(/OUTSIDE this project/);
    expect(getSystemScopeExplanation("ls", WS)).toBeTruthy();
  });

  it("labels for logging, null when not system-scope", () => {
    expect(systemScopeLabel("brew install jq", WS)).toMatch(/^system-scope:/);
    expect(systemScopeLabel("npm run build", WS)).toBeNull();
  });
});
