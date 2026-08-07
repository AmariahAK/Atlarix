/**
 * Shared shell resolution — used by piped command execution
 * (runShellCommand) and the interactive PTY terminal (v10).
 */

import { execSync } from "child_process";
import path from "path";
import fs from "fs";

/** Shells that may behave differently with -c (e.g. fish/nu); use fallback for consistency. */
const SHELL_BLACKLIST = new Set(["fish", "nu"]);

/**
 * Find Git-for-Windows' bash, wherever git actually is.
 *
 * This used to hardcode `%ProgramFiles%\Git\bin\bash.exe` — the winget/installer
 * default and nothing else. A scoop, chocolatey, portable, or 32-bit install put
 * git somewhere else, so bash was silently not found and the agent quietly got
 * `cmd.exe` instead. Which shell you get should not depend on how you installed git.
 *
 * So locate `git` on PATH and derive bash relative to it: Git for Windows ships
 * `<root>\cmd\git.exe` and `<root>\bin\git.exe` alongside `<root>\bin\bash.exe`.
 * Falls back to the well-known install roots, then to COMSPEC.
 */
function resolveWindowsShell(): string {
  const candidates: string[] = [];

  try {
    // `where` prints one path per line; the first is what a command would resolve to.
    const found = execSync("where git", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const gitExe of found) {
      // <root>\cmd\git.exe or <root>\bin\git.exe  ->  <root>\bin\bash.exe
      const root = path.win32.dirname(path.win32.dirname(gitExe));
      candidates.push(path.win32.join(root, "bin", "bash.exe"));
    }
  } catch {
    // `where` fails when git isn't on PATH — fall through to the known roots.
  }

  for (const envVar of ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]) {
    const base = process.env[envVar];
    if (base) candidates.push(path.win32.join(base, "Git", "bin", "bash.exe"));
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* unreadable candidate — try the next */
    }
  }
  return process.env.COMSPEC || "cmd.exe";
}

/**
 * Resolve shell executable (opencode-style): prefer process.env.SHELL, else platform default.
 * Ensures same shell as user's terminal where possible (e.g. /bin/zsh on darwin).
 */
export function getAcceptableShell(): string {
  const envShell = process.env.SHELL;
  if (envShell) {
    const base =
      process.platform === "win32"
        ? path.win32.basename(envShell)
        : path.basename(envShell);
    if (!SHELL_BLACKLIST.has(base)) return envShell;
  }
  if (process.platform === "darwin") return "/bin/zsh";
  if (process.platform === "win32") return resolveWindowsShell();
  // Linux: prefer bash, else sh
  try {
    const bash = execSync("which bash 2>/dev/null", { encoding: "utf8" }).trim();
    if (bash) return bash;
  } catch {
    // ignore
  }
  return "/bin/sh";
}

/**
 * Interactive shell for the PTY terminal. Unlike piped command execution we
 * don't blacklist fish/nu — interactive use is exactly where users want their
 * own shell. Windows prefers PowerShell over cmd for a usable interactive UX.
 */
export function getInteractiveShell(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: process.env.COMSPEC?.includes("powershell")
      ? process.env.COMSPEC
      : "powershell.exe", args: [] };
  }
  const envShell = process.env.SHELL;
  const file = envShell || getAcceptableShell();
  // Login shell so user rc files (PATH, aliases, completions) load.
  return { file, args: ["-l"] };
}
