/**
 * Atlarix Shell Tools
 * ===================
 * Command execution, test running, environment checks, live preview,
 * terminal output streaming, and workspace diagnostics.
 *
 * Absorbs: execution-tools (minus ask_user moved to workspace.ts, and
 * the deleted get_project_info), stream-tools, testing-tools,
 * analysis-tools.
 */

import {
  ToolRegistry,
  createParameters,
  stringParam,
  booleanParam,
  numberParam,
} from "./registry";

import * as os from "node:os";
import { getAcceptableShell } from "@/lib/shell/resolve-shell";
import {
  isDangerousCommand,
  getDangerExplanation,
} from "../dangerous-commands";
import {} from "../streams/StreamManager";

/**
 * The shell `run_command` actually spawns, resolved once for the tool description.
 *
 * Stated on the tool as well as in `deviceInfo` ON PURPOSE: right next to the call
 * it is what stops the model inventing bash idioms on a non-bash shell. What was
 * dropped is the trailing "do not assume Linux/bash" — once the OS and shell are
 * named, that clause tells the model nothing it hasn't just been told.
 *
 * Same resolver `runShellCommand` uses to spawn, so this is the shell commands
 * genuinely run in, including a user's own $SHELL. Memoized and try/caught because
 * `getAcceptableShell()` may shell out (`which bash`) on Linux when $SHELL is
 * unset, and this runs at module load.
 */
let cachedDescriptionShell: string | undefined;
function resolveDescriptionShell(): string {
  if (cachedDescriptionShell !== undefined) return cachedDescriptionShell;
  try {
    cachedDescriptionShell = getAcceptableShell();
  } catch {
    cachedDescriptionShell =
      process.env.SHELL ?? process.env.COMSPEC ?? "your shell";
  }
  return cachedDescriptionShell;
}

// ═══════════════════════════════════════════════════════════
// COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
  name: "run_command",
  // The git block below used to live in the SYSTEM PROMPT (mode-prompt-bundle's
  // GIT_VIA_TERMINAL_NOTE / getGitTerminalNote), where it cost tokens on every
  // turn in every mode — including, at the time, Plan, which had no run_command.
  // It belongs here: conditional on the tool being bound, and next to the thing
  // it governs. Note what it says and does NOT say — the model already knows how
  // to run `git status`; it cannot know THIS PROJECT'S policy, so only the policy
  // is stated. OS/shell facts are interpolated live, never assumed.
  description:
    "Run a shell command (builds, tests, package managers, git, logs). " +
    `Runs on ${os.type()} ${os.release()} (${os.arch()}) through \`${resolveDescriptionShell()}\`. ` +
    "Use the cwd parameter rather than `cd … &&`, and read_file / edit_file / glob / grep for file work (cheaper and reviewable). " +
    "Work longer than ~15s goes to the background by itself (background=true detaches at once); its result is delivered to you, so keep working or end your turn rather than polling. A quiet job MAY not be stuck: rather than cancel it, set wake_on (wake when a marker appears), timeout_ms, or allow_stalled (a dev server is expected to be quiet). " +
    'Open a printed http://localhost:PORT with browser({action:"navigate", url}). ' +
    "Git: commit, push or open a PR only when asked; never skip hooks, force-push or discard work you did not create. " +
    "In Explore, Plan and Review, a command that changes the source waits for the user's approval: a pause, not a failure. To change files, ask the user to switch to Build or Debug rather than retrying. " +
    "Never touch git config, git hooks or `.atlarix/`.",
  requiresWorkspace: true,
  isCore: true,
  isReadOnly: false,
  allowInAskMode: true,
  parameters: createParameters(
    {
      command: stringParam("Shell command to execute"),
      cwd: stringParam(
        "Working directory (default: workspace root). Prefer this over 'cd <dir> && command'.",
      ),
      description: stringParam("What this command does"),
      timeout_ms: numberParam(
        "Max wall-clock time in ms (default 120000, max 1800000). Dev-server commands still use a short start timeout.",
        120_000,
        1000,
        1_800_000,
      ),
      max_output_bytes: numberParam(
        "Max UTF-8 bytes of combined stdout/stderr in the tool result (default 80000, max 1000000). Lower for huge builds.",
        80_000,
        1024,
        1_000_000,
      ),
      background: booleanParam(
        "Run detached: return immediately; you receive the exit result automatically when it finishes.",
      ),
      wake_on: stringParam(
        "Wake you when output matches this text — use a success|failure marker (with wake_on_regex:true) on backgrounded builds/tests/installs. You're still pinged on silence and exit; omit for one-shot commands.",
      ),
      wake_on_regex: booleanParam(
        "Treat wake_on as a case-insensitive regex instead of a plain substring.",
      ),
      allow_stalled: booleanParam(
        "This background job is expected to be quiet (a dev server / file watcher / long-running service that only prints on activity) — don't ping me about it going quiet. It still runs, still delivers its exit result, and wake_on still fires.",
      ),
    },
    ["command", "description"],
  ),
  handler: async ({
    command,
    cwd = ".",
    description,
    timeout_ms = 120_000,
    max_output_bytes = 80_000,
    background = false,
    wake_on,
    wake_on_regex = false,
    allow_stalled = false,
  }) => {
    const dangerous = isDangerousCommand(command);
    const dangerExplanation = dangerous
      ? getDangerExplanation(command)
      : undefined;

    return {
      __permission_required: true,
      operation: "run_command",
      preview: {
        command,
        workingDirectory: cwd,
        description,
        isDangerous: dangerous,
        dangerExplanation,
        timeout_ms: Math.min(
          1_800_000,
          Math.max(1000, Number(timeout_ms) || 120_000),
        ),
        max_output_bytes: Math.min(
          1_000_000,
          Math.max(1024, Number(max_output_bytes) || 80_000),
        ),
        background: background === true,
        wake_on:
          wake_on && String(wake_on).trim()
            ? { pattern: String(wake_on), regex: wake_on_regex === true }
            : undefined,
        allow_stalled: allow_stalled === true,
      },
    };
  },
});
