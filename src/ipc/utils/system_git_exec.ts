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

import { execFile, spawn } from "node:child_process";
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

export const GIT_NOT_INSTALLED_MESSAGE =
  "Git is not installed (or not on PATH). Install Git — on macOS run `xcode-select --install` — to enable version control features.";

/** Exit 127 is exec()'s sentinel for "no usable git binary" (see above). */
export function isGitMissingResult(result: IGitResult): boolean {
  return result.exitCode === 127;
}

let gitAvailabilityProbe: Promise<boolean> | null = null;

/** Cached probe: does a usable git binary exist (PATH or LOCAL_GIT_DIRECTORY)? */
export function isGitAvailable(): Promise<boolean> {
  if (!gitAvailabilityProbe) {
    gitAvailabilityProbe = exec(["--version"], ".").then(
      (result) => result.exitCode === 0,
    );
  }
  return gitAvailabilityProbe;
}

export function resetGitAvailabilityCacheForTests(): void {
  gitAvailabilityProbe = null;
}

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

/**
 * Streaming variant of `exec` for long-running commands whose stderr carries progress
 * (`git clone --progress`). Same contract as `exec`: never rejects, resolves exit 127
 * with `GIT_NOT_INSTALLED_MESSAGE` when no git binary exists.
 *
 * `onStderrLine` is called per line AND per `\r`-delimited chunk, because git rewrites
 * its progress counters with carriage returns rather than newlines.
 */
export function execStreaming(
  args: string[],
  cwd: string,
  options?: IGitExecutionOptions & { onStderrLine?: (line: string) => void },
): Promise<IGitResult> {
  const { gitPath, extraEnv } = resolveGitBinary();
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(gitPath, args, {
        cwd,
        env: { ...process.env, ...extraEnv, ...options?.env } as NodeJS.ProcessEnv,
        signal: options?.signal,
        windowsHide: true,
      });
    } catch {
      resolve({ exitCode: 127, stdout: "", stderr: GIT_NOT_INSTALLED_MESSAGE });
      return;
    }

    let stdout = "";
    let stderr = "";
    let pending = "";
    let settled = false;
    const settle = (result: IGitResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (!options?.onStderrLine) return;
      pending += chunk;
      const parts = pending.split(/\r\n|\r|\n/);
      pending = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.trim();
        if (line) options.onStderrLine(line);
      }
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        settle({ exitCode: 127, stdout: "", stderr: GIT_NOT_INSTALLED_MESSAGE });
        return;
      }
      // Aborted via signal, or spawn failure: surface a code, never reject.
      settle({ exitCode: 1, stdout, stderr: stderr || error.message });
    });

    child.on("close", (code, signal) => {
      if (options?.onStderrLine && pending.trim()) {
        options.onStderrLine(pending.trim());
      }
      settle({
        exitCode: code ?? (signal ? 1 : 0),
        stdout,
        stderr,
      });
    });
  });
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
