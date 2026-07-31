/**
 * Git remote URL parsing, shared by the renderer (clone dialog: derive a default
 * workspace name) and the main process (clone handler: validate before spawning git).
 *
 * One implementation on purpose — the two used to carry separate GitHub-only regexes,
 * which is why cloning a GitLab or self-hosted repo failed with "Invalid GitHub URL".
 *
 * MUST stay free of node imports so the renderer can import it.
 */

export interface ParsedGitRemote {
  /** Normalized scheme: "https" | "http" | "ssh" | "git" (scp-like syntax reports "ssh"). */
  scheme: "https" | "http" | "ssh" | "git";
  /** Hostname, lowercased, without port or userinfo (e.g. "github.com"). */
  host: string;
  /** Everything before the final path segment (may contain slashes: GitLab subgroups). */
  owner: string;
  /** Final path segment with any ".git" suffix removed. */
  repo: string;
  /** True for ssh:// and scp-like `user@host:path` — these need a real git binary. */
  isSsh: boolean;
  /** The URL to hand to git, trimmed and otherwise byte-identical to the input. */
  url: string;
}

/**
 * Transports we are willing to hand to `git clone`. Everything else is refused.
 *
 * The dangerous ones this deliberately excludes:
 * - `ext::` — git's external remote helper. `ext::sh -c "…"` executes arbitrary
 *   commands, so accepting it would turn "paste a repo URL" into remote code execution.
 * - `file://`, bare local paths — a clone target on the user's own disk is not what
 *   this dialog is for, and `file://` + hooks is another execution vector.
 * - anything starting with `-` — would be parsed by git as a flag, not a URL
 *   (argv injection into the clone command).
 */
const ALLOWED_SCHEMES = new Set(["https", "http", "ssh", "git"]);

export interface GitRemoteParseError {
  ok: false;
  error: string;
}

export type GitRemoteParseResult = ({ ok: true } & ParsedGitRemote) | GitRemoteParseError;

/** scp-like syntax: `[user@]host:owner/repo.git` (no scheme, colon separates host from path). */
const SCP_LIKE = /^(?:([^@/]+)@)?([^@/:]+):(.+)$/;

function splitOwnerRepo(
  pathname: string,
): { owner: string; repo: string } | null {
  const segments = pathname
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const repo = segments[segments.length - 1].replace(/\.git$/i, "");
  const owner = segments.slice(0, -1).join("/");
  if (!repo || !owner) return null;
  return { owner, repo };
}

export function parseGitRemoteUrl(raw: string): GitRemoteParseResult {
  const url = raw.trim();
  if (!url) {
    return { ok: false, error: "Enter a repository URL." };
  }
  if (url.startsWith("-")) {
    return {
      ok: false,
      error: "That does not look like a repository URL (it starts with “-”).",
    };
  }
  // Reject before any parsing so transport tricks can't sneak through a later branch.
  const schemeMatch = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*)(::|:\/\/)/);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (schemeMatch[2] === "::" || !ALLOWED_SCHEMES.has(scheme)) {
      return {
        ok: false,
        error: `Unsupported URL type “${scheme}${schemeMatch[2]}”. Use an https:// or ssh:// (git@…) repository URL.`,
      };
    }

    // URL is only safe to use once we know the scheme is one of ours.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: "That URL could not be parsed." };
    }
    const host = parsed.hostname.toLowerCase();
    if (!host) {
      return { ok: false, error: "That URL has no host." };
    }
    const ownerRepo = splitOwnerRepo(parsed.pathname);
    if (!ownerRepo) {
      return {
        ok: false,
        error: "That URL has no owner/repository path (expected …/owner/repo).",
      };
    }
    return {
      ok: true,
      scheme: scheme as ParsedGitRemote["scheme"],
      host,
      ...ownerRepo,
      isSsh: scheme === "ssh",
      url,
    };
  }

  const scp = url.match(SCP_LIKE);
  if (scp) {
    const [, , rawHost, rawPath] = scp;
    // `C:\path\to\repo` also matches scp-like syntax; a single-letter "host" is a
    // Windows drive, not a server.
    if (rawHost.length < 2) {
      return {
        ok: false,
        error: "Local paths cannot be cloned here — use an https:// or ssh:// URL.",
      };
    }
    const ownerRepo = splitOwnerRepo(rawPath);
    if (!ownerRepo) {
      return {
        ok: false,
        error: "That URL has no owner/repository path (expected host:owner/repo.git).",
      };
    }
    return {
      ok: true,
      scheme: "ssh",
      host: rawHost.toLowerCase(),
      ...ownerRepo,
      isSsh: true,
      url,
    };
  }

  return {
    ok: false,
    error: "Enter an https:// or ssh:// (git@…) repository URL.",
  };
}

/** Repository name from a URL, for prefilling the workspace name. Null when unparseable. */
export function repoNameFromUrl(raw: string): string | null {
  const parsed = parseGitRemoteUrl(raw);
  return parsed.ok ? parsed.repo : null;
}

export function isGithubHost(host: string): boolean {
  return host.toLowerCase() === "github.com";
}

/**
 * Strip userinfo from any URL inside a string: `https://TOKEN:x-oauth-basic@github.com/…`
 * → `https://github.com/…`.
 *
 * MUST be applied to every clone error before it reaches a toast, an IPC reply, or a
 * log file: the clone URL embeds the user's OAuth token and git echoes URLs in stderr.
 */
export function redactGitUrlCredentials(input: string): string {
  return input.replace(/(\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]*@/g, "$1");
}
