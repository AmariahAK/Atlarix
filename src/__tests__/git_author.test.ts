import { describe, it, expect } from "vitest";
import {
  ATLARIX_CO_AUTHOR_TRAILER,
  ATLARIX_GIT_AUTHOR_EMAIL,
  ATLARIX_GIT_AUTHOR_NAME,
  getGitAuthor,
  injectAgentGitIdentity,
} from "@/ipc/utils/git_author";

describe("getGitAuthor", () => {
  it("returns the canonical atlarix-agent identity, never a model name", async () => {
    const author = await getGitAuthor();
    expect(author).toEqual({
      name: ATLARIX_GIT_AUTHOR_NAME,
      email: ATLARIX_GIT_AUTHOR_EMAIL,
    });
    expect(author.name).toBe("atlarix-agent");
    expect(author.email).toBe("agent@atlarix.dev");
    expect(author.name).not.toContain("agent agent");
  });
});

describe("injectAgentGitIdentity", () => {
  it("injects the agent identity into a bare git commit", () => {
    const out = injectAgentGitIdentity('git commit -m "fix"');
    expect(out).toBe(
      `git -c user.name="atlarix-agent" -c user.email="agent@atlarix.dev" commit -m "fix"`,
    );
  });

  it("handles compound commands (add && commit)", () => {
    const out = injectAgentGitIdentity('git add -A && git commit -m "feat: x"');
    expect(out).toBe(
      `git add -A && git -c user.name="atlarix-agent" -c user.email="agent@atlarix.dev" commit -m "feat: x"`,
    );
  });

  it("does not touch commands that already set an author", () => {
    const explicit = 'git commit --author="Someone <s@e.dev>" -m "x"';
    expect(injectAgentGitIdentity(explicit)).toBe(explicit);
    const configured = 'git -c user.name="x" commit -m "y"';
    expect(injectAgentGitIdentity(configured)).toBe(configured);
  });

  it("does not touch non-commit git commands", () => {
    expect(injectAgentGitIdentity("git status")).toBe("git status");
    expect(injectAgentGitIdentity("npm test")).toBe("npm test");
  });
});

describe("ATLARIX_CO_AUTHOR_TRAILER", () => {
  it("matches author name and email", () => {
    expect(ATLARIX_CO_AUTHOR_TRAILER).toBe(
      "Co-authored-by: atlarix-agent <agent@atlarix.dev>",
    );
  });
});
