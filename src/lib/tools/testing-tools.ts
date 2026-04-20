/**
 * Testing & Execution Tools
 * =========================
 * Test automation and live preview
 */

import { ToolRegistry, ToolCategory } from "./registry";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const execAsync = promisify(exec);

// ============================================
// TEST CHANGES
// ============================================

/**
 * Run tests on modified code
 */
ToolRegistry.register({
    name: "test_changes",
    category: ToolCategory.EXECUTION,
    description: "Run project tests with optional file targeting",
    parameters: {
        workspace: {
            type: "string",
            description: "Project directory",
            required: false,
        },
        test_file: {
            type: "string",
            description: "Specific test file to run",
            required: false,
        },
        watch: {
            type: "boolean",
            description: "Run in watch mode",
            required: false,
            default: false,
        },
    },
    cost: 8,
    handler: async (params: {
        workspace?: string;
        test_file?: string;
        watch?: boolean;
    }) => {
        try {
            const workspace = params.workspace || process.cwd();

            // Detect test framework
            const packageJsonPath = path.join(workspace, "package.json");
            let testCommand = "npm test";
            const hasBunLock = await fs
                .access(path.join(workspace, "bun.lockb"))
                .then(() => true)
                .catch(() => false);
            if (hasBunLock) testCommand = "bun test";

            try {
                const packageJson = JSON.parse(
                    await fs.readFile(packageJsonPath, "utf-8")
                );

                // Check for common test frameworks
                if (packageJson.devDependencies?.jest || packageJson.dependencies?.jest) {
                    testCommand = "npx jest";
                } else if (
                    packageJson.devDependencies?.vitest ||
                    packageJson.dependencies?.vitest
                ) {
                    testCommand = "npx vitest run";
                } else if (
                    packageJson.devDependencies?.mocha ||
                    packageJson.dependencies?.mocha
                ) {
                    testCommand = "npx mocha";
                }

                // Add watch flag if requested
                if (params.watch) {
                    if (testCommand.includes("jest")) {
                        testCommand += " --watch";
                    } else if (testCommand.includes("vitest")) {
                        testCommand = testCommand.replace("run", "");
                    }
                }

                // Add specific file if provided
                if (params.test_file) {
                    testCommand += ` ${params.test_file}`;
                }
            } catch (error) {
                // Use default npm test
            }

            // Run tests
            const startTime = Date.now();
            const { stdout, stderr } = await execAsync(testCommand, {
                cwd: workspace,
                maxBuffer: 10 * 1024 * 1024,
            });
            const duration = Date.now() - startTime;

            // Parse test results
            const results = parseTestOutput(stdout + stderr);

            return {
                success: results.failed === 0,
                workspace,
                test_command: testCommand,
                ...results,
                duration_ms: duration,
                output: stdout,
                errors: stderr || null,
            };
        } catch (error: any) {
            // Tests failed
            const output = error.stdout || "";
            const errorOutput = error.stderr || error.message;
            const results = parseTestOutput(output + errorOutput);

            return {
                success: false,
                ...results,
                output,
                errors: errorOutput,
            };
        }
    },
});

// ============================================
// LIVE PREVIEW
// ============================================

/**
 * Start development server for live preview
 */
ToolRegistry.register({
    name: "live_preview",
    category: ToolCategory.EXECUTION,
    description: "Start development server and return preview URL",
    parameters: {
        workspace: {
            type: "string",
            description: "Project directory",
            required: false,
        },
        port: {
            type: "number",
            description: "Port number (default: auto-detect)",
            required: false,
        },
    },
    cost: 5,
    handler: async (params: {
        workspace?: string;
        port?: number;
    }) => {
        try {
            const workspace = params.workspace || process.cwd();

            // Detect framework and dev command
            const packageJsonPath = path.join(workspace, "package.json");
            let devCommand = "npm run dev";
            let defaultPort = 3000;

            try {
                const packageJson = JSON.parse(
                    await fs.readFile(packageJsonPath, "utf-8")
                );

                // Detect framework
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

            // Start server in background
            const serverProcess = exec(devCommand, {
                cwd: workspace,
            });

            // Wait for server to start (simple approach)
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

// ============================================
// HELPER FUNCTIONS
// ============================================

interface TestResults {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    duration?: string;
}

function parseTestOutput(output: string): TestResults {
    const results: TestResults = {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
    };

    // Jest/Vitest pattern
    const jestMatch = output.match(/Tests:\s+(\d+)\s+failed,\s+(\d+)\s+passed,\s+(\d+)\s+total/);
    if (jestMatch) {
        results.failed = parseInt(jestMatch[1]);
        results.passed = parseInt(jestMatch[2]);
        results.total = parseInt(jestMatch[3]);
    }

    // Alternative pattern
    const altMatch = output.match(/(\d+)\s+passing/);
    if (altMatch && !jestMatch) {
        results.passed = parseInt(altMatch[1]);
        results.total = results.passed;
    }

    const failMatch = output.match(/(\d+)\s+failing/);
    if (failMatch) {
        results.failed = parseInt(failMatch[1]);
        results.total += results.failed;
    }

    // Duration
    const durationMatch = output.match(/Time:\s+([\d.]+\s*s)/);
    if (durationMatch) {
        results.duration = durationMatch[1];
    }

    return results;
}
