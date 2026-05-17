import { spawn, execSync, type ChildProcess } from "child_process";
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

function resolveWorkingDirectory(cwd?: string): { cwd?: string; error?: CommandResult } {
  if (!cwd) return { cwd: undefined };
  try {
    const absolute = path.resolve(cwd);
    const resolved = fs.realpathSync(absolute);
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      const err = new Error(`Working directory is not a directory: ${resolved}`);
      logger.error(err.message);
      return {
        error: {
          stdout: "",
          stderr: err.message,
          exitCode: 1,
          success: false,
        },
      };
    }
    return { cwd: resolved };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const out = `Invalid or inaccessible working directory: ${cwd}. ${message}`;
    logger.error(out);
    return {
      error: {
        stdout: "",
        stderr: out,
        exitCode: 1,
        success: false,
      },
    };
  }
}

interface RunShellProcessOptions {
  command: string;
  cwd?: string;
  onOutput?: (accumulated: { stdout: string; stderr: string }) => void;
  /** Called immediately after spawn so callers can kill the process on timeout. */
  onSpawn?: (proc: ChildProcess) => void;
}

/**
 * Spawn a shell command and resolve once on exit/close/error (single resolution).
 */
function runShellProcess(options: RunShellProcessOptions): Promise<CommandResult> {
  const { command, cwd, onOutput, onSpawn } = options;
  const shell = getShell();
  const env = { ...process.env, CI: "true" };

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve({
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        exitCode: result.exitCode,
        success: result.success,
      });
    };

    const emit = () => {
      onOutput?.({ stdout, stderr });
    };

    const proc = spawn(command, {
      shell,
      cwd: cwd || undefined,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    onSpawn?.(proc);

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
      finish({
        stdout,
        stderr: error.message,
        exitCode: 1,
        success: false,
      });
    });

    const onProcessEnd = (code: number | null) => {
      const exitCode = code ?? 1;
      const success = exitCode === 0;
      if (success) {
        logger.debug(`Command "${command}" succeeded with code ${exitCode}`);
      } else {
        logger.error(`Command "${command}" failed with code ${exitCode}`);
      }
      finish({ stdout, stderr, exitCode, success });
    };

    // Listen to both: some shells/platforms emit exit before close; either must settle the promise.
    proc.on("exit", (code) => onProcessEnd(code));
    proc.on("close", (code) => onProcessEnd(code));
  });
}

/**
 * Run a shell command with full output capture.
 */
export function runShellCommand(command: string, cwd?: string): Promise<CommandResult> {
  const { cwd: resolvedCwd, error } = resolveWorkingDirectory(cwd);
  if (error) return Promise.resolve(error);

  logger.log(`Running command: ${command}${resolvedCwd ? ` in ${resolvedCwd}` : ""}`);
  return runShellProcess({ command, cwd: resolvedCwd });
}

export interface RunShellCommandStreamingOptions {
  /** Called on each stdout/stderr chunk with accumulated output so far. */
  onOutput: (accumulated: { stdout: string; stderr: string }) => void;
  /** Called immediately after spawn so callers can kill the process on timeout. */
  onSpawn?: (proc: ChildProcess) => void;
}

/**
 * Run a shell command and stream output via callback.
 * Resolves with CommandResult when the process exits.
 */
export function runShellCommandStreaming(
  command: string,
  cwd?: string,
  options?: RunShellCommandStreamingOptions,
): Promise<CommandResult> {
  const { cwd: resolvedCwd, error } = resolveWorkingDirectory(cwd);
  if (error) return Promise.resolve(error);

  logger.log(`Running command (streaming): ${command}${resolvedCwd ? ` in ${resolvedCwd}` : ""}`);
  return runShellProcess({
    command,
    cwd: resolvedCwd,
    onOutput: options?.onOutput,
    onSpawn: options?.onSpawn,
  });
}

/** Kill a child process (SIGTERM, then SIGKILL after delay). */
export function killShellProcess(proc: ChildProcess | null | undefined): void {
  if (!proc || proc.killed) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    /* noop */
  }
  setTimeout(() => {
    if (proc.killed) return;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* noop */
    }
  }, 2000);
}

/**
 * Legacy function for backward compatibility.
 * Returns stdout on success, null on failure.
 */
export function runShellCommandSimple(command: string): Promise<string | null> {
  return runShellCommand(command).then((result) =>
    result.success ? result.stdout : null,
  );
}
