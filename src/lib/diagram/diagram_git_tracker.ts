/**
 * DiagramGitTracker - Phase 8: Internal diagram git (simple-git)
 * ==============================================================
 * Atlarix keeps a per-workspace internal git repo used only for diagram decisions.
 * Snapshots are commits of workspace file hashes; we use simple-git to diff
 * "last diagram state" vs "current state" for accurate update vs regenerate.
 * Works for repo, monorepo, polyrepo, and non-repo projects.
 */

import simpleGit, { SimpleGit } from "simple-git";
import * as path from "path";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as crypto from "crypto";
import log from "electron-log";
import { getUserDataPath } from "@/paths/paths";
import type { ChangeAnalysis, FileChange, FileChangeType } from "./git_change_tracker";

const logger = log.scope("diagram-git-tracker");

/** Basenames to skip when mirroring (case-insensitive — macOS may use UserData vs userData). */
const IGNORE_NAMES_LOWER = new Set([
    "node_modules", ".git", "dist", "build", ".next", ".nuxt", "coverage",
    ".cache", "__pycache__", ".vite", ".env", ".env.local",
    // Avoid mirroring paths that confuse `git add` (global/parent .gitignore often ignores userData)
    "userdata",
    ".cursor",
]);

function isIgnoredEntryName(name: string): boolean {
    if (IGNORE_NAMES_LOWER.has(name.toLowerCase())) return true;
    if (name.startsWith(".") && name !== ".env") return true;
    return false;
}

function emptyAnalysis(): ChangeAnalysis {
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

export class DiagramGitTracker {
    private git: SimpleGit;
    private readonly internalRepoPath: string;
    private readonly workspaceId: number;

    constructor(workspaceId: number) {
        this.workspaceId = workspaceId;
        this.internalRepoPath = path.join(getUserDataPath(), "diagram-git", String(workspaceId));
        // Ensure directory exists before simple-git uses it (avoids GitConstructError)
        fsSync.mkdirSync(this.internalRepoPath, { recursive: true });
        this.git = simpleGit(this.internalRepoPath);
    }

    /**
     * Ensure internal repo exists and is initialized.
     */
    async init(): Promise<void> {
        await fs.mkdir(this.internalRepoPath, { recursive: true });
        try {
            const isRepo = await this.git.checkIsRepo();
            if (!isRepo) {
                await this.git.init();
                logger.info(`[DiagramGitTracker] Initialized internal repo for workspace ${this.workspaceId}`);
            }
        } catch (e) {
            await this.git.init();
            logger.info(`[DiagramGitTracker] Initialized internal repo for workspace ${this.workspaceId}`);
        }
    }

    /**
     * Walk workspace and write one file per project file: relativePath -> content = hash.
     * Clears previous snapshot (except .git) first.
     */
    private async writeSnapshot(workspacePath: string): Promise<number> {
        const clearDir = async (dir: string): Promise<void> => {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.name === ".git") continue;
                if (e.isDirectory()) {
                    await clearDir(full);
                    await fs.rmdir(full).catch(() => {});
                } else {
                    await fs.unlink(full).catch(() => {});
                }
            }
        };
        await clearDir(this.internalRepoPath);

        let count = 0;
        const walk = async (dir: string, relDir: string, depth: number): Promise<void> => {
            if (depth > 10) return;
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const e of entries) {
                if (isIgnoredEntryName(e.name)) continue;
                const fullPath = path.join(dir, e.name);
                const relPath = relDir ? path.join(relDir, e.name) : e.name;
                if (relPath.split(/[/\\]/).some((s) => s.toLowerCase() === "userdata")) continue;
                if (e.isDirectory()) {
                    const targetDir = path.join(this.internalRepoPath, relPath);
                    await fs.mkdir(targetDir, { recursive: true });
                    await walk(fullPath, relPath, depth + 1);
                } else {
                    try {
                        const content = await fs.readFile(fullPath);
                        const hash = crypto.createHash("md5").update(content).digest("hex");
                        const targetFile = path.join(this.internalRepoPath, relPath);
                        await fs.mkdir(path.dirname(targetFile), { recursive: true });
                        await fs.writeFile(targetFile, hash, "utf8");
                        count++;
                    } catch {
                        // skip unreadable files
                    }
                }
            }
        };
        await walk(workspacePath, "", 0);
        return count;
    }

    /** Filename for stored diagram content in the internal repo (storage-based history). */
    static readonly DIAGRAM_FILE = "diagram.mermaid";

    /**
     * Capture current workspace state (and optionally diagram content) as a commit in the internal repo.
     * Call after generating a diagram; store returned hash in diagram.metadata.diagramGitCommit.
     * When diagramContent is provided, writes it to diagram.mermaid so "previous diagrams" = git history.
     */
    async captureSnapshot(workspacePath: string, diagramContent?: string): Promise<string | undefined> {
        try {
            await this.init();
            await this.writeSnapshot(workspacePath);
            if (diagramContent != null && diagramContent.trim()) {
                const diagramPath = path.join(this.internalRepoPath, DiagramGitTracker.DIAGRAM_FILE);
                await fs.writeFile(diagramPath, diagramContent.trim(), "utf8");
            }
            await this.git.add(".");
            const status = await this.git.status();
            if (status.files.length === 0 && status.staged.length === 0) {
                const log = await this.git.log({ maxCount: 1 });
                return log.latest?.hash;
            }
            const msg = diagramContent != null ? `Diagram update ${new Date().toISOString()}` : `snapshot ${new Date().toISOString()}`;
            const commitHash = await this.git.commit(msg);
            return commitHash?.commit;
        } catch (e) {
            logger.warn("[DiagramGitTracker] captureSnapshot failed:", e);
            return undefined;
        }
    }

    /**
     * Get the last commit hash in the internal repo (e.g. last diagram state).
     */
    async getLastCommitHash(): Promise<string | undefined> {
        try {
            const log = await this.git.log({ maxCount: 1 });
            return log.latest?.hash;
        } catch {
            return undefined;
        }
    }

    /**
     * Get diagram version history from git (storage-based). Returns commits that touch diagram.mermaid
     * with date and optional content for "previous diagrams" and AI comparison.
     */
    async getDiagramHistory(maxCount: number = 50): Promise<Array<{ commit: string; date: string; message: string; content?: string }>> {
        try {
            await this.init();
            const isRepo = await this.git.checkIsRepo();
            if (!isRepo) return [];

            const log = await this.git.log({ maxCount });
            const entries: Array<{ commit: string; date: string; message: string; content?: string }> = [];
            for (const entry of log.all) {
                const date = entry.date ? new Date(entry.date).toISOString() : "";
                let content: string | undefined;
                try {
                    content = await this.git.show([`${entry.hash}:${DiagramGitTracker.DIAGRAM_FILE}`]);
                } catch {
                    // file not in this commit (e.g. older snapshot-only commits)
                }
                entries.push({
                    commit: entry.hash,
                    date,
                    message: entry.message || "",
                    content: content?.trim() || undefined,
                });
            }
            return entries;
        } catch (e) {
            logger.warn("[DiagramGitTracker] getDiagramHistory failed:", e);
            return [];
        }
    }

    /**
     * Analyze changes since the given commit (e.g. diagramGitCommit).
     * Writes current workspace snapshot into the repo (no commit), then diffs against sinceCommit.
     */
    async analyzeChanges(workspacePath: string, sinceCommit: string): Promise<ChangeAnalysis> {
        try {
            await this.init();
            const snapshotFileCount = await this.writeSnapshot(workspacePath);
            const totalProjectFiles = Math.max(snapshotFileCount, 1);

            const summary = await this.git.diffSummary([sinceCommit]);
            const files = (summary as { files?: Array<{ file: string; insertions: number; deletions: number; binary?: boolean }> }).files ?? [];
            const changes: FileChange[] = files.map((f) => {
                const type: FileChangeType =
                    f.insertions > 0 && f.deletions === 0 ? "A" :
                        f.deletions > 0 && f.insertions === 0 ? "D" : "M";
                return {
                    path: f.file,
                    type,
                    insertions: f.insertions ?? 0,
                    deletions: f.deletions ?? 0,
                    binary: f.binary ?? false,
                };
            });

            const totalFiles = changes.length;
            const filesAdded = changes.filter((c) => c.type === "A").length;
            const filesModified = changes.filter((c) => c.type === "M").length;
            const filesDeleted = changes.filter((c) => c.type === "D").length;
            const linesAdded = changes.reduce((s, c) => s + c.insertions, 0);
            const linesDeleted = changes.reduce((s, c) => s + c.deletions, 0);
            const changePercentage = (totalFiles / totalProjectFiles) * 100;
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
        } catch (e) {
            logger.warn("[DiagramGitTracker] analyzeChanges failed:", e);
            return emptyAnalysis();
        }
    }

    private detectArchitecturalChange(changes: FileChange[], changePercentage: number): boolean {
        const hasPackageJson = changes.some((c) => c.path === "package.json" && (c.type === "M" || c.type === "A"));
        const hasNewDirs = changes.some((c) => c.path.split("/").length > 2 && c.type === "A");
        const hasCorePaths = changes.some((c) =>
            /^(src[\\/])?(config|routes|app|pages|api|index\.(ts|js|tsx|jsx))/.test(c.path) ||
            c.path.includes("config") ||
            c.path.includes("routes") ||
            /index\.(ts|js)$/.test(c.path)
        );
        const largeChange = changePercentage > 20;
        const score = [hasPackageJson, hasNewDirs, hasCorePaths, largeChange].filter(Boolean).length;
        return score >= 2;
    }
}
