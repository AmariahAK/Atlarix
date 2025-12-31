import { spawn } from "child_process";
import log from "electron-log";

const logger = log.scope("runShellCommand");

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

/**
 * Run a shell command with full output capture.
 * 
 * @param command - Shell command to execute
 * @param cwd - Working directory (optional)
 * @returns Promise with stdout, stderr, exitCode, and success flag
 */
export function runShellCommand(command: string, cwd?: string): Promise<CommandResult> {
  logger.log(`Running command: ${command}${cwd ? ` in ${cwd}` : ''}`);

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const process = spawn(command, {
      shell: true,
      cwd: cwd || undefined,
      stdio: ["ignore", "pipe", "pipe"], // ignore stdin, pipe stdout/stderr
    });

    process.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    process.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("error", (error) => {
      logger.error(`Error executing command "${command}":`, error.message);
      resolve({
        stdout,
        stderr: error.message,
        exitCode: 1,
        success: false,
      });
    });

    process.on("close", (code) => {
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

