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


import { isDangerousCommand, getDangerExplanation } from "../dangerous-commands";
import {
    } from "../streams/StreamManager";




// ═══════════════════════════════════════════════════════════
// COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "run_command",
    description:
        "Run a shell command at the workspace root. Use the cwd parameter, not 'cd … && command'. " +
        "Mutating commands run only where the active work mode allows; the genuinely dangerous ones ask. " +
        "Long-running work (builds, installs, watch/dev tasks) auto-backgrounds after ~15s — or set background=true to detach immediately; either way you get a job_id and the exit result is delivered automatically, so continue other work, never poll, and you may end your turn while it runs (manage jobs with background_jobs). " +
        "For a backgrounded job, set wake_on to a success|failure marker (with wake_on_regex:true) to be woken the instant it appears; a quiet job is usually still working, not stuck — keep waiting rather than cancelling. For external state (CI/deploy), background a command that BLOCKS until done (e.g. `gh run watch`) instead of polling. " +
        "A printed http://localhost:PORT loads in the preview — drive it with browser_* target:\"preview\". " +
        "To find files or search code, use the glob and grep tools (not shell). For scaffolding, pass non-interactive flags (e.g. --template, --no-interactive).",
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
            },
        };
    },
});
