import { afterEach, describe, it, expect } from "vitest";
import {
  ATLARIX_CO_AUTHOR_TRAILER,
  ATLARIX_GIT_AUTHOR_EMAIL,
  ATLARIX_GIT_AUTHOR_NAME,
  getGitAuthor,
  gitAuthorNameForModel,
  injectAgentGitIdentity,
} from "@/ipc/utils/git_author";
import {
  clearActiveModelDisplayName,
  setActiveModelDisplayName,
} from "@/ipc/utils/active-model-identity";

afterEach(() => {
  clearActiveModelDisplayName();
});

describe("getGitAuthor", () => {
  it("returns canonical atlarix-agent identity when no stream is active", async () => {
    const author = await getGitAuthor();
    expect(author).toEqual({
      name: ATLARIX_GIT_AUTHOR_NAME,
      email: ATLARIX_GIT_AUTHOR_EMAIL,
    });
    expect(author.name).toBe("atlarix-agent");
    expect(author.email).toBe("agent@atlarix.dev");
    expect(author.name).not.toContain("[atlarix]");
  });

  it("uses '<Model> agent' while a stream's model identity is active", async () => {
    setActiveModelDisplayName("DeepSeek V4");
    const author = await getGitAuthor();
    expect(author).toEqual({
      name: "DeepSeek V4 agent",
      email: ATLARIX_GIT_AUTHOR_EMAIL,
    });
  });

  it("falls back to atlarix-agent after the identity is cleared", async () => {
    setActiveModelDisplayName("Claude Opus 4.8");
    clearActiveModelDisplayName();
    const author = await getGitAuthor();
    expect(author.name).toBe(ATLARIX_GIT_AUTHOR_NAME);
  });
});

describe("gitAuthorNameForModel", () => {
  it("formats '<Model> agent'", () => {
    expect(gitAuthorNameForModel("GPT-5.2")).toBe("GPT-5.2 agent");
  });
  it("falls back to atlarix-agent for empty/blank names", () => {
    expect(gitAuthorNameForModel(undefined)).toBe(ATLARIX_GIT_AUTHOR_NAME);
    expect(gitAuthorNameForModel("   ")).toBe(ATLARIX_GIT_AUTHOR_NAME);
    expect(gitAuthorNameForModel(null)).toBe(ATLARIX_GIT_AUTHOR_NAME);
  });
});

describe("injectAgentGitIdentity", () => {
  it("injects -c identity flags into bare git commit", () => {
    const out = injectAgentGitIdentity('git commit -m "fix"', "DeepSeek V4");
    expect(out).toBe(
      `git -c user.name="DeepSeek V4 agent" -c user.email="agent@atlarix.dev" commit -m "fix"`,
    );
  });

  it("handles compound commands (add && commit)", () => {
    const out = injectAgentGitIdentity(
      'git add -A && git commit -m "feat: x"',
      "Claude Opus",
    );
    expect(out).toBe(
      `git add -A && git -c user.name="Claude Opus agent" -c user.email="agent@atlarix.dev" commit -m "feat: x"`,
    );
  });

  it("does not touch commands that already set an author", () => {
    const explicit = 'git commit --author="Someone <s@e.dev>" -m "x"';
    expect(injectAgentGitIdentity(explicit, "DeepSeek V4")).toBe(explicit);
    const configured = 'git -c user.name="x" commit -m "y"';
    expect(injectAgentGitIdentity(configured, "DeepSeek V4")).toBe(configured);
  });

  it("does not touch non-commit git commands", () => {
    expect(injectAgentGitIdentity("git status", "DeepSeek V4")).toBe("git status");
    expect(injectAgentGitIdentity("npm test", "DeepSeek V4")).toBe("npm test");
  });

  it("sanitizes shell-hostile characters out of the model name", () => {
    const out = injectAgentGitIdentity(
      'git commit -m "x"',
      'Evil"$(rm -rf /)`name',
    );
    expect(out).not.toContain("$(");
    expect(out).not.toContain("`");
    expect(out).toContain('-c user.name="Evil(rm -rf /)name agent"');
  });

  it("uses the active stream identity when no explicit name is given", () => {
    setActiveModelDisplayName("Gemini 3 Pro");
    const out = injectAgentGitIdentity('git commit -m "x"');
    expect(out).toContain('user.name="Gemini 3 Pro agent"');
  });

  it("uses atlarix-agent when no model identity is active", () => {
    const out = injectAgentGitIdentity('git commit -m "x"');
    expect(out).toContain('user.name="atlarix-agent"');
  });
});

describe("ATLARIX_CO_AUTHOR_TRAILER", () => {
  it("matches author name and email", () => {
    expect(ATLARIX_CO_AUTHOR_TRAILER).toBe(
      "Co-authored-by: atlarix-agent <agent@atlarix.dev>",
    );
  });
});
