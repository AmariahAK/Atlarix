/**
 * Structured recovery guidance for failed `run_command` calls — the shell
 * analog of `edit_file`'s near-miss hint. On a non-zero exit, returns a short,
 * actionable suggestion so the model recovers instead of assuming success or
 * flailing. Advisory (appended to the tool result); the completion gate
 * (mutation-verify) is what actually blocks finishing on a failed command.
 */

/** A one-line recovery hint for a failed command, or null if it succeeded. Accepts a loose result object. */
export function runCommandFailureGuidance(
  command: string,
  result: Record<string, unknown>,
): string | null {
  const exit = typeof result.exitCode === "number" ? result.exitCode : undefined;
  if (result.success === true || exit === 0 || exit == null) return null;

  const error = typeof result.error === "string" ? result.error : "";
  const output = typeof result.output === "string" ? result.output : "";
  const text = `${error}\n${output}`.toLowerCase();
  const firstWord = command.trim().split(/\s+/)[0] || "the command";

  if (exit === 127 || text.includes("command not found") || text.includes("not found")) {
    return `Command failed (exit ${exit}): "${firstWord}" was not found. Verify it's installed and on PATH (try \`which ${firstWord}\` / \`type ${firstWord}\`, or install it / use the full path) before retrying.`;
  }
  if (exit === 126 || text.includes("permission denied")) {
    return `Command failed (exit ${exit}): permission denied. The target exists but can't run — check ownership/mode (\`chmod +x\`), or run via the right interpreter, before retrying.`;
  }
  if (text.includes("no such file") || text.includes("not a directory")) {
    return `Command failed (exit ${exit}): a referenced path doesn't exist. Re-check the current layout with glob/read_file (the file may have moved or the path is wrong) before retrying.`;
  }
  if (exit === 124 || text.includes("timed out") || text.includes("timeout")) {
    return `Command failed (exit ${exit}): it timed out. Raise timeout_ms for genuinely long commands, or run it in the background, rather than re-running blindly.`;
  }
  return `Command failed (exit ${exit}). Read the error output above, fix the cause, and re-run — do not proceed as if it succeeded.`;
}
