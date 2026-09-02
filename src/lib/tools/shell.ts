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
import { isDangerousCommand, getDangerExplanation } from "../dangerous-commands";
import {
    } from "../streams/StreamManager";




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
        cachedDescriptionShell = process.env.SHELL ?? process.env.COMSPEC ?? "your shell";
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
    // turn in every mode — including Plan, which has no run_command at all. It
    // belongs here: conditional on the tool being bound, and next to the thing it
    // governs. Note what it says and does NOT say — the model already knows how to
    // run `git status`; it cannot know THIS PROJECT'S policy, so only the policy
    // is stated. OS/shell facts are interpolated live, never assumed.
    description:
        "Run a shell command — builds, tests, scripts, package managers, git, deployment, reading logs, and anything else that needs a shell. " +
        `Running on ${os.type()} ${os.release()} (${os.arch()}) through \`${resolveDescriptionShell()}\` — use that shell's syntax and this OS's path conventions. ` +
        "Use the cwd parameter, not 'cd … && command'. " +
        "Do NOT use this for file operations — reading, writing, editing, searching or finding files. Use read_file, edit_file, glob and grep, which are cheaper and reviewable. " +
        "Long-running work (builds, installs, watch/dev tasks) auto-backgrounds after ~15s — or set background=true to detach immediately; either way you get a job_id and the exit result is delivered automatically, so keep working or end your turn while it runs (manage jobs with background_jobs). You do not need to poll for it: the result is delivered, you are pinged if a job goes quiet, and you are told when one is genuinely stuck. " +
        "A quiet job MAY not be stuck, so rather than cancelling it, give yourself a signal: wake_on with a success|failure marker (wake_on_regex:true for a pattern) wakes you the instant it appears, timeout_ms bounds how long it may run, and allow_stalled:true says a job is EXPECTED to be quiet (a dev server, a file watcher) so silence isn't reported. For external state (CI/deploy), background a command that BLOCKS until done (e.g. `gh run watch`) rather than checking repeatedly. " +
        "A printed http://localhost:PORT can be opened as a browser tab with browser({action:\"navigate\", url}) and driven with browser / browser_inspect. " +
        "For scaffolding, pass non-interactive flags (e.g. --template, --no-interactive). " +
        "Git: only commit, amend, push or open a PR/MR when asked. Before committing, inspect the status and diff, stage only what you intended, and never commit secrets. Do not change git config, skip hooks, or force-push; if a commit fails or a hook rejects it, fix the cause and make a NEW commit rather than amending. Do not discard uncommitted work you did not create — if a reset really is the right fix, say what will be lost first. For forge work use whichever CLI the remote actually uses (`gh` for GitHub, `glab` for GitLab, the Bitbucket CLI, …) — check the remote rather than assuming — and report the resulting PR/MR URL. " +
        "If a command fails you are told exactly why, with its exit code and output. Commands run in a sandbox scoped to the current work mode: reads and non-mutating work always run, but a write to your source can be refused at the OS layer in a read-only mode — ask the user to switch to Build or Debug rather than retrying the same command.",
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: false,
    allowInAskMode: true,
    parameters: createParameters(
        {
            command: stringParam("Shell command to execute"),
            cwd: stringParam("Working directory (default: workspace root). Prefer this over 'cd <dir> && command'."),
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
        ["command", "description"]
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
        const dangerExplanation = dangerous ? getDangerExplanation(command) : undefined;

        return {
            __permission_required: true,
            operation: "run_command",
            preview: {
                command,
                workingDirectory: cwd,
                description,
                isDangerous: dangerous,
                dangerExplanation,
                timeout_ms: Math.min(1_800_000, Math.max(1000, Number(timeout_ms) || 120_000)),
                max_output_bytes: Math.min(1_000_000, Math.max(1024, Number(max_output_bytes) || 80_000)),
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
