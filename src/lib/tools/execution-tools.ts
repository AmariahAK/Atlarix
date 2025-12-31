/**
 * Atlarix Execution Tools
 * =======================
 * Tools for running commands and asking user for input
 */

import { exec } from "child_process";
import { promisify } from "util";
import {
    ToolRegistry,
    ToolCategory,
    createParameters,
    stringParam,
    booleanParam,
} from "./registry";

const execAsync = promisify(exec);

// ═══════════════════════════════════════════════════════════
// COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "run_command",
    description:
        "Execute a shell command in the workspace. Shows permission dialog before running.",
    category: ToolCategory.EXECUTION,
    cost: 3,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: false, // Build mode only - executes commands
    parameters: createParameters(
        {
            command: stringParam("Shell command to execute"),
            cwd: stringParam("Working directory (default: workspace root)"),
            description: stringParam("What this command does"),
        },
        ["command", "description"]
    ),
    handler: async ({ command, cwd = ".", description }) => {
        // Check for dangerous patterns
        const dangerousPatterns = [
            /rm\s+-rf/,
            /sudo/,
            /curl.*\|.*bash/,
            /wget.*\|.*sh/,
            /chmod\s+777/,
        ];
        const isDangerous = dangerousPatterns.some(pattern => pattern.test(command));

        // Return structured permission request (JSON format)
        return {
            __permission_required: true,
            operation: "run_command",
            preview: {
                command,
                workingDirectory: cwd,
                description,
                isDangerous,
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
        "Run the project's test suite. Detects test framework automatically (npm test, pytest, etc.)",
    category: ToolCategory.EXECUTION,
    cost: 3,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: false, // Build mode only - executes test commands
    parameters: createParameters(
        {
            test_path: stringParam("Optional: Specific test file or pattern to run"),
            framework: stringParam(
                "Optional: Test framework (npm, pytest, jest, vitest)"
            ),
        },
        []
    ),
    handler: async ({ test_path, framework }) => {
        // Auto-detect test command
        let command = "npm test";

        if (framework) {
            switch (framework.toLowerCase()) {
                case "pytest":
                    command = test_path ? `pytest ${test_path}` : "pytest";
                    break;
                case "jest":
                    command = test_path ? `jest ${test_path}` : "jest";
                    break;
                case "vitest":
                    command = test_path ? `vitest ${test_path}` : "vitest run";
                    break;
                default:
                    command = framework;
            }
        }

        return `__PERMISSION_REQUIRED__\n🧪 Run Tests\n\nCommand: \`${command}\`${test_path ? `\nPath: ${test_path}` : ""}\n\n[Approve] [Reject]`;
    },
});

// ═══════════════════════════════════════════════════════════
// USER INPUT
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "ask_user",
    description:
        "Ask the user a question and wait for their response. Use for clarifications or choices.",
    category: ToolCategory.EXECUTION,
    cost: 0,
    requiresWorkspace: false,
    isCore: true,
    isReadOnly: true, // Safe for Ask mode - just asks questions
    parameters: createParameters(
        {
            question: stringParam("Question to ask the user"),
            options: {
                type: "array",
                items: { type: "string" },
                description: "Optional: List of choices for the user",
            },
        },
        ["question"]
    ),
    handler: async ({ question, options }) => {
        let prompt = `❓ ${question}`;

        if (options && options.length > 0) {
            prompt += `\n\nOptions:\n`;
            options.forEach((opt: string, idx: number) => {
                prompt += `${idx + 1}. ${opt}\n`;
            });
        }

        return `__PERMISSION_REQUIRED__\n${prompt}\n\n[Your response]`;
    },
});

// ═══════════════════════════════════════════════════════════════════════════
// PROJECT ENVIRONMENT INFO
// ═══════════════════════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "get_project_info",
    description:
        "Get information about the current project (framework, available npm scripts, dependencies). ALWAYS call this BEFORE running any npm/yarn commands to get the correct command syntax for this project.",
    category: ToolCategory.EXECUTION,
    cost: 1,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true, // Safe - only reads package.json
    parameters: createParameters(
        {
            info_type: stringParam(
                "What info to get: 'scripts' (npm scripts), 'dev' (how to start dev server), 'build' (how to build), 'framework' (what framework), 'all' (everything)"
            ),
            workspace: stringParam("Workspace path (automatically provided)"),
        },
        ["info_type"]
    ),
    handler: async (params: { info_type?: string; workspace?: string }) => {
        // Import dynamically to avoid circular dependencies
        const { detectProjectEnvironment, getProjectSummary } = await import("../project_environment");

        const workspace = params.workspace || process.cwd();
        const env = await detectProjectEnvironment(workspace);

        if (!env.hasPackageJson) {
            return "No package.json found in this workspace. This might not be a Node.js project.";
        }

        const info_type = params.info_type;

        switch (info_type?.toLowerCase()) {
            case 'dev':
            case 'start':
                if (env.devCommand) {
                    return `To start the development server, run: ${env.devCommand}\n\nAvailable scripts: ${env.scripts.dev ? 'npm run dev' : ''} ${env.scripts.start ? 'npm start' : ''}`.trim();
                }
                return "No dev/start script found in package.json.";

            case 'build':
                if (env.buildCommand) {
                    return `To build the project, run: ${env.buildCommand}`;
                }
                return "No build script found in package.json.";

            case 'scripts':
                const scriptLines = Object.entries(env.scripts)
                    .filter(([, v]) => v)
                    .map(([k, v]) => `  npm run ${k} → ${v}`)
                    .join('\n');
                return scriptLines || "No scripts defined in package.json.";

            case 'framework':
                return `Framework: ${env.framework}${env.name ? `\nProject: ${env.name}` : ''}`;

            case 'all':
            default:
                return getProjectSummary(env);
        }
    },
});
