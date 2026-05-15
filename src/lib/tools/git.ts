/**
 * Atlarix Git Tools
 * =================
 * Read-only git inspection: status, diff, log.
 *
 * Absorbs: git-tools. Adds `git_log` (previously a phantom listed in mode
 * allowlists / MODE_SYSTEM_TOOL_LISTS but never registered).
 */

import {
    ToolRegistry,
    ToolCategory,
    createParameters,
    stringParam,
    numberParam,
} from "./registry";
import { exec } from "child_process";
import { promisify } from "util";
import { SessionTracker } from "../SessionTracker";

const execAsync = promisify(exec);

// ═══════════════════════════════════════════════════════════
// GIT STATUS
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "git_status",
    category: ToolCategory.GIT,
    description:
        "Get git repository status (modified, staged, branch info). When workspaceId is provided, includes a compact session-change summary (same signals as the former get_session_changes tool).",
    cost: 2,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true,
    parameters: {
        workspace: {
            type: "string",
            description: "Repository path (defaults to current directory)",
            required: false,
        },
        workspaceId: {
            type: "number",
            description: "When set with workspace path, adds session change / diagram-drift summary for this workspace.",
            required: false,
        },
    },
    handler: async (params: { workspace?: string; workspaceId?: number }) => {
        try {
            const cwd = params.workspace || process.cwd();

            try {
                await execAsync("git rev-parse --git-dir", { cwd });
            } catch {
                return {
                    success: false,
                    error: "Not a git repository",
                };
            }

            const { stdout: branch } = await execAsync("git branch --show-current", { cwd });

            const { stdout: status } = await execAsync("git status --porcelain", { cwd });

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

            const { stdout: lastCommit } = await execAsync(
                'git log -1 --pretty=format:"%H|%an|%ae|%s|%ar"',
                { cwd }
            );

            const [hash, author, email, message, timeAgo] = lastCommit.split("|");

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

            const base = {
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

            let session: Record<string, unknown> | undefined;
            const wid = params.workspaceId;
            if (typeof wid === "number" && Number.isFinite(wid)) {
                try {
                    const tracker = SessionTracker.getInstance(wid);
                    if (!tracker.isInitialized) {
                        await tracker.initialize(cwd);
                    }
                    const state = tracker.getSessionState();
                    session = {
                        change_percentage: state.changePercentage,
                        diagram_status: state.diagramStatus,
                        recommended_action: state.recommendedAction,
                        changed_files_sample: state.changedFiles.slice(0, 20),
                        changed_files_total: state.changedFiles.length,
                        files_added: state.filesAdded,
                        files_modified: state.filesModified,
                        files_deleted: state.filesDeleted,
                    };
                } catch {
                    // optional enrichment
                }
            }

            return session ? { ...base, session } : base;
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    },
});

// ═══════════════════════════════════════════════════════════
// GIT DIFF
// ═══════════════════════════════════════════════════════════

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
            description: "Git diff context lines (0–20, default 3)",
            required: false,
            default: 3,
        },
        max_lines: {
            type: "number",
            description: "Max lines of diff output to return (default 2000, max 10000)",
            required: false,
            default: 2000,
        },
    },
    cost: 3,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true,
    handler: async (params: {
        workspace?: string;
        target?: string;
        staged?: boolean;
        context_lines?: number;
        max_lines?: number;
    }) => {
        try {
            const cwd = params.workspace || process.cwd();
            const contextLines = Math.min(
                20,
                Math.max(0, Math.floor(Number(params.context_lines) || 3)),
            );
            const maxLines = Math.min(
                10_000,
                Math.max(1, Math.floor(Number(params.max_lines) || 2000)),
            );

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

            const diffLines = stdout.split("\n");
            const truncated = diffLines.length > maxLines;
            const diffOut = truncated
                ? diffLines.slice(0, maxLines).join("\n") +
                    `\n\n… [diff truncated at max_lines=${maxLines}; pass a lower context_lines or scope to a file]`
                : stdout;

            const parsedDiff = parseDiff(diffOut);

            return {
                success: true,
                diff: diffOut,
                parsed: parsedDiff,
                files_changed: parsedDiff.length,
                truncated: truncated || undefined,
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
// GIT LOG (was a phantom — now registered)
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "git_log",
    category: ToolCategory.GIT,
    description:
        "Show git commit history (most recent first). Optional path scopes to a file/dir; optional branch picks a ref; limit caps results (default 20, max 500).",
    cost: 2,
    requiresWorkspace: true,
    isCore: true,
    isReadOnly: true,
    parameters: createParameters(
        {
            workspace: stringParam("Repository path (defaults to current directory)"),
            path: stringParam("Optional path/dir/file to filter history"),
            branch: stringParam("Optional branch or ref (defaults to current HEAD)"),
            limit: numberParam("Max commits to return (default 20, max 500)", 20, 1, 500),
        },
        [],
    ),
    handler: async (params: {
        workspace?: string;
        path?: string;
        branch?: string;
        limit?: number;
    }) => {
        try {
            const cwd = params.workspace || process.cwd();

            try {
                await execAsync("git rev-parse --git-dir", { cwd });
            } catch {
                return { success: false, error: "Not a git repository" };
            }

            const limit = Math.min(500, Math.max(1, Number(params.limit) || 20));
            const branchArg = params.branch ? ` ${shellEscape(params.branch)}` : "";
            const pathArg = params.path ? ` -- ${shellEscape(params.path)}` : "";
            const command = `git log --pretty=format:"%H|%h|%an|%ae|%ar|%s" -n ${limit}${branchArg}${pathArg}`;

            const { stdout } = await execAsync(command, {
                cwd,
                maxBuffer: 10 * 1024 * 1024,
            });

            const trimmed = stdout.trim();
            if (!trimmed) {
                return { success: true, commits: [], message: "No commits found" };
            }

            const commits = trimmed
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                    const [hash, shortHash, author, email, timeAgo, ...rest] = line.split("|");
                    return {
                        hash,
                        short_hash: shortHash,
                        author,
                        email,
                        time_ago: timeAgo,
                        message: rest.join("|"),
                    };
                });

            return {
                success: true,
                count: commits.length,
                branch: params.branch ?? "HEAD",
                path: params.path,
                commits,
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
// HELPERS
// ═══════════════════════════════════════════════════════════

function shellEscape(value: string): string {
    return `"${String(value).replace(/(["\\$`])/g, "\\$1")}"`;
}

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

        else if (line.startsWith("@@")) {
            if (currentFile) {
                if (currentChunk) {
                    currentFile.chunks.push(currentChunk);
                }
                currentChunk = {
                    header: line,
                    lines: [],
                };
                const match = line.match(/@@ -(\d+)/);
                lineNumber = match ? parseInt(match[1]) : 0;
            }
        }

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

    if (currentFile) {
        if (currentChunk) {
            currentFile.chunks.push(currentChunk);
        }
        files.push(currentFile);
    }

    return files;
}
