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
  if (process.platform === "win32") {
    const git = process.env["ProgramFiles"]
      ? path.join(process.env["ProgramFiles"], "Git", "bin", "bash.exe")
      : null;
    if (git && fs.existsSync(git)) return git;
    return process.env.COMSPEC || "cmd.exe";
  }
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
