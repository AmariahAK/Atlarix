/**
 * System-scope command detection
 * ==============================
 * A command is "system-scope" when it changes things OUTSIDE the current project:
 * on-device package/toolchain installs (brew/apt/rustup/npm -g/cargo install/…),
 * privilege escalation (sudo), or writes to a path outside the workspace root.
 *
 * This is a DISTINCT approval class from "dangerous" (destructive) — a system-scope
 * command is surfaced with a clear "this changes your system outside the project"
 * prompt and is NEVER silently auto-allowed by a first-token always-allow rule.
 * It is the harness-side gate that makes even a careless model unable to install
 * system tools / write outside the project without the user seeing exactly what.
 *
 * The install label map is best-effort UX text (device- and language-specific);
 * the real enforcement boundary is the per-OS write-confining sandbox
 * (see lib/sandbox/wrap-command.ts). This module drives the ASK, not the boundary.
 *
 * Mirrors the shape of dangerous-commands.ts (per-segment matching via
 * commandSegments so a benign prefix like `cd x && brew install y` can't hide it).
 */

import path from "node:path";
import os from "node:os";
import { commandSegments } from "./command-segments";

interface SystemScopeMatch {
  id: string;
  pattern: RegExp;
  explanation: string;
}

/**
 * On-device install / toolchain / privilege commands. Each writes OUTSIDE the
 * project by nature (Homebrew cellar, ~/.cargo, global npm prefix, system dirs).
 * Extensible + best-effort — the sandbox catches anything not listed here.
 */
const SYSTEM_SCOPE_PATTERNS: SystemScopeMatch[] = [
  {
    id: "sudo",
    pattern: /^sudo\b/,
    explanation: "runs with elevated privileges (sudo) — it can modify system files anywhere.",
  },
  {
    id: "brew",
    pattern: /^brew\s+(install|uninstall|reinstall|upgrade|tap|link|unlink|pin)\b/,
    explanation: "changes Homebrew packages under /opt/homebrew or /usr/local (outside the project).",
  },
  {
    id: "apt",
    pattern: /^(apt|apt-get)\s+(install|remove|purge|upgrade|full-upgrade)\b/,
    explanation: "installs/removes system packages via apt (outside the project).",
  },
  {
    id: "rpm-pkg",
    pattern: /^(dnf|yum|zypper)\s+(install|remove|erase|update|upgrade)\b/,
    explanation: "installs/removes system packages (outside the project).",
  },
  {
    id: "pacman",
    pattern: /^pacman\s+-[SRU]/,
    explanation: "installs/removes system packages via pacman (outside the project).",
  },
  {
    id: "apk",
    pattern: /^apk\s+(add|del)\b/,
    explanation: "installs/removes Alpine system packages (outside the project).",
  },
  {
    id: "snap-flatpak",
    pattern: /^(snap|flatpak)\s+(install|remove|uninstall)\b/,
    explanation: "installs/removes a system-wide app (outside the project).",
  },
  {
    id: "rustup",
    pattern: /^rustup\b/,
    explanation: "changes your Rust toolchain under ~/.rustup and ~/.cargo (outside the project).",
  },
  {
    id: "cargo-install",
    pattern: /^cargo\s+(install|uninstall)\b/,
    explanation: "installs/removes a binary in ~/.cargo/bin (outside the project).",
  },
  {
    id: "npm-global",
    pattern: /^(npm|pnpm)\b.*\s(-g|--global)(\s|$)/,
    explanation: "installs a GLOBAL npm package outside the project.",
  },
  {
    id: "yarn-global",
    pattern: /^yarn\s+global\s+(add|remove)\b/,
    explanation: "installs a global yarn package outside the project.",
  },
  {
    id: "bun-global",
    pattern: /^bun\s+(add|install)\b.*\s(-g|--global)(\s|$)/,
    explanation: "installs a global bun package outside the project.",
  },
  {
    id: "pipx",
    pattern: /^pipx\s+(install|uninstall|upgrade|reinstall)\b/,
    explanation: "installs/removes a Python app via pipx (outside the project).",
  },
  {
    id: "pip-user",
    pattern: /^pip3?\s+install\b.*\s--user(\s|$)/,
    explanation: "installs a Python package into ~/.local (outside the project).",
  },
  {
    id: "gem-install",
    pattern: /^gem\s+(install|uninstall|update)\b/,
    explanation: "installs/removes a system Ruby gem (outside the project).",
  },
  {
    id: "go-install",
    pattern: /^go\s+install\b/,
    explanation: "installs a Go binary into ~/go/bin (outside the project).",
  },
  {
    id: "windows-pkg",
    pattern: /^(choco|winget|scoop)\s+(install|uninstall|upgrade)\b/i,
    explanation: "installs/removes a system package on Windows (outside the project).",
  },
  {
    id: "version-manager",
    pattern: /^(asdf|sdk|nvm|pyenv|rbenv)\s+(install|uninstall|use|global)\b/,
    explanation: "changes a language version manager's toolchain (outside the project).",
  },
];

/** Expand a leading `~` to the home dir so path resolution is honest. */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** True when `target` (absolute) resolves outside `workspaceRoot`. */
function isOutsideWorkspace(target: string, workspaceRoot: string): boolean {
  const rel = path.relative(path.resolve(workspaceRoot), path.resolve(target));
  return rel.startsWith("..") || path.isAbsolute(rel);
}

/**
 * Does the command target a path OUTSIDE the workspace via a `cd <abs>` or a
 * redirection (`> /abs`, `>> ~/x`)? Run against the FULL command (not the
 * cd-stripped segments — commandSegments removes leading `cd DIR` prefixes).
 * These are the write-enabling outside-path cases; plain reads of an absolute
 * path are intentionally NOT flagged (the sandbox permits reads and this gate is
 * about CHANGING things outside the project).
 */
function targetsOutsideWorkspace(command: string, workspaceRoot: string): boolean {
  // Without a workspace root we can't judge "outside" — fall back to installer/
  // sudo detection only (callers that lack the root, e.g. the always-allow gate,
  // pass ""). Callers with the root (interceptor, UI enrich) get the full check.
  if (!workspaceRoot) return false;
  // `cd <abs-or-~>` that escapes the workspace (mirrors interceptor.ts widening).
  const cd = command.match(/(?:^|[\s;&|])cd\s+(~?\/[^\s;&|]+|~)(?:\s|$|[;&|])/);
  if (cd?.[1] && isOutsideWorkspace(expandHome(cd[1]), workspaceRoot)) return true;
  // Redirection write to an absolute / home path outside the workspace. Special
  // device sinks (`/dev/null`, `/dev/stderr`, `2>&1` targets, etc.) are no-op
  // "writes" — a `grep … 2>/dev/null` is a plain read, not a system change, so
  // they must NOT be flagged system-scope (which would run it unsandboxed).
  const redir = command.match(/>>?\s*("?)(~?\/[^\s;&|"']+)\1/);
  if (
    redir?.[2] &&
    !/^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(redir[2]) &&
    isOutsideWorkspace(expandHome(redir[2]), workspaceRoot)
  ) {
    return true;
  }
  return false;
}

/** Match id(s) for a system-scope command, or [] when it isn't system-scope. */
function getSystemScopeMatchIds(command: string, workspaceRoot: string): string[] {
  const trimmed = (command || "").trim();
  if (!trimmed) return [];
  const ids = new Set<string>();
  // Installer/toolchain patterns: per stripped segment (sees `brew` behind `cd x &&`).
  for (const seg of commandSegments(trimmed)) {
    for (const { id, pattern } of SYSTEM_SCOPE_PATTERNS) {
      if (pattern.test(seg)) ids.add(id);
    }
  }
  // Outside-path (cd/redirection): against the full command (cd isn't stripped there).
  if (targetsOutsideWorkspace(trimmed, workspaceRoot)) ids.add("outside-workspace-path");
  return [...ids].sort();
}

/**
 * True when a run_command would change things OUTSIDE the current project — an
 * on-device install/toolchain change, `sudo`, or a write to a path outside the
 * workspace. `workspaceRoot` anchors the outside-path check.
 */
export function isSystemScopeCommand(command: string, workspaceRoot: string): boolean {
  return getSystemScopeMatchIds(command, workspaceRoot).length > 0;
}

/** Plain-English "why this touches your system" for the approval card. */
export function getSystemScopeExplanation(command: string, workspaceRoot: string): string {
  const trimmed = (command || "").trim();
  if (!trimmed) return "";
  for (const seg of commandSegments(trimmed)) {
    const match = SYSTEM_SCOPE_PATTERNS.find(({ pattern }) => pattern.test(seg));
    if (match) return `This ${match.explanation}`;
  }
  if (targetsOutsideWorkspace(trimmed, workspaceRoot)) {
    return "This writes to a location OUTSIDE this project.";
  }
  return "This changes something outside the current project.";
}

/** First-token category (for logs/keys) — parallels dangerous-commands. */
export function systemScopeLabel(command: string, workspaceRoot: string): string | null {
  const ids = getSystemScopeMatchIds(command, workspaceRoot);
  return ids.length ? `system-scope:${ids.join("+")}` : null;
}
