/**
 * Git Integration Tools
 * ====================
 * Version control operations and diff viewing
 */

import { ToolRegistry, ToolCategory } from "./registry";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";

const execAsync = promisify(exec);

// ============================================
// GIT STATUS
// ============================================

/**
 * Get current git repository status
 */
ToolRegistry.register({
    name: "git_status",
    category: ToolCategory.GIT,
    description: "Get git repository status (modified, staged, branch info)",
    cost: 2,
    requiresWorkspace: true,
    isCore: true,
    parameters: {
        workspace: {
            type: "string",
            description: "Repository path (defaults to current directory)",
            required: false,
        },
    },
    handler: async (params: { workspace?: string }) => {
        try {
            const cwd = params.workspace || process.cwd();

            // Check if it's a git repo
            try {
                await execAsync("git rev-parse --git-dir", { cwd });
            } catch {
                return {
                    success: false,
                    error: "Not a git repository",
                };
            }

            // Get branch name
            const { stdout: branch } = await execAsync("git branch --show-current", { cwd });

            // Get status
            const { stdout: status } = await execAsync("git status --porcelain", { cwd });

            // Parse status
            const files = status
                .trim()
                .split("\n")
                .filter(Boolean)
                .map(line => {
                    const statusCode = line.substring(0, 2);
                    const filepath = line.substring(3);

                    return {
                        status: parseGitStatus(statusCode),
                        filepath,
                    };
                });

            // Get commit info
            const { stdout: lastCommit } = await execAsync(
                'git log -1 --pretty=format:"%H|%an|%ae|%s|%ar"',
                { cwd }
            );

            const [hash, author, email, message, timeAgo] = lastCommit.split("|");

            // Check for ahead/behind
            let ahead = 0;
            let behind = 0;
            try {
                const { stdout: trackingInfo } = await execAsync(
                    "git rev-list --left-right --count HEAD...@{upstream}",
                    { cwd }
                );
                const [aheadCount, behindCount] = trackingInfo.trim().split("\t");
                ahead = parseInt(aheadCount);
                behind = parseInt(behindCount);
            } catch {
                // No upstream or not tracking
            }

            return {
                success: true,
                branch: branch.trim(),
                files,
                total_changes: files.length,
                modified: files.filter(f => f.status === "modified").length,
                staged: files.filter(f => f.status === "staged").length,
                untracked: files.filter(f => f.status === "untracked").length,
                deleted: files.filter(f => f.status === "deleted").length,
                ahead,
                behind,
                last_commit: {
                    hash: hash.substring(0, 7),
                    author,
                    email,
                    message,
                    time_ago: timeAgo,
                },
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
// GIT DIFF
// ============================================

/**
 * Show git diff for files or commits
 */
ToolRegistry.register({
    name: "git_diff",
    category: ToolCategory.GIT,
    description: "Show git diff (unstaged, staged, or between commits)",
    parameters: {
        workspace: {
            type: "string",
            description: "Repository path",
            required: false,
        },
        target: {
            type: "string",
            description: "Specific file, commit hash, or branch",
            required: false,
        },
        staged: {
            type: "boolean",
            description: "Show staged changes (default: unstaged)",
            required: false,
            default: false,
        },
        context_lines: {
            type: "number",
            description: "Number of context lines",
            required: false,
            default: 3,
        },
    },
    cost: 3,
    handler: async (params: {
        workspace?: string;
        target?: string;
        staged?: boolean;
        context_lines?: number;
    }) => {
        try {
            const cwd = params.workspace || process.cwd();
            const contextLines = params.context_lines || 3;

            let command = `git diff -U${contextLines}`;

            if (params.staged) {
                command += " --staged";
            }

            if (params.target) {
                command += ` ${params.target}`;
            }

            const { stdout } = await execAsync(command, {
                cwd,
                maxBuffer: 10 * 1024 * 1024,
            });

            if (!stdout.trim()) {
                return {
                    success: true,
                    diff: "",
                    message: "No changes to show",
                };
            }

            // Parse diff into structured format
            const parsedDiff = parseDiff(stdout);

            return {
                success: true,
                diff: stdout,
                parsed: parsedDiff,
                files_changed: parsedDiff.length,
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

function parseGitStatus(code: string): string {
    const statusMap: Record<string, string> = {
        "M ": "modified",
        " M": "modified",
        "MM": "modified",
        "A ": "staged",
        "AM": "staged",
        "??": "untracked",
        " D": "deleted",
        "D ": "deleted",
        "R ": "renamed",
        "C ": "copied",
    };

    return statusMap[code] || "unknown";
}

interface DiffFile {
    filename: string;
    additions: number;
    deletions: number;
    chunks: Array<{
        header: string;
        lines: Array<{
            type: "add" | "remove" | "context";
            content: string;
            lineNumber: number;
        }>;
    }>;
}

function parseDiff(diffText: string): DiffFile[] {
    const files: DiffFile[] = [];
    const lines = diffText.split("\n");

    let currentFile: DiffFile | null = null;
    let currentChunk: any = null;
    let lineNumber = 0;

    for (const line of lines) {
        // New file
        if (line.startsWith("diff --git")) {
            if (currentFile) {
                files.push(currentFile);
            }
            currentFile = {
                filename: line.split(" b/")[1] || "",
                additions: 0,
                deletions: 0,
                chunks: [],
            };
            currentChunk = null;
        }

        // Chunk header
        else if (line.startsWith("@@")) {
            if (currentFile) {
                if (currentChunk) {
                    currentFile.chunks.push(currentChunk);
                }
                currentChunk = {
                    header: line,
                    lines: [],
                };
                // Extract line number from header
                const match = line.match(/@@ -(\d+)/);
                lineNumber = match ? parseInt(match[1]) : 0;
            }
        }

        // Additions
        else if (line.startsWith("+") && !line.startsWith("+++")) {
            if (currentFile && currentChunk) {
                currentChunk.lines.push({
                    type: "add",
                    content: line.substring(1),
                    lineNumber: lineNumber++,
                });
                currentFile.additions++;
            }
        }

        // Deletions
        else if (line.startsWith("-") && !line.startsWith("---")) {
            if (currentFile && currentChunk) {
                currentChunk.lines.push({
                    type: "remove",
                    content: line.substring(1),
                    lineNumber: lineNumber++,
                });
                currentFile.deletions++;
            }
        }

        // Context
        else if (line.startsWith(" ")) {
            if (currentFile && currentChunk) {
                currentChunk.lines.push({
                    type: "context",
                    content: line.substring(1),
                    lineNumber: lineNumber++,
                });
            }
        }
    }

    // Add last file
    if (currentFile) {
        if (currentChunk) {
            currentFile.chunks.push(currentChunk);
        }
        files.push(currentFile);
    }

    return files;
}
