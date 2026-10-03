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
      const err = new Error(
        `Working directory is not a directory: ${resolved}`,
      );
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

/**
 * What a streamed-output consumer is handed on each flush.
 *
 * BOTH SHAPES, ON PURPOSE. `stdout`/`stderr` are the accumulated buffers, exactly
 * as before; `deltaStdout`/`deltaStderr` are only what is new since the previous
 * flush. Every consumer that existed before this change keeps reading the
 * accumulated fields and is unaffected — the delta fields are opt-in, converted
 * one consumer at a time with its own test.
 *
 * That additive shape was chosen after auditing the consumers: FIVE of them would
 * have produced silently WRONG output under a straight swap (the in-chat card, the
 * main-side terminal buffer, the background-job cursor, the error toast, and the
 * right-panel transcript), and one — the ~15s promotion handoff at
 * `interceptor.ts` — has no test at all. A flag day across all of them at once was
 * not worth it. `dev-server:output` already ships this exact pairing.
 *
 * WHY THE CUMULATIVE FIELDS ARE THE PROBLEM. They are re-sent on every `data`
 * event, so a command emitting N bytes over K chunks pushes ~N·K/2 bytes through
 * every consumer. Measured on a 4.9 MB build log in 75 chunks: 187 MB re-sent, and
 * 218 ms of renderer main-thread parsing per command against 6 ms for the deltas.
 */
export interface StreamedOutput {
  /** Everything so far. The original contract; unchanged. */
  stdout: string;
  stderr: string;
  /** Only what is new since the previous flush. */
  deltaStdout: string;
  deltaStderr: string;
}

/**
 * How long a trailing partial line is held before being flushed anyway.
 *
 * Long enough that a normal line's newline arrives in the same tick and nothing
 * is split; short enough that a `\r`-redrawn progress bar or an interactive
 * prompt — neither of which ever emits a newline — still reaches the UI promptly
 * instead of looking like a hang.
 */
const PARTIAL_LINE_HOLD_MS = 120;

interface RunShellProcessOptions {
  command: string;
  cwd?: string;
  onOutput?: (o: StreamedOutput) => void;
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
function runShellProcess(
  options: RunShellProcessOptions,
): Promise<CommandResult> {
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
        logger.error(
          `Sandbox required but unavailable (${wrapped.note}); refusing to run: ${command}`,
        );
        return Promise.resolve({
          stdout: "",
          stderr: `Command sandbox is required but unavailable on this system (${wrapped.note}). Command not run.`,
          exitCode: 1,
          success: false,
        });
      }
      logger.warn(
        `run_command not sandboxed (${wrapped.note}); running unconfined: ${command}`,
      );
    }
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      // The tail of a command that ended without a trailing newline would
      // otherwise never be delivered to a delta consumer.
      emitFinal();
      resolve({
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        exitCode: result.exitCode,
        success: result.success,
      });
    };

    // ── Delta emission, flushed on LINE boundaries ────────────────────────
    //
    // How much of each buffer a consumer has already been shown. The delta is
    // the slice past these marks.
    let emittedOut = 0;
    let emittedErr = 0;
    // Set when a partial trailing line is being held back, so it can still be
    // flushed if the process then goes quiet (a `\r` progress bar or a prompt
    // never emits a newline, and holding its output forever would look like a
    // hang).
    let holdTimer: NodeJS.Timeout | null = null;

    /**
     * Why line boundaries rather than raw chunks.
     *
     * Two bug classes appear the moment a consumer parses a delta instead of the
     * whole buffer, and both are invisible today because the cumulative resend
     * papers over them:
     *
     *  1. A chunk can end mid-line. `trimEnd()`-ing that and pushing it as a
     *     complete line splits one log line into two.
     *  2. A chunk can end mid-ANSI-escape (`\x1b[3` … `2m`). Neither half matches
     *     the SGR regex, so the colour code leaks into the text as garbage.
     *
     * A complete line cannot contain either — an SGR sequence has no newline in
     * it. So holding the trailing partial until its newline arrives fixes both at
     * once, for every consumer, rather than each of them carrying its own
     * remainder buffer.
     */
    const splitAtLastNewline = (buf: string, from: number): number => {
      const idx = buf.lastIndexOf("\n");
      return idx >= from ? idx + 1 : from;
    };

    const emit = (force = false) => {
      const outTo = force
        ? stdout.length
        : splitAtLastNewline(stdout, emittedOut);
      const errTo = force
        ? stderr.length
        : splitAtLastNewline(stderr, emittedErr);
      const deltaStdout = stdout.slice(emittedOut, outTo);
      const deltaStderr = stderr.slice(emittedErr, errTo);

      if (!force && !deltaStdout && !deltaStderr) {
        // Nothing but a partial line so far. Arm a one-shot flush so output that
        // never ends in a newline still reaches the UI.
        if (!holdTimer) {
          holdTimer = setTimeout(() => {
            holdTimer = null;
            emit(true);
          }, PARTIAL_LINE_HOLD_MS);
          holdTimer.unref?.();
        }
        return;
      }
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      emittedOut = outTo;
      emittedErr = errTo;
      onOutput?.({ stdout, stderr, deltaStdout, deltaStderr });
    };

    /** Flush whatever is held, without waiting for a newline. */
    const emitFinal = () => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      if (emittedOut < stdout.length || emittedErr < stderr.length) emit(true);
    };

    const proc = spawnArgs
      ? spawn(spawnFile, spawnArgs, {
          cwd: cwd || undefined,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          ...PROCESS_GROUP_SPAWN_OPTIONS,
        })
      : spawn(spawnFile, {
          shell,
          cwd: cwd || undefined,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          ...PROCESS_GROUP_SPAWN_OPTIONS,
        });

    liveShellProcesses.add(proc);
    const forget = () => liveShellProcesses.delete(proc);
    proc.once("exit", forget);
    proc.once("error", forget);
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
  const { cwd: resolvedCwd, error } = resolveWorkingDirectory(
    cwd,
    workspaceRoot,
  );
  if (error) return Promise.resolve(error);

  logger.log(
    `Running command: ${command}${resolvedCwd ? ` in ${resolvedCwd}` : ""}`,
  );
  return runShellProcess({ command, cwd: resolvedCwd });
}

export interface RunShellCommandStreamingOptions {
  /** Called on each flush with both the accumulated output and the new delta. */
  onOutput: (o: StreamedOutput) => void;
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

  logger.log(
    `Running command (streaming): ${command}${resolvedCwd ? ` in ${resolvedCwd}` : ""}`,
  );
  return runShellProcess({
    command,
    cwd: resolvedCwd,
    onOutput: options?.onOutput,
    onSpawn: options?.onSpawn,
    sandbox: options?.sandbox,
  });
}

/**
 * Spawn options that put the child in its OWN process group.
 *
 * Every command runs through a shell, so the process we hold is `sh`/`bash`, not
 * the thing the user actually started. Signalling that pid alone reaps the shell
 * and leaves its children running: cancelling `npm run dev` killed the shell and
 * left node holding the port, which is the bug this exists for.
 *
 * `detached` is POSIX-only here. On Windows it would open a new console window,
 * and it is not how you kill a tree there anyway — `taskkill /T` walks the parent
 * chain instead (see `killShellProcess`). We never `unref()`, so the child stays
 * tied to our lifetime exactly as before.
 */
const PROCESS_GROUP_SPAWN_OPTIONS: { detached?: boolean } =
  process.platform === "win32" ? {} : { detached: true };

/**
 * Signal the whole process GROUP, falling back to the single child.
 *
 * A negative pid means "the group" to `process.kill` — available because we
 * spawned `detached`. ESRCH here just means everything already exited.
 */
function signalProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  const pid = proc.pid;
  if (pid == null) return;
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    /* group gone, or never grouped — fall through to the direct child */
  }
  try {
    proc.kill(signal);
  } catch {
    /* noop */
  }
}

/**
 * Windows has no process groups to signal, so walk the tree with `taskkill /T`.
 *
 * NOT VERIFIED ON WINDOWS — reasoned from the documented behaviour of
 * `taskkill /T /F`, like the v14.31.0 notification fix. Tracked in docs/TODO.md
 * under the Windows machine.
 */
function killProcessTreeWindows(proc: ChildProcess): void {
  const pid = proc.pid;
  if (pid == null) return;
  try {
    // Fire-and-forget: the exit handlers on `proc` are what actually settle the
    // command, and a failed taskkill must not throw into a cancel path.
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).on("error", () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* noop */
      }
    });
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* noop */
    }
  }
}

/**
 * Kill a child process AND everything it started (SIGTERM, then SIGKILL after a
 * grace period).
 *
 * The tree matters: without it, cancelling a dev server or a test runner leaves
 * the real work running — holding its port, writing to the workspace, and
 * invisible to the user who just pressed stop.
 */
/**
 * Every command this process has running, foreground included. They run in
 * their own process group (detached), so they OUTLIVE this process unless
 * killed: a CLI that exited mid-command left `sleep 20` reparented and running.
 */
const liveShellProcesses = new Set<ChildProcess>();

/** Kill every running command's process tree. For quitting (desktop and CLI). */
export function killAllShellProcesses(): void {
  for (const proc of liveShellProcesses) killShellProcess(proc);
  liveShellProcesses.clear();
}

export function killShellProcess(proc: ChildProcess | null | undefined): void {
  if (!proc || proc.killed) return;

  if (process.platform === "win32") {
    // `/F` is already forceful; there is no graceful-then-forceful pair here.
    killProcessTreeWindows(proc);
    return;
  }

  signalProcessTree(proc, "SIGTERM");
  setTimeout(() => {
    // `proc.killed` only records that WE signalled it, not that it died — check
    // for an exit code/signal, which is what actually says the child is gone.
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    signalProcessTree(proc, "SIGKILL");
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
