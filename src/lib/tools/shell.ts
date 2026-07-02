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
        "Execute a shell command in the workspace. Commands run at the workspace (project) root; do not use paths under atlarix-apps. " +
        "Allowed per current work mode allowlist; read-only git/shell in read-only modes; mutating commands only when the active mode permits. " +
        "Use the cwd parameter for the working directory instead of 'cd ... && command'. " +
        "Prefer one command per intent; for scaffolding, use one run_command that creates the project (do not emit multiple create/scaffold commands in the same turn). " +
        "For project scaffolding (e.g. npm create vite@latest <path>), pass all options so the command is non-interactive: use --template and, for create-vite, --no-interactive to avoid prompts. " +
        "Limits are optional knobs: pass smaller timeout_ms or max_output_bytes when you expect huge logs. " +
        "Set background=true for long-running work you don't need to block on (long builds, installs, watch tasks): the call returns immediately with a job_id and the result is delivered to you automatically when the command exits — continue other work, never poll, and you may END YOUR TURN while it runs (you're woken on completion). Any foreground command still running after ~15s is auto-moved to the background the same way. Manage running jobs with background_jobs. " +
        "When a backgrounded process prints a http://localhost:PORT URL, the preview loads it automatically — then drive it with browser_* target:\"preview\".",
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
            },
        };
    },
});
