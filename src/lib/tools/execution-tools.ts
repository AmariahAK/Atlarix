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
        // Return permission request
        return `__PERMISSION_REQUIRED__\n⚡ Run Command: ${description}\n\nCommand: \`${command}\`\nDirectory: ${cwd}\n\n⚠️  This will execute on your system.\n\n[Approve] [Reject]`;
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
