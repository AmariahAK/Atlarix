/**
 * Clone URL parsing: any git host is accepted, dangerous transports are refused, and
 * credentials never survive into a message we might show or log.
 *
 * The GitHub-only regexes this replaced rejected GitLab/self-hosted URLs as
 * "Invalid GitHub URL" and silently rewrote SSH URLs to HTTPS.
 */

import { describe, it, expect } from "vitest";
import {
  parseGitRemoteUrl,
  repoNameFromUrl,
  isGithubHost,
  redactGitUrlCredentials,
} from "@/shared/git_remote_url";

describe("parseGitRemoteUrl — accepted forms", () => {
  it("parses a GitHub HTTPS URL", () => {
    const result = parseGitRemoteUrl("https://github.com/mementobuilds/tap-flash-poc");
    expect(result).toMatchObject({
      ok: true,
      scheme: "https",
      host: "github.com",
      owner: "mementobuilds",
      repo: "tap-flash-poc",
      isSsh: false,
    });
  });

  it("strips a .git suffix and a trailing slash", () => {
    expect(parseGitRemoteUrl("https://github.com/org/repo.git/")).toMatchObject({
      ok: true,
      repo: "repo",
    });
  });

  it("parses a GitLab URL with subgroups", () => {
    expect(parseGitRemoteUrl("https://gitlab.com/group/sub/proj.git")).toMatchObject({
      ok: true,
      host: "gitlab.com",
      owner: "group/sub",
      repo: "proj",
    });
  });

  it("parses a self-hosted host with a port", () => {
    expect(parseGitRemoteUrl("https://git.example.dev:8443/team/api.git")).toMatchObject({
      ok: true,
      host: "git.example.dev",
      owner: "team",
      repo: "api",
    });
  });

  it("parses scp-like SSH syntax and reports it as SSH", () => {
    expect(parseGitRemoteUrl("git@github.com:org/repo.git")).toMatchObject({
      ok: true,
      scheme: "ssh",
      host: "github.com",
      owner: "org",
      repo: "repo",
      isSsh: true,
    });
  });

  it("parses ssh:// URLs", () => {
    expect(parseGitRemoteUrl("ssh://git@git.example.dev:2222/team/api.git")).toMatchObject({
      ok: true,
      scheme: "ssh",
      host: "git.example.dev",
      isSsh: true,
    });
  });

  it("preserves the URL verbatim so SSH is never rewritten", () => {
    const url = "git@github.com:org/repo.git";
    const result = parseGitRemoteUrl(url);
    expect(result.ok && result.url).toBe(url);
  });
});

describe("parseGitRemoteUrl — refused forms", () => {
  it("refuses ext:: (git's remote helper runs arbitrary commands)", () => {
    const result = parseGitRemoteUrl('ext::sh -c "id > /tmp/pwned"');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/Unsupported URL type/);
  });

  it("refuses file://", () => {
    expect(parseGitRemoteUrl("file:///etc/passwd").ok).toBe(false);
  });

  it("refuses a leading dash (argv injection into git clone)", () => {
    expect(parseGitRemoteUrl("--upload-pack=touch /tmp/x").ok).toBe(false);
  });

  it("refuses a Windows drive path mistaken for scp syntax", () => {
    expect(parseGitRemoteUrl("C:/Users/me/repo").ok).toBe(false);
  });

  it("refuses a URL with no owner/repo path", () => {
    expect(parseGitRemoteUrl("https://github.com/org").ok).toBe(false);
  });

  it("refuses empty input and plain words", () => {
    expect(parseGitRemoteUrl("   ").ok).toBe(false);
    expect(parseGitRemoteUrl("my-repo").ok).toBe(false);
  });
});

describe("repoNameFromUrl", () => {
  it("returns the repo name for any host", () => {
    expect(repoNameFromUrl("https://gitlab.com/group/sub/proj.git")).toBe("proj");
    expect(repoNameFromUrl("git@github.com:org/repo.git")).toBe("repo");
  });

  it("returns null when unparseable", () => {
    expect(repoNameFromUrl("nonsense")).toBeNull();
  });
});

describe("isGithubHost", () => {
  it("matches only github.com", () => {
    expect(isGithubHost("github.com")).toBe(true);
    expect(isGithubHost("GitHub.com")).toBe(true);
    expect(isGithubHost("gitlab.com")).toBe(false);
    // Look-alike host that must never be treated as GitHub (would attach the token).
    expect(isGithubHost("github.com.evil.dev")).toBe(false);
  });
});

describe("redactGitUrlCredentials", () => {
  it("removes an embedded OAuth token", () => {
    const stderr =
      "remote: Invalid credentials\nfatal: could not read from 'https://ghp_SECRET123:x-oauth-basic@github.com/org/repo.git/'";
    const redacted = redactGitUrlCredentials(stderr);
    expect(redacted).not.toContain("ghp_SECRET123");
    expect(redacted).not.toContain("x-oauth-basic");
    expect(redacted).toContain("https://github.com/org/repo.git");
  });

  it("redacts every occurrence", () => {
    const redacted = redactGitUrlCredentials(
      "https://a:b@github.com/x/y.git and https://c:d@gitlab.com/x/y.git",
    );
    expect(redacted).toBe("https://github.com/x/y.git and https://gitlab.com/x/y.git");
  });

  it("leaves credential-free text untouched", () => {
    const clean = "fatal: repository 'https://github.com/org/repo.git' not found";
    expect(redactGitUrlCredentials(clean)).toBe(clean);
  });
});
