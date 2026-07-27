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
        "A printed http://localhost:PORT can be opened as a browser tab (browser_navigate) and driven with the browser_* tools. " +
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
            allow_stalled: booleanParam(
                "This background job is expected to be quiet (a dev server / file watcher / long-running service that only prints on activity) — don't ping me about it going quiet. It still runs, still delivers its exit result, and wake_on still fires.",
            ),
            terminal: stringParam(
                "Run in a specific terminal tab, by name (e.g. \"e2e\") or id. The name is created once and reused, so repeated calls share that tab. Omit for the default: foreground commands share one Agent tab and backgrounded ones get their own. Use this only when you genuinely need a separate stream — see terminal_list.",
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
        terminal,
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
                terminal:
                    typeof terminal === "string" && terminal.trim()
                        ? terminal.trim()
                        : undefined,
            },
        };
    },
});

// ═══════════════════════════════════════════════════════════
// TERMINAL TABS
// ═══════════════════════════════════════════════════════════
// Mirrors browser_tabs: the agent can see which streams exist and read one
// without re-running anything. Both are read-only, so they need no approval and
// are safe in every mode.

type WithChat<T> = T & { _chatSessionId?: number };

ToolRegistry.register({
    name: "terminal_list",
    description:
        "List the terminal tabs in this session — the shared Agent tab, any named tabs you created with run_command({terminal}), and background jobs each holding their own. " +
        "Shows id, name, owner and line count. Use before targeting a terminal, or to check what a long-running process is doing without re-running it.",
    requiresWorkspace: true,
    isCore: false,
    isReadOnly: true,
    allowInAskMode: true,
    parameters: createParameters({}, []),
    handler: async (args: WithChat<Record<string, never>>) => {
        const chatId = args._chatSessionId;
        if (typeof chatId !== "number") {
            return { success: false, error: "No active chat session." };
        }
        const { listTerminalInstances, resolveScopeKey } = await import(
            "@/lib/terminal-instance-store"
        );
        return {
            success: true,
            terminals: listTerminalInstances(resolveScopeKey(chatId, null)),
        };
    },
});

ToolRegistry.register({
    name: "terminal_read",
    description:
        "Read recent output from one terminal tab (by id or name from terminal_list). " +
        "The way to check on a dev server or watcher that is still running — it prints what the tab has shown so far without touching the process.",
    requiresWorkspace: true,
    isCore: false,
    isReadOnly: true,
    allowInAskMode: true,
    parameters: createParameters(
        {
            terminal: stringParam("Terminal id or name (see terminal_list)."),
            max_lines: numberParam(
                "How many trailing lines to return (default 200, max 2000).",
                200,
                1,
                2000,
            ),
        },
        ["terminal"],
    ),
    handler: async (
        args: WithChat<{ terminal: string; max_lines?: number }>,
    ) => {
        const chatId = args._chatSessionId;
        if (typeof chatId !== "number") {
            return { success: false, error: "No active chat session." };
        }
        const { listTerminalInstances, readTerminalInstance, resolveScopeKey } =
            await import("@/lib/terminal-instance-store");
        const scopeKey = resolveScopeKey(chatId, null);
        const wanted = String(args.terminal ?? "").trim();
        const open = listTerminalInstances(scopeKey);
        // Accept a name as well as an id — the agent chose the name, so making it
        // re-look-up the generated id would be busywork.
        const match =
            open.find((t) => t.id === wanted) ??
            open.find((t) => t.label.toLowerCase() === wanted.toLowerCase());
        if (!match) {
            return {
                success: false,
                error: `No terminal "${wanted}". Open terminals: ${JSON.stringify(
                    open.map((t) => t.label),
                )}.`,
            };
        }
        return readTerminalInstance(
            scopeKey,
            match.id,
            Math.min(2000, Math.max(1, Number(args.max_lines) || 200)),
        );
    },
});
