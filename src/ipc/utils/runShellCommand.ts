import { spawn, execSync } from "child_process";
import path from "path";
import fs from "fs";
import log from "electron-log";

const logger = log.scope("runShellCommand");

/** Shells that may behave differently with -c (e.g. fish/nu); use fallback for consistency. */
const SHELL_BLACKLIST = new Set(["fish", "nu"]);

/**
 * Resolve shell executable (opencode-style): prefer process.env.SHELL, else platform default.
 * Ensures same shell as user's terminal where possible (e.g. /bin/zsh on darwin).
 */
function getAcceptableShell(): string {
  const envShell = process.env.SHELL;
  if (envShell) {
    const base = process.platform === "win32" ? path.win32.basename(envShell) : path.basename(envShell);
    if (!SHELL_BLACKLIST.has(base)) return envShell;
  }
  if (process.platform === "darwin") return "/bin/zsh";
  if (process.platform === "win32") {
    const git = process.env["ProgramFiles"] ? path.join(process.env["ProgramFiles"], "Git", "bin", "bash.exe") : null;
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

let cachedShell: string | null = null;
function getShell(): string {
  if (cachedShell === null) {
    cachedShell = getAcceptableShell();
    logger.debug("Resolved shell for commands:", cachedShell);
  }
  return cachedShell;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

/**
 * Run a shell command with full output capture.
 * Uses explicit shell (SHELL or platform default) so PATH/env match user's terminal where possible.
 *
 * @param command - Shell command to execute
 * @param cwd - Working directory (optional). Must exist and be a directory to avoid EPERM/uv_cwd in child (e.g. npm).
 * @returns Promise with stdout, stderr, exitCode, and success flag
 */
export function runShellCommand(command: string, cwd?: string): Promise<CommandResult> {
  let resolvedCwd: string | undefined = cwd;
  if (cwd) {
    try {
      const absolute = path.resolve(cwd);
      resolvedCwd = fs.realpathSync(absolute);
      const stat = fs.statSync(resolvedCwd);
      if (!stat.isDirectory()) {
        const err = new Error(`Working directory is not a directory: ${resolvedCwd}`);
        logger.error(err.message);
        return Promise.resolve({
          stdout: "",
          stderr: err.message,
          exitCode: 1,
          success: false,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const out = `Invalid or inaccessible working directory: ${cwd}. ${message}`;
      logger.error(out);
      return Promise.resolve({
        stdout: "",
        stderr: out,
        exitCode: 1,
        success: false,
      });
    }
  }

  logger.log(`Running command: ${command}${resolvedCwd ? ` in ${resolvedCwd}` : ''}`);

  const shell = getShell();
  const env = { ...process.env, CI: "true" }; // CI encourages CLIs (e.g. create-vite) to run non-interactively

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const proc = spawn(command, {
      shell,
      cwd: resolvedCwd || undefined,
      env,
      stdio: ["ignore", "pipe", "pipe"], // ignore stdin, pipe stdout/stderr
    });

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", (error) => {
      logger.error(`Error executing command "${command}":`, error.message);
      resolve({
        stdout,
        stderr: error.message,
        exitCode: 1,
        success: false,
      });
    });

    proc.on("close", (code) => {
      const exitCode = code ?? 1;
      const success = exitCode === 0;

      if (success) {
        logger.debug(`Command "${command}" succeeded with code ${exitCode}`);
      } else {
        logger.error(`Command "${command}" failed with code ${exitCode}`);
      }

      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode,
        success,
      });
    });
  });
}

export interface RunShellCommandStreamingOptions {
  /** Called on each stdout/stderr chunk with accumulated output so far. */
  onOutput: (accumulated: { stdout: string; stderr: string }) => void;
}

/**
 * Run a shell command and stream output via callback.
 * Calls onOutput on each stdout/stderr chunk with accumulated stdout and stderr.
 * Resolves with the same CommandResult as runShellCommand when the process exits.
 */
export function runShellCommandStreaming(
  command: string,
  cwd?: string,
  options?: RunShellCommandStreamingOptions
): Promise<CommandResult> {
  let resolvedCwd: string | undefined = cwd;
  if (cwd) {
    try {
      const absolute = path.resolve(cwd);
      resolvedCwd = fs.realpathSync(absolute);
      const stat = fs.statSync(resolvedCwd);
      if (!stat.isDirectory()) {
        const err = new Error(`Working directory is not a directory: ${cwd}`);
        logger.error(err.message);
        return Promise.resolve({
          stdout: "",
          stderr: err.message,
          exitCode: 1,
          success: false,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const out = `Invalid or inaccessible working directory: ${cwd}. ${message}`;
      logger.error(out);
      return Promise.resolve({
        stdout: "",
        stderr: out,
        exitCode: 1,
        success: false,
      });
    }
  }

  logger.log(`Running command (streaming): ${command}${resolvedCwd ? ` in ${resolvedCwd}` : ''}`);

  const shell = getShell();
  const env = { ...process.env, CI: "true" };
  const onOutput = options?.onOutput;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const emit = () => {
      onOutput?.({ stdout, stderr });
    };

    const proc = spawn(command, {
      shell,
      cwd: resolvedCwd || undefined,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
      emit();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
      emit();
    });

    proc.on("error", (error) => {
      logger.error(`Error executing command "${command}":`, error.message);
      resolve({
        stdout,
        stderr: error.message,
        exitCode: 1,
        success: false,
      });
    });

    proc.on("close", (code) => {
      const exitCode = code ?? 1;
      const success = exitCode === 0;
      if (success) {
        logger.debug(`Command "${command}" succeeded with code ${exitCode}`);
      } else {
        logger.error(`Command "${command}" failed with code ${exitCode}`);
      }
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode,
        success,
      });
    });
  });
}

/**
 * Legacy function for backward compatibility.
 * Returns stdout on success, null on failure.
 */
export function runShellCommandSimple(command: string): Promise<string | null> {
  return runShellCommand(command).then((result) =>
    result.success ? result.stdout : null
  );
}

