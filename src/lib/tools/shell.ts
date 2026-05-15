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

import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import {
    ToolRegistry,
    ToolCategory,
    createParameters,
    stringParam,
    booleanParam,
    numberParam,
} from "./registry";
import { assertReadablePath } from "@/lib/security/env-secret-paths";
import { isDangerousCommand, getDangerExplanation } from "../dangerous-commands";
import {
    openStream,
    closeStream,
    getCollectedLines,
    setStreamInactive,
} from "../streams/StreamManager";
import { devServerManager } from "../dev_server_manager";

const execAsync = promisify(exec);

// ═══════════════════════════════════════════════════════════
// COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "run_command",
    description:
        "Execute a shell command in the workspace. Commands run at the workspace (project) root; do not use paths under atlarix-apps. " +
        "Shows permission dialog before running. Use the cwd parameter for the working directory instead of 'cd ... && command'. " +
        "Prefer one command per intent; for scaffolding, use one run_command that creates the project (do not emit multiple create/scaffold commands in the same turn). " +
        "For project scaffolding (e.g. npm create vite@latest <path>), pass all options so the command is non-interactive: use --template and, for create-vite, --no-interactive to avoid prompts. " +
        "Limits are optional knobs: pass smaller timeout_ms or max_output_bytes when you expect huge logs.",
    category: ToolCategory.EXECUTION,
    cost: 3,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: false,
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
                "Max UTF-8 bytes of combined stdout/stderr in the tool result (default 80000, max 300000). Lower for huge builds.",
                80_000,
                1024,
                300_000,
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
                max_output_bytes: Math.min(300_000, Math.max(1024, Number(max_output_bytes) || 80_000)),
            },
        };
    },
});

// ═══════════════════════════════════════════════════════════
// TEST EXECUTION
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "run_tests",
    description:
        "Run the project's test suite. Detects test framework from package.json when omitted (npm test, jest, vitest, mocha, bun test). Optional path scopes to a file or pattern; watch enables watch mode when supported.",
    category: ToolCategory.EXECUTION,
    cost: 3,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: false,
    parameters: createParameters(
        {
            path: stringParam(
                "Optional: specific test file, directory, or pattern (relative to workspace root)"
            ),
            framework: stringParam(
                "Optional: force a framework (npm, pytest, jest, vitest, mocha). Omit to auto-detect from package.json / lockfiles."
            ),
            watch: booleanParam("Run in watch mode when the detected runner supports it (jest/vitest)."),
        },
        []
    ),
    handler: async ({
        path: testTarget,
        framework,
        watch = false,
        workspace,
    }: {
        path?: string;
        framework?: string;
        watch?: boolean;
        workspace?: string;
    }) => {
        const w = workspace || process.cwd();
        let command = "npm test";

        if (framework) {
            const target = testTarget ? ` ${testTarget}` : "";
            switch (framework.toLowerCase()) {
                case "pytest":
                    command = `pytest${target}`;
                    break;
                case "jest":
                    command = `jest${target}`;
                    break;
                case "vitest":
                    command = watch ? `vitest${target}` : `vitest run${target}`;
                    break;
                case "mocha":
                    command = `npx mocha${target}`;
                    break;
                default:
                    command = `${framework}${target}`;
            }
        } else {
            const packageJsonPath = path.join(w, "package.json");
            let testCommand = "npm test";
            const hasBunLock = await fs
                .access(path.join(w, "bun.lockb"))
                .then(() => true)
                .catch(() => false);
            if (hasBunLock) testCommand = "bun test";

            try {
                assertReadablePath("package.json", w);
                const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));
                if (packageJson.devDependencies?.jest || packageJson.dependencies?.jest) {
                    testCommand = "npx jest";
                } else if (
                    packageJson.devDependencies?.vitest ||
                    packageJson.dependencies?.vitest
                ) {
                    testCommand = watch ? "npx vitest" : "npx vitest run";
                } else if (
                    packageJson.devDependencies?.mocha ||
                    packageJson.dependencies?.mocha
                ) {
                    testCommand = "npx mocha";
                }

                if (watch) {
                    if (testCommand.includes("jest")) {
                        testCommand += " --watch";
                    } else if (testCommand.includes("vitest") && !testCommand.includes("run")) {
                        // already watch-style
                    } else if (testCommand.includes("vitest run")) {
                        testCommand = testCommand.replace("vitest run", "npx vitest");
                    }
                }

                if (testTarget) {
                    testCommand += ` ${testTarget}`;
                }
            } catch {
                if (testTarget) {
                    testCommand += ` ${testTarget}`;
                }
            }

            command = testCommand;
        }

        const pathLine = testTarget ? `\nPath: ${testTarget}` : "";
        const watchLine = watch ? "\nWatch: yes" : "";
        return `__PERMISSION_REQUIRED__\n🧪 Run Tests\n\nCommand: \`${command}\`${pathLine}${watchLine}\n\n[Approve] [Reject]`;
    },
});

// ═══════════════════════════════════════════════════════════
// ENVIRONMENT CHECKS (languages / runtime / command_status)
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "check_environment",
    description:
        "Check the development environment. operation: languages (detect from project files), runtime (check a language install), command_status (poll a prior background command).",
    category: ToolCategory.EXECUTION,
    cost: 1,
    requiresWorkspace: false,
    isCore: true,
    isReadOnly: true,
    parameters: createParameters(
        {
            operation: {
                type: "string",
                enum: ["languages", "runtime", "command_status"],
                description: "Which check to run",
            },
            runtime: stringParam(
                "For operation runtime: language key (nodejs, python, go, rust, ruby, java, php, dotnet, deno, bun, elixir, docker)",
            ),
            command_id: stringParam("For operation command_status: operation ID from run_command"),
            wait_ms: {
                type: "number",
                description: "For command_status: optional wait before check (ms, max 10000)",
            },
            workspace: stringParam("Workspace path (for languages operation; auto-provided)"),
        },
        ["operation"],
    ),
    handler: async (args: {
        operation: "languages" | "runtime" | "command_status";
        runtime?: string;
        command_id?: string;
        wait_ms?: number;
        workspace?: string;
    }) => {
        switch (args.operation) {
            case "languages": {
                try {
                    const { detectProjectLanguages } = await import("../project_language_detector");
                    const workspacePath = args.workspace || process.cwd();
                    const languages = await detectProjectLanguages(workspacePath);
                    if (languages.length === 0) {
                        return { detected: [], message: "No recognized languages detected in this project." };
                    }
                    const formatted = languages.map((lang) => ({
                        name: lang.name,
                        displayName: lang.displayName,
                        icon: lang.icon,
                        isPrimary: lang.isPrimary,
                        foundIndicators: lang.foundIndicators,
                    }));
                    const primary = languages.find((l) => l.isPrimary);
                    return {
                        detected: formatted,
                        primary: primary ? primary.displayName : null,
                        message: `Detected ${languages.length} language(s): ${languages.map((l) => `${l.icon} ${l.displayName}`).join(", ")}`,
                    };
                } catch (error) {
                    return {
                        detected: [],
                        error: `Failed to detect: ${error instanceof Error ? error.message : String(error)}`,
                    };
                }
            }
            case "runtime": {
                const language = args.runtime;
                if (!language) {
                    return { installed: false, error: "Missing runtime parameter (language key)." };
                }
                try {
                    const { validateLanguageInstalled } = await import("../language_validator");
                    const result = await validateLanguageInstalled(language);
                    if (result.installed) {
                        return {
                            installed: true,
                            language: result.displayName,
                            version: result.version,
                            icon: result.icon,
                            message: `✓ ${result.displayName} is installed (${result.version})`,
                        };
                    }
                    return {
                        installed: false,
                        language: result.displayName,
                        icon: result.icon,
                        installUrl: result.installUrl,
                        message: `✗ ${result.displayName} is not installed. User can download from: ${result.installUrl}`,
                    };
                } catch (error) {
                    return {
                        installed: false,
                        error: `Failed to check: ${error instanceof Error ? error.message : String(error)}`,
                    };
                }
            }
            case "command_status": {
                const operation_id = args.command_id;
                const wait_ms = args.wait_ms ?? 0;
                if (!operation_id) {
                    return {
                        status: "error",
                        error: "No command_id provided. Use the ID returned from run_command.",
                    };
                }
                if (wait_ms > 0) {
                    await new Promise((resolve) => setTimeout(resolve, Math.min(wait_ms, 10000)));
                }
                return {
                    info:
                        "To check command status, observe the tool_result that follows your run_command call. " +
                        "If you see 'success: true' and output, the command completed.",
                    suggestion:
                        "Only call ONE run_command per response. Wait for the result in the next iteration before deciding your next action.",
                };
            }
            default:
                return { error: "Unknown operation" };
        }
    },
});

// ═══════════════════════════════════════════════════════════
// LIVE PREVIEW (dev server)
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "live_preview",
    category: ToolCategory.EXECUTION,
    description:
        "Start development server and return preview URL. Set port_only=true (with workspaceId) to read the managed dev server URL/port without starting a new process.",
    parameters: {
        workspace: {
            type: "string",
            description: "Project directory",
            required: false,
        },
        workspaceId: {
            type: "number",
            description: "Workspace ID (required when port_only is true)",
            required: false,
        },
        port: {
            type: "number",
            description: "Port number (default: auto-detect)",
            required: false,
        },
        port_only: {
            type: "boolean",
            description: "If true, only return dev server status/URL/port from the app-managed server (no start).",
            required: false,
        },
    },
    cost: 5,
    handler: async (params: {
        workspace?: string;
        workspaceId?: number;
        port?: number;
        port_only?: boolean;
    }) => {
        try {
            if (params.port_only) {
                const workspaceId = params.workspaceId;
                if (workspaceId == null) {
                    return "port_only requires workspaceId.";
                }
                const isRunning = devServerManager.isServerRunning(workspaceId);
                const url = devServerManager.getServerUrl(workspaceId);
                let port: number | null = null;
                if (url) {
                    const match = url.match(/:(\d+)/);
                    if (match) port = parseInt(match[1], 10);
                }
                const servers = devServerManager.getRunningServers();
                const currentServer = servers.find((s) => s.workspaceId === workspaceId);

                let output = `# Dev Server Status\n\n`;
                output += `**Running:** ${isRunning ? "Yes" : "No"}\n`;

                if (isRunning && url) {
                    output += `**URL:** ${url}\n`;
                    output += `**Port:** ${port}\n`;
                    if (currentServer) {
                        output += `**Framework:** ${currentServer.framework}\n`;
                    }
                    output += `\nUser can view the app in the **Preview** tab of the right panel.\n`;
                } else {
                    output += `\nNo dev server running for this workspace.\n`;
                }

                return output;
            }

            const workspace = params.workspace || process.cwd();

            const packageJsonPath = path.join(workspace, "package.json");
            let devCommand = "npm run dev";
            let defaultPort = 3000;

            try {
                assertReadablePath("package.json", workspace);
                const packageJson = JSON.parse(
                    await fs.readFile(packageJsonPath, "utf-8")
                );

                if (packageJson.dependencies?.next) {
                    devCommand = "npm run dev";
                    defaultPort = 3000;
                } else if (packageJson.devDependencies?.vite) {
                    devCommand = "npm run dev";
                    defaultPort = 5173;
                } else if (packageJson.dependencies?.react) {
                    devCommand = "npm start";
                    defaultPort = 3000;
                } else if (packageJson.scripts?.dev) {
                    devCommand = "npm run dev";
                }
            } catch (error) {
                // Use defaults
            }

            const port = params.port || defaultPort;

            const serverProcess = exec(devCommand, {
                cwd: workspace,
            });

            await new Promise(resolve => setTimeout(resolve, 3000));

            return {
                success: true,
                workspace,
                command: devCommand,
                url: `http://localhost:${port}`,
                port,
                process_id: serverProcess.pid,
                message: "Development server started. Use the URL to preview your app.",
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    },
});

// ═══════════════════════════════════════════════════════════
// STREAM TERMINAL OUTPUT
// ═══════════════════════════════════════════════════════════

const DEFAULT_MAX_LINES = 50;
const MAX_MAX_LINES = 200;
const DEFAULT_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

ToolRegistry.register({
    name: "stream_terminal_output",
    description:
        `Collect live output from a running stream.

Sources:
- terminal (default): output from run_command executions in this chat.
- pipeline: logs from a connected CI/CD job (GitHub Actions etc.). Requires jobId.

Returns collected lines (subject to maxLines / maxBytes / timeoutMs caps).`,
    category: ToolCategory.EXECUTION,
    cost: 2,
    requiresWorkspace: false,
    isCore: true,
    isReadOnly: true,
    parameters: createParameters(
        {
            source: {
                type: "string",
                enum: ["terminal", "pipeline"],
                description: "Stream source. terminal=this chat's run_command output (default); pipeline=connected CI job.",
                default: "terminal",
            },
            jobId: {
                type: "number",
                description: "(pipeline only) CI job id (e.g. GitHub Actions job id).",
            },
            pattern: stringParam("Optional regex pattern to filter lines (e.g. 'error|Error'). If omitted, all lines are collected."),
            mode: stringParam("(terminal only) Collection mode when pattern is omitted: error_first | progress_first | raw_capped (default: error_first)."),
            maxLines: {
                type: "number",
                description: `Max lines to collect (default ${DEFAULT_MAX_LINES}, max ${MAX_MAX_LINES}).`,
            },
            maxBytes: {
                type: "number",
                description: "Max bytes to collect (approx; default 64000, max 1000000).",
            },
            timeoutMs: {
                type: "number",
                description: `How long to wait for output in ms (default ${DEFAULT_TIMEOUT_MS}).`,
            },
        },
        []
    ),
    handler: async (args: any) => {
        const source: "terminal" | "pipeline" = args.source === "pipeline" ? "pipeline" : "terminal";
        const pattern = args.pattern ?? "";
        const modeRaw = String(args.mode ?? "").trim();
        const mode =
            modeRaw === "progress_first" || modeRaw === "raw_capped" || modeRaw === "error_first"
                ? modeRaw
                : "error_first";
        const maxLines = Math.min(MAX_MAX_LINES, Math.max(1, Number(args.maxLines) || DEFAULT_MAX_LINES));
        const maxBytes = Math.min(1_000_000, Math.max(1024, Number(args.maxBytes) || 64_000));
        const timeoutMs = Math.max(1000, Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS);
        const chatId = args.chatId ?? null;
        const sendToolActivity = args._sendToolActivity as ((label: string) => () => void) | undefined;

        let endActivity: (() => void) | undefined;
        if (sendToolActivity) {
            endActivity = sendToolActivity(
                source === "pipeline" ? "AI is monitoring pipeline..." : "AI is watching terminal..."
            );
        }

        try {
            if (source === "pipeline") {
                const jobId = Number(args.jobId);
                if (!Number.isFinite(jobId)) {
                    if (endActivity) endActivity();
                    return "stream_terminal_output({ source: 'pipeline' }) requires a jobId.";
                }
                const streamId = openStream("pipeline", {
                    chatId,
                    filter: args.filter ?? pattern ?? null,
                    maxLines,
                    timeoutMs: Math.max(timeoutMs, 60_000),
                    jobId,
                });
                await sleep(2000);
                setStreamInactive(streamId);
                getCollectedLines(streamId);
                closeStream(streamId);
                if (endActivity) endActivity();
                return "Pipeline log streaming is available when a CI provider (e.g. GitHub Actions) is connected. Connect GitHub in Settings → Extensions to monitor workflow runs and job logs.";
            }

            const streamId = openStream("terminal", {
                chatId,
                filter: pattern || null,
                mode: pattern ? undefined : (mode as any),
                maxLines,
                maxBytes,
                timeoutMs,
            });

            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const { lines, active } = getCollectedLines(streamId);
                if (!active || lines.length >= maxLines) break;
                await sleep(500);
            }

            const { lines } = getCollectedLines(streamId);
            closeStream(streamId);
            if (endActivity) endActivity();

            if (lines.length === 0) {
                return "No terminal output collected within the timeout. Run a command (e.g. run_command) in this chat to produce output.";
            }
            return lines.join("\n");
        } catch (err) {
            if (endActivity) endActivity();
            throw err;
        }
    },
});

// ═══════════════════════════════════════════════════════════
// DIAGNOSE ISSUE (workspace/file analysis)
// ═══════════════════════════════════════════════════════════

function detectLanguage(filepath: string): string {
    const ext = path.extname(filepath);
    const langMap: Record<string, string> = {
        ".js": "javascript",
        ".jsx": "javascript",
        ".ts": "typescript",
        ".tsx": "typescript",
        ".py": "python",
        ".java": "java",
        ".go": "go",
        ".rs": "rust",
        ".cpp": "cpp",
        ".c": "c",
    };
    return langMap[ext] || "unknown";
}

function calculateImpactLevel(dependencyCount: number): string {
    if (dependencyCount === 0) return "none";
    if (dependencyCount < 3) return "low";
    if (dependencyCount < 10) return "medium";
    return "high";
}

async function analyzeContextForFile(filepath: string, workspaceRoot: string) {
    try {
        assertReadablePath(filepath, workspaceRoot);
        const resolved = path.isAbsolute(filepath)
            ? path.resolve(filepath)
            : path.resolve(workspaceRoot, filepath);
        const content = await fs.readFile(resolved, "utf-8");
        const lines = content.split("\n");

        const context = {
            filepath,
            language: detectLanguage(filepath),
            imports: [] as string[],
            exports: [] as string[],
            classes: [] as Array<{ name: string; line: number; methods: string[] }>,
            functions: [] as Array<{ name: string; line: number; params: string[] }>,
            variables: [] as Array<{ name: string; line: number; type: string }>,
            total_lines: lines.length,
            code_lines: 0,
            comment_lines: 0,
        };

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            if (line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) {
                context.comment_lines++;
            } else {
                context.code_lines++;
            }

            if (line.startsWith("import ") || line.includes("require(")) {
                const importMatch = line.match(/from ['"]([^'"]+)['"]/);
                if (importMatch) context.imports.push(importMatch[1]);
            }

            if (line.startsWith("export ")) context.exports.push(line);

            const classMatch = line.match(/class\s+(\w+)/);
            if (classMatch) {
                const className = classMatch[1];
                const methods: string[] = [];
                for (let j = i + 1; j < Math.min(i + 100, lines.length); j++) {
                    const methodMatch = lines[j].match(/(\w+)\s*\([^)]*\)\s*{/);
                    if (methodMatch) methods.push(methodMatch[1]);
                    if (lines[j].includes("}") && lines[j].trim() === "}") break;
                }
                context.classes.push({ name: className, line: i + 1, methods });
            }

            const funcMatch = line.match(/function\s+(\w+)\s*\(([^)]*)\)/);
            const arrowMatch = line.match(/const\s+(\w+)\s*=\s*\(([^)]*)\)\s*=>/);

            if (funcMatch) {
                context.functions.push({
                    name: funcMatch[1],
                    line: i + 1,
                    params: funcMatch[2].split(",").map((p) => p.trim()).filter(Boolean),
                });
            } else if (arrowMatch) {
                context.functions.push({
                    name: arrowMatch[1],
                    line: i + 1,
                    params: arrowMatch[2].split(",").map((p) => p.trim()).filter(Boolean),
                });
            }

            const varMatch = line.match(/(const|let|var)\s+(\w+)/);
            if (varMatch && !line.includes("function") && !line.includes("=>")) {
                context.variables.push({ name: varMatch[2], line: i + 1, type: varMatch[1] });
            }
        }

        return { success: true as const, ...context };
    } catch (error) {
        return { success: false as const, error: error instanceof Error ? error.message : "Unknown error" };
    }
}

async function runDiagnose(params: { filepath: string; workspace: string }) {
    assertReadablePath(params.filepath, params.workspace);
    const resolved = path.isAbsolute(params.filepath)
        ? path.resolve(params.filepath)
        : path.resolve(params.workspace, params.filepath);
    const issues: Array<{ type: string; message: string; line?: number }> = [];
    const content = await fs.readFile(resolved, "utf-8");
    const lines = content.split("\n");

    lines.forEach((line, index) => {
        if (line.includes("TODO") || line.includes("FIXME")) {
            issues.push({ type: "todo", message: line.trim(), line: index + 1 });
        }
    });
    lines.forEach((line, index) => {
        if (line.includes("console.log") || line.includes("console.error")) {
            issues.push({ type: "debug", message: "Debug statement found", line: index + 1 });
        }
    });
    lines.forEach((line, index) => {
        if (line.length > 120) {
            issues.push({ type: "style", message: `Line too long (${line.length} characters)`, line: index + 1 });
        }
    });
    const hasTryCatch = content.includes("try") && content.includes("catch");
    const hasAsync = content.includes("async");
    if (hasAsync && !hasTryCatch) {
        issues.push({ type: "warning", message: "Async code without try-catch" });
    }

    return {
        success: true,
        analysis_type: "diagnose",
        filepath: params.filepath,
        issues,
        issue_count: issues.length,
        severity: issues.length > 10 ? "high" : issues.length > 5 ? "medium" : "low",
    };
}

async function runHealthCheck(workspace: string) {
    const health = {
        overall_score: 0,
        checks: [] as Array<{ name: string; status: string; message: string }>,
    };

    try {
        await fs.access(path.join(workspace, "package.json"));
        health.checks.push({ name: "package.json", status: "pass", message: "Found package.json" });
    } catch {
        health.checks.push({ name: "package.json", status: "fail", message: "No package.json found" });
    }
    try {
        await fs.access(path.join(workspace, "node_modules"));
        health.checks.push({ name: "dependencies", status: "pass", message: "Dependencies installed" });
    } catch {
        health.checks.push({ name: "dependencies", status: "warn", message: "Dependencies not installed" });
    }
    try {
        await execAsync("git rev-parse --git-dir", { cwd: workspace });
        health.checks.push({ name: "version_control", status: "pass", message: "Git initialized" });
    } catch {
        health.checks.push({ name: "version_control", status: "warn", message: "Not a git repository" });
    }
    try {
        await fs.access(path.join(workspace, "README.md"));
        health.checks.push({ name: "documentation", status: "pass", message: "README exists" });
    } catch {
        health.checks.push({ name: "documentation", status: "warn", message: "No README found" });
    }

    const passCount = health.checks.filter((c) => c.status === "pass").length;
    health.overall_score = Math.round((passCount / health.checks.length) * 100);
    return { success: true, analysis_type: "health_check", workspace, ...health };
}

async function runChangeImpact(params: { filepath: string; workspace: string }) {
    assertReadablePath(params.filepath, params.workspace);
    const fileName = path.basename(params.filepath, path.extname(params.filepath));
    const { stdout } = await execAsync(
        `rg "import.*${fileName}" "${params.workspace}" -l --type js --type ts`,
        { maxBuffer: 10 * 1024 * 1024 }
    ).catch(() => ({ stdout: "" }));

    const dependents = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .filter((file) => file !== params.filepath);

    const analysis = await analyzeContextForFile(params.filepath, params.workspace);

    return {
        success: true,
        analysis_type: "change_impact",
        filepath: params.filepath,
        dependent_files: dependents,
        dependency_count: dependents.length,
        impact_level: calculateImpactLevel(dependents.length),
        file_analysis: analysis.success ? analysis : { success: false, error: analysis.error },
    };
}

ToolRegistry.register({
    name: "diagnose_issue",
    category: ToolCategory.CODE,
    description:
        `Run analysis on a file or workspace. Three analysis types:
- diagnose (default): lint/heuristic checks on a single file (TODOs, debug statements, long lines, async without try/catch).
- health_check: workspace-wide checks (package.json, dependencies, git, README).
- change_impact: dependency / blast-radius analysis for a single file.`,
    parameters: {
        filepath: {
            type: "string",
            description: "(diagnose / change_impact) File to analyze.",
            required: false,
        },
        workspace: {
            type: "string",
            description: "(health_check / change_impact) Workspace path.",
            required: false,
        },
        analysis_type: {
            type: "string",
            enum: ["diagnose", "health_check", "change_impact"],
            description: "Which analysis to run. Default: diagnose.",
        },
    },
    cost: 5,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true,
    handler: async (params: { filepath?: string; workspace?: string; analysis_type?: string }) => {
        try {
            const type = params.analysis_type ?? "diagnose";
            if (type === "health_check") {
                return await runHealthCheck(params.workspace || process.cwd());
            }
            if (type === "change_impact") {
                if (!params.filepath) return { success: false, error: "change_impact requires filepath" };
                const ws = params.workspace || process.cwd();
                return await runChangeImpact({ filepath: params.filepath, workspace: ws });
            }
            if (!params.filepath) return { success: false, error: "diagnose requires filepath" };
            const ws = params.workspace || process.cwd();
            return await runDiagnose({ filepath: params.filepath, workspace: ws });
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
        }
    },
});
