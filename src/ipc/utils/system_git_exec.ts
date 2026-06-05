/**
 * System-git `exec` — drop-in replacement for dugite's `exec` (v11: the 142MB
 * bundled git was removed; we shell out to the git on PATH instead).
 *
 * Honors `LOCAL_GIT_DIRECTORY` (set by `configureGitEnvironment` in main.ts
 * when a bundled git is present, e.g. E2E builds with ATLARIX_BUNDLE_GIT=1)
 * with dugite's directory layout, so existing escape hatches keep working.
 *
 * Like dugite, this never rejects on non-zero git exits — callers branch on
 * `exitCode`. A missing git binary resolves to exit 127 with an actionable
 * message instead of throwing ENOENT.
 */

import { execFile } from "node:child_process";
import path from "node:path";

export interface IGitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface IGitExecutionOptions {
  /** Merged over the inherited process env (dugite semantics). */
  env?: Record<string, string | undefined>;
  /** Abort the git process (e.g. long clones). */
  signal?: AbortSignal;
}

const GIT_NOT_INSTALLED_MESSAGE =
  "Git is not installed (or not on PATH). Install Git — on macOS run `xcode-select --install` — to enable version control features.";

function resolveGitBinary(): { gitPath: string; extraEnv: Record<string, string> } {
  const local = process.env.LOCAL_GIT_DIRECTORY?.trim();
  if (local) {
    if (process.platform === "win32") {
      return {
        gitPath: path.join(local, "cmd", "git.exe"),
        extraEnv: {
          GIT_EXEC_PATH: path.join(local, "mingw64", "libexec", "git-core"),
        },
      };
    }
    return {
      gitPath: path.join(local, "bin", "git"),
      extraEnv: {
        GIT_EXEC_PATH: path.join(local, "libexec", "git-core"),
      },
    };
  }
  return { gitPath: "git", extraEnv: {} };
}

export function exec(
  args: string[],
  cwd: string,
  options?: IGitExecutionOptions,
): Promise<IGitResult> {
  const { gitPath, extraEnv } = resolveGitBinary();
  return new Promise((resolve) => {
    execFile(
      gitPath,
      args,
      {
        cwd,
        encoding: "utf8",
        // git log/show output on large repos can be hefty.
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...extraEnv, ...options?.env } as NodeJS.ProcessEnv,
        signal: options?.signal,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as NodeJS.ErrnoException & { code?: string | number };
          if (err.code === "ENOENT") {
            resolve({
              exitCode: 127,
              stdout: "",
              stderr: GIT_NOT_INSTALLED_MESSAGE,
            });
            return;
          }
          // Killed (abort signal) or non-zero exit: surface code, never reject
          // (dugite semantics — callers branch on exitCode).
          const exitCode = typeof err.code === "number" ? err.code : 1;
          resolve({
            exitCode,
            stdout: stdout ?? "",
            stderr: stderr || err.message || "",
          });
          return;
        }
        resolve({ exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}
