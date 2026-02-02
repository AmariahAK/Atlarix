/**
 * GitChangeTracker - Git-based change analysis for diagram decisions
 * ===================================================================
 * Uses simple-git to analyze diffs since a baseline commit.
 * Enables accurate update vs regenerate decisions (bug fixes don't trigger refresh).
 */

import simpleGit, { SimpleGit, StatusResult } from "simple-git";
import * as path from "path";
import * as fs from "fs/promises";
import log from "electron-log";

const logger = log.scope("git-change-tracker");

// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════

export type FileChangeType = "A" | "M" | "D" | "R";

export interface FileChange {
    path: string;
    type: FileChangeType;
    insertions: number;
    deletions: number;
    binary: boolean;
}

export interface ChangeAnalysis {
    totalFiles: number;
    filesAdded: number;
    filesModified: number;
    filesDeleted: number;
    linesAdded: number;
    linesDeleted: number;
    changePercentage: number;
    isArchitecturalChange: boolean;
    changes: FileChange[];
}

// ═══════════════════════════════════════════════════════════
// GIT CHANGE TRACKER
// ═══════════════════════════════════════════════════════════

export class GitChangeTracker {
    private git: SimpleGit;

    constructor(private workspacePath: string) {
        this.git = simpleGit(workspacePath);
    }

    /**
     * Check if workspace is a git repository
     */
    async isGitRepo(): Promise<boolean> {
        try {
            await this.git.status();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get current HEAD commit hash (for storing in diagram metadata)
     */
    async getCurrentCommitHash(): Promise<string | undefined> {
        try {
            const log = await this.git.log({ maxCount: 1 });
            return log.latest?.hash;
        } catch (e) {
            logger.warn("[GitChangeTracker] getCurrentCommitHash failed:", e);
            return undefined;
        }
    }

    /**
     * Analyze changes since last diagram was generated (or HEAD)
     */
    async analyzeChanges(sinceCommit?: string): Promise<ChangeAnalysis> {
        const changes: FileChange[] = [];
        let projectFileCount = 0;

        try {
            const isRepo = await this.isGitRepo();
            if (!isRepo) {
                return this.emptyAnalysis();
            }

            const status: StatusResult = await this.git.status();

            // Uncommitted changes from status
            for (const file of status.files) {
                const type = this.statusToChangeType(file);
                changes.push({
                    path: file.path,
                    type,
                    insertions: 0,
                    deletions: 0,
                    binary: /\.(jpg|jpeg|png|gif|pdf|exe|woff2?|ico|webp)$/i.test(file.path),
                });
            }

            // Committed changes since baseline (diff summary)
            const baseLine = sinceCommit || "HEAD";
            try {
                const diffSummary = await this.git.diffSummary([baseLine]);
                const summary = diffSummary as { files: Array<{ file: string; insertions: number; deletions: number; binary?: boolean }> };
                if (summary?.files?.length) {
                    for (const f of summary.files) {
                        if (!changes.some((c) => c.path === f.file)) {
                            changes.push({
                                path: f.file,
                                type: this.inferChangeType(f.insertions, f.deletions),
                                insertions: f.insertions ?? 0,
                                deletions: f.deletions ?? 0,
                                binary: f.binary ?? false,
                            });
                        }
                    }
                }
            } catch (e) {
                // No diff (e.g. same commit) is fine
                logger.debug("[GitChangeTracker] diffSummary:", e);
            }

            projectFileCount = await this.countProjectFiles();
        } catch (e) {
            logger.warn("[GitChangeTracker] analyzeChanges failed:", e);
            return this.emptyAnalysis();
        }

        return this.buildAnalysis(changes, projectFileCount);
    }

    private statusToChangeType(file: { index?: string; working_dir?: string; path: string }): FileChangeType {
        const idx = file.index ?? "";
        const wd = file.working_dir ?? "";
        if (idx === "?" || wd === "?" || idx === "A") return "A";
        if (idx === "D" || wd === "D") return "D";
        if (idx === "R" || wd === "R") return "R";
        return "M";
    }

    private inferChangeType(insertions: number, deletions: number): FileChangeType {
        if (insertions > 0 && deletions === 0) return "A";
        if (deletions > 0 && insertions === 0) return "D";
        return "M";
    }

    private async countProjectFiles(): Promise<number> {
        const ignore = new Set([
            "node_modules",
            ".git",
            "dist",
            "build",
            ".next",
            ".nuxt",
            "coverage",
            ".cache",
            "__pycache__",
            ".vite",
        ]);
        let count = 0;
        const walk = async (dir: string, depth: number): Promise<void> => {
            if (depth > 8) return;
            try {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                for (const e of entries) {
                    if (ignore.has(e.name) || (e.name.startsWith(".") && e.name !== ".env")) continue;
                    const full = path.join(dir, e.name);
                    if (e.isDirectory()) await walk(full, depth + 1);
                    else count++;
                }
            } catch {
                // ignore
            }
        };
        await walk(this.workspacePath, 0);
        return Math.max(count, 1);
    }

    private buildAnalysis(changes: FileChange[], projectFileCount: number): ChangeAnalysis {
        const totalFiles = changes.length;
        const filesAdded = changes.filter((c) => c.type === "A").length;
        const filesModified = changes.filter((c) => c.type === "M").length;
        const filesDeleted = changes.filter((c) => c.type === "D").length;
        const linesAdded = changes.reduce((s, c) => s + c.insertions, 0);
        const linesDeleted = changes.reduce((s, c) => s + c.deletions, 0);
        const changePercentage = projectFileCount > 0 ? (totalFiles / projectFileCount) * 100 : 0;
        const isArchitecturalChange = this.detectArchitecturalChange(changes, changePercentage);

        return {
            totalFiles,
            filesAdded,
            filesModified,
            filesDeleted,
            linesAdded,
            linesDeleted,
            changePercentage,
            isArchitecturalChange,
            changes,
        };
    }

    private detectArchitecturalChange(changes: FileChange[], changePercentage: number): boolean {
        const hasPackageJson = changes.some((c) => c.path === "package.json" && (c.type === "M" || c.type === "A"));
        const hasNewDirs = changes.some((c) => c.path.split("/").length > 2 && c.type === "A");
        const hasCorePaths = changes.some((c) =>
            /^(src\/)?(config|routes|app|pages|api|index\.(ts|js|tsx|jsx))/.test(c.path) ||
            c.path.includes("config") ||
            c.path.includes("routes") ||
            c.path.endsWith("index.ts") ||
            c.path.endsWith("index.js")
        );
        const largeChange = changePercentage > 20;
        const score = [hasPackageJson, hasNewDirs, hasCorePaths, largeChange].filter(Boolean).length;
        return score >= 2;
    }

    private emptyAnalysis(): ChangeAnalysis {
        return {
            totalFiles: 0,
            filesAdded: 0,
            filesModified: 0,
            filesDeleted: 0,
            linesAdded: 0,
            linesDeleted: 0,
            changePercentage: 0,
            isArchitecturalChange: false,
            changes: [],
        };
    }

    /**
     * Get detailed diff for a file (for AI context)
     */
    async getDetailedChanges(filePath: string): Promise<string> {
        try {
            const diff = await this.git.diff(["HEAD", "--", filePath]);
            return diff;
        } catch {
            return "";
        }
    }

    /**
     * Get recent commit history
     */
    async getRecentCommits(count: number = 10): Promise<Array<{ hash: string; message: string }>> {
        try {
            const log = await this.git.log({ maxCount: count });
            return (log.all ?? []).map((c) => ({ hash: c.hash, message: c.message }));
        } catch {
            return [];
        }
    }
}
