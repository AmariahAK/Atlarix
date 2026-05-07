/**
 * PTY Utilities - v7.1.2
 * Pseudo-terminal support for interactive shell commands.
 * Inspired by OpenCode's PTY implementation.
 */

import log from "electron-log";
import * as pty from "@lydell/node-pty";
import * as os from "os";
import * as path from "path";

const logger = log.scope("pty-utils");

export interface PtyOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface PtyResult {
  output: string;
  exitCode: number;
  timedOut?: boolean;
}

export interface PtyCommandOptions {
  timeoutMs?: number;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export async function runPtyCommand(
  command: string,
  options: PtyCommandOptions = {},
): Promise<PtyResult> {
  const {
    timeoutMs = 60000,
    cols = 80,
    rows = 24,
    cwd,
    env = {},
  } = options;

  const mergedEnv = { ...process.env, ...env, CI: "true" };
  const shell = process.platform === "win32" ? "powershell.exe" : getShell();

  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        logger.warn(`PTY command timed out after ${timeoutMs}ms: ${command.slice(0, 100)}`);
      }, timeoutMs);
    }

    try {
      const ptyProc = pty.spawn(shell, ["-c", command], {
        cols,
        rows,
        cwd: cwd ?? os.homedir(),
        env: mergedEnv as Record<string, string>,
      });

      ptyProc.onData((data: string) => {
        output += data;
      });

      ptyProc.onExit((exit: { exitCode: number; signal?: number }) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        resolve({
          output,
          exitCode: exit?.exitCode ?? 0,
          timedOut,
        });
      });
    } catch (error) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("Failed to spawn PTY:", errMsg);
      resolve({
        output: `Failed to spawn PTY: ${errMsg}`,
        exitCode: 1,
        timedOut,
      });
    }
  });
}

export function killPtyProcess(pid: number): void {
  try {
    if (process.platform === "win32") {
      pty.spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { env: {} });
    } else {
      process.kill(-pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // ignore
        }
      }, 200);
    }
  } catch (error) {
    logger.warn(`Failed to kill PTY process ${pid}:`, error);
  }
}

function getShell(): string {
  const envShell = process.env.SHELL;
  if (envShell) {
    const base = path.basename(envShell);
    if (!["fish", "nu"].includes(base)) return envShell;
  }
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}