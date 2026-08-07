import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import log from "electron-log";
import { getAcceptableShell } from "@/lib/shell/resolve-shell";
import { wrapCommandInSandbox } from "@/lib/sandbox/wrap-command";

const logger = log.scope("runShellCommand");

/** Confine a command's filesystem WRITES to the workspace + caches (network stays on). */
export interface SandboxRunOptions {
  workspacePath: string;
  extraWritablePaths?: string[];
  /** When true, refuse to run the command if no sandbox is available (default: fall back). */
  enforce?: boolean;
  /** Read-only mode: deny workspace-source writes (Explore/Plan/Review). */
  readOnly?: boolean;
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
  /**
   * True when `stdout` is a HARNESS-authored control message (e.g. a background
   * command's start/promote notice), not captured command output. Such text is
   * trusted and must NOT be wrapped in the untrusted-data envelope.
   */
  harnessMessage?: boolean;
}

/**
 * @param workspaceRoot Where the workspace actually is, so a bad `cwd` can be
 * corrected rather than merely refused. Observed in the packaged app: the model
 * invented `/Users/…/Github/AI/railway-cli` for a workspace at
 * `/Users/…/Github/railway-cli`, got a bare ENOENT with nothing to correct TO,
 * and spent a turn hunting for the root. Same principle as
 * `sandbox-failure-context.ts` — the harness supplies what the model cannot see,
 * facts only, no diagnosis.
 */
function resolveWorkingDirectory(
  cwd?: string,
  workspaceRoot?: string,
): { cwd?: string; error?: CommandResult } {
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
    const hint =
      workspaceRoot && path.resolve(cwd) !== path.resolve(workspaceRoot)
        ? ` The workspace root is ${workspaceRoot} — commands run there by default, so omit \`cwd\` unless you need a subdirectory of it.`
        : "";
    const out = `Invalid or inaccessible working directory: ${cwd}. ${message}${hint}`;
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
  /** When set, confine filesystem writes via the per-OS sandbox. */
  sandbox?: SandboxRunOptions;
  /** The workspace root, so an unusable `cwd` is reported with the right one. */
  workspaceRoot?: string;
}

/**
 * Spawn a shell command and resolve once on exit/close/error (single resolution).
 */
function runShellProcess(options: RunShellProcessOptions): Promise<CommandResult> {
  const { command, cwd, onOutput, onSpawn, sandbox } = options;
  const shell = getShell();
  const env = { ...process.env, CI: "true" };

  // Resolve how to spawn: sandboxed (explicit file+args, no shell option) or plain.
  let spawnFile = command;
  let spawnArgs: string[] | null = null;
  if (sandbox) {
    const wrapped = wrapCommandInSandbox({
      command,
      shell,
      workspacePath: sandbox.workspacePath,
      extraWritablePaths: sandbox.extraWritablePaths,
      readOnly: sandbox.readOnly,
    });
    // The SPAWN SHAPE is decided by `useShellOption`, not by `sandboxed`. They are
    // not the same question: a WSL-routed command has an explicit file+args
    // (`wsl.exe -d …`) and must be spawned that way even when bwrap is absent
    // inside the distro and it is therefore NOT confined. Branching on `sandboxed`
    // here would silently run such a command on the Windows side instead — wrong
    // toolchain, wrong paths.
    if (!wrapped.useShellOption) {
      spawnFile = wrapped.file;
      spawnArgs = wrapped.args;
    }
    if (!wrapped.sandboxed) {
      if (sandbox.enforce) {
        logger.error(`Sandbox required but unavailable (${wrapped.note}); refusing to run: ${command}`);
        return Promise.resolve({
          stdout: "",
          stderr: `Command sandbox is required but unavailable on this system (${wrapped.note}). Command not run.`,
          exitCode: 1,
          success: false,
        });
      }
      logger.warn(`run_command not sandboxed (${wrapped.note}); running unconfined: ${command}`);
    }
  }

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

    const proc = spawnArgs
      ? spawn(spawnFile, spawnArgs, {
          cwd: cwd || undefined,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(spawnFile, {
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
export function runShellCommand(
  command: string,
  cwd?: string,
  workspaceRoot?: string,
): Promise<CommandResult> {
  const { cwd: resolvedCwd, error } = resolveWorkingDirectory(cwd, workspaceRoot);
  if (error) return Promise.resolve(error);

  logger.log(`Running command: ${command}${resolvedCwd ? ` in ${resolvedCwd}` : ""}`);
  return runShellProcess({ command, cwd: resolvedCwd });
}

export interface RunShellCommandStreamingOptions {
  /** Called on each stdout/stderr chunk with accumulated output so far. */
  onOutput: (accumulated: { stdout: string; stderr: string }) => void;
  /** Called immediately after spawn so callers can kill the process on timeout. */
  onSpawn?: (proc: ChildProcess) => void;
  /** When set, confine filesystem writes via the per-OS sandbox. */
  sandbox?: SandboxRunOptions;
  /** The workspace root, so an unusable `cwd` is reported with the right one. */
  workspaceRoot?: string;
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
  const { cwd: resolvedCwd, error } = resolveWorkingDirectory(
    cwd,
    options?.workspaceRoot,
  );
  if (error) return Promise.resolve(error);

  logger.log(`Running command (streaming): ${command}${resolvedCwd ? ` in ${resolvedCwd}` : ""}`);
  return runShellProcess({
    command,
    cwd: resolvedCwd,
    onOutput: options?.onOutput,
    onSpawn: options?.onSpawn,
    sandbox: options?.sandbox,
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
