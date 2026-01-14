/**
 * SessionTracker - AI's Mini-Git
 * ===============================
 * Tracks file changes the AI makes during a session to:
 * - Know when diagram needs updating (threshold-based)
 * - Provide AI with session awareness via get_session_changes tool
 * - Replace fingerprint-based staleness detection with live tracking
 * 
 * Created: v0.9.16 (2026-01-09)
 * Enhanced: v1.0.0 (2026-01-14) - Added file-hash snapshotting
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import log from 'electron-log';
import git from 'isomorphic-git';

const logger = log.scope('session-tracker');

// ============================================
// TYPES
// ============================================

export type ChangeType = 'added' | 'modified' | 'deleted';

export interface FileChange {
    path: string;
    type: ChangeType;
    timestamp: Date;
}

export interface SessionState {
    changedFiles: string[];
    filesAdded: number;
    filesModified: number;
    filesDeleted: number;
    totalFileCount: number;
    changePercentage: number;
    diagramStatus: 'current' | 'minor_drift' | 'major_drift';
    recommendedAction: 'none' | 'update_minor' | 'regenerate';
    lastDiagramSync: Date | null;
    sessionStartedAt: Date;
    /** Whether the workspace is a git repository */
    isGitRepo: boolean;
    /** Whether baseline snapshot was captured successfully */
    hasBaseline: boolean;
}

// ============================================
// CONFIGURATION
// ============================================

/** Thresholds for diagram staleness */
export const SESSION_THRESHOLDS = {
    /** 5% - Minor changes, suggest update */
    MINOR: 0.05,
    /** 15% - Major changes, recommend regeneration */
    MAJOR: 0.15,
    /** 30% - Critical, diagram is significantly outdated */
    CRITICAL: 0.30,
};

// ============================================
// SESSION TRACKER CLASS
// ============================================

export class SessionTracker {
    /** Singleton instances per workspace */
    private static instances: Map<number, SessionTracker> = new Map();

    private workspaceId: number;
    private workspacePath: string;
    private initialized: boolean = false;

    /** Baseline state when session started */
    private baselineFileCount: number = 0;

    /** File hash snapshot for accurate change detection (path -> MD5 hash) */
    private baselineSnapshot: Map<string, string> = new Map();

    /** Whether the workspace is a git repository */
    private isGitRepo: boolean = false;

    /** Changes during this session */
    private changedFiles: Map<string, FileChange> = new Map();
    private filesAdded: Set<string> = new Set();
    private filesDeleted: Set<string> = new Set();

    /** Diagram sync tracking */
    private lastDiagramSync: Date | null = null;
    private sessionStartedAt: Date;

    // ========================================
    // SINGLETON
    // ========================================

    private constructor(workspaceId: number) {
        this.workspaceId = workspaceId;
        this.workspacePath = '';
        this.sessionStartedAt = new Date();
    }

    /**
     * Get or create tracker instance for a workspace
     */
    static getInstance(workspaceId: number): SessionTracker {
        if (!SessionTracker.instances.has(workspaceId)) {
            SessionTracker.instances.set(workspaceId, new SessionTracker(workspaceId));
        }
        return SessionTracker.instances.get(workspaceId)!;
    }

    /**
     * Check if a tracker exists for a workspace (without creating)
     */
    static hasInstance(workspaceId: number): boolean {
        return SessionTracker.instances.has(workspaceId);
    }

    /**
     * Clear all tracker instances (for testing)
     */
    static clearAll(): void {
        SessionTracker.instances.clear();
    }

    // ========================================
    // INITIALIZATION
    // ========================================

    /**
     * Initialize tracker with workspace baseline
     * Call this when workspace opens or chat starts
     */
    async initialize(workspacePath: string): Promise<void> {
        if (this.initialized && this.workspacePath === workspacePath) {
            logger.debug(`[SessionTracker] Already initialized for ${workspacePath}`);
            return;
        }

        this.workspacePath = workspacePath;
        this.sessionStartedAt = new Date();
        this.baselineSnapshot.clear();

        try {
            // Detect if this is a git repository
            try {
                await git.findRoot({ fs: fsSync, filepath: workspacePath });
                this.isGitRepo = true;
                logger.log(`[SessionTracker] Git repo detected`);
            } catch {
                this.isGitRepo = false;
                logger.log(`[SessionTracker] Not a git repo, using file-hash baseline`);
            }

            // Snapshot all project files with their hashes
            await this.snapshotProjectFiles(workspacePath);
            this.baselineFileCount = this.baselineSnapshot.size;
            this.initialized = true;

            logger.log(`[SessionTracker] Initialized for workspace ${this.workspaceId}`);
            logger.log(`  → Path: ${workspacePath}`);
            logger.log(`  → Baseline files: ${this.baselineFileCount}`);
            logger.log(`  → Is Git Repo: ${this.isGitRepo}`);
        } catch (error) {
            logger.error('[SessionTracker] Failed to initialize:', error);
            // Don't fail - just use default
            this.baselineFileCount = 100; // Reasonable default
            this.initialized = true;
        }
    }

    /**
     * Snapshot all project files with their MD5 hashes
     * Used for accurate change detection
     */
    private async snapshotProjectFiles(dirPath: string, depth = 0): Promise<void> {
        if (depth > 10) return; // Prevent deep recursion

        const IGNORE_PATTERNS = [
            'node_modules',
            '.git',
            'dist',
            'build',
            '.next',
            '.nuxt',
            'coverage',
            '.cache',
            '__pycache__',
            '.vite',
        ];

        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                if (IGNORE_PATTERNS.includes(entry.name)) continue;
                if (entry.name.startsWith('.') && entry.name !== '.env') continue;

                const fullPath = path.join(dirPath, entry.name);

                if (entry.isDirectory()) {
                    await this.snapshotProjectFiles(fullPath, depth + 1);
                } else if (entry.isFile()) {
                    try {
                        const hash = await this.computeFileHash(fullPath);
                        const relativePath = path.relative(this.workspacePath, fullPath);
                        this.baselineSnapshot.set(relativePath, hash);
                    } catch {
                        // Skip files that can't be read
                    }
                }
            }
        } catch {
            // Directory not accessible
        }
    }

    /**
     * Compute MD5 hash of a file for quick change detection
     */
    private async computeFileHash(filePath: string): Promise<string> {
        const content = await fs.readFile(filePath);
        return crypto.createHash('md5').update(content).digest('hex');
    }

    /**
     * Count project files (excluding common ignore patterns)
     */
    private async countProjectFiles(dirPath: string, depth = 0): Promise<number> {
        if (depth > 10) return 0; // Prevent deep recursion

        const IGNORE_PATTERNS = [
            'node_modules',
            '.git',
            'dist',
            'build',
            '.next',
            '.nuxt',
            'coverage',
            '.cache',
            '__pycache__',
        ];

        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            let count = 0;

            for (const entry of entries) {
                if (IGNORE_PATTERNS.includes(entry.name)) continue;
                if (entry.name.startsWith('.') && entry.name !== '.env') continue;

                if (entry.isDirectory()) {
                    count += await this.countProjectFiles(path.join(dirPath, entry.name), depth + 1);
                } else if (entry.isFile()) {
                    count++;
                }
            }

            return count;
        } catch {
            return 0;
        }
    }

    // ========================================
    // CHANGE TRACKING
    // ========================================

    /**
     * Record a file change made by AI
     * Call this after every file operation in interceptor
     */
    recordChange(filePath: string, type: ChangeType): void {
        // Normalize path (relative to workspace)
        const normalizedPath = filePath.startsWith(this.workspacePath)
            ? filePath.slice(this.workspacePath.length + 1)
            : filePath;

        const change: FileChange = {
            path: normalizedPath,
            type,
            timestamp: new Date(),
        };

        // Track the change
        this.changedFiles.set(normalizedPath, change);

        // Track specific change types
        if (type === 'added') {
            this.filesAdded.add(normalizedPath);
            this.filesDeleted.delete(normalizedPath); // In case it was deleted then recreated
        } else if (type === 'deleted') {
            this.filesDeleted.add(normalizedPath);
            this.filesAdded.delete(normalizedPath); // In case it was created then deleted
        }

        logger.debug(`[SessionTracker] Recorded: ${type} ${normalizedPath}`);
        logger.debug(`  → Total changes: ${this.changedFiles.size}`);
        logger.debug(`  → Change %: ${(this.getChangePercentage() * 100).toFixed(1)}%`);
    }

    /**
     * Get percentage of project files changed
     */
    getChangePercentage(): number {
        if (this.baselineFileCount === 0) return 0;
        return this.changedFiles.size / this.baselineFileCount;
    }

    /**
     * Get diagram status based on change percentage
     */
    getDiagramStatus(): 'current' | 'minor_drift' | 'major_drift' {
        const changePercent = this.getChangePercentage();

        if (changePercent >= SESSION_THRESHOLDS.MAJOR) {
            return 'major_drift';
        } else if (changePercent >= SESSION_THRESHOLDS.MINOR) {
            return 'minor_drift';
        } else {
            return 'current';
        }
    }

    /**
     * Get recommended action for AI
     */
    getRecommendedAction(): 'none' | 'update_minor' | 'regenerate' {
        const status = this.getDiagramStatus();

        switch (status) {
            case 'major_drift':
                return 'regenerate';
            case 'minor_drift':
                return 'update_minor';
            default:
                return 'none';
        }
    }

    // ========================================
    // STATE ACCESS
    // ========================================

    /**
     * Get full session state (for AI tool)
     */
    getSessionState(): SessionState {
        return {
            changedFiles: Array.from(this.changedFiles.keys()),
            filesAdded: this.filesAdded.size,
            filesModified: this.changedFiles.size - this.filesAdded.size - this.filesDeleted.size,
            filesDeleted: this.filesDeleted.size,
            totalFileCount: this.baselineFileCount,
            changePercentage: this.getChangePercentage(),
            diagramStatus: this.getDiagramStatus(),
            recommendedAction: this.getRecommendedAction(),
            lastDiagramSync: this.lastDiagramSync,
            sessionStartedAt: this.sessionStartedAt,
            isGitRepo: this.isGitRepo,
            hasBaseline: this.baselineSnapshot.size > 0,
        };
    }

    /**
     * Mark diagram as synced (call after diagram regeneration)
     */
    markDiagramSynced(): void {
        this.lastDiagramSync = new Date();
        // Clear changes that were synced
        this.changedFiles.clear();
        this.filesAdded.clear();
        this.filesDeleted.clear();
        logger.log('[SessionTracker] Diagram marked as synced, changes reset');
    }

    /**
     * Reset tracker (for new session)
     */
    reset(): void {
        this.changedFiles.clear();
        this.filesAdded.clear();
        this.filesDeleted.clear();
        this.lastDiagramSync = null;
        this.sessionStartedAt = new Date();
        logger.log('[SessionTracker] Reset for new session');
    }

    // ========================================
    // GETTERS
    // ========================================

    get isInitialized(): boolean {
        return this.initialized;
    }

    get path(): string {
        return this.workspacePath;
    }

    get changeCount(): number {
        return this.changedFiles.size;
    }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get or create session tracker for current workspace
 * Convenience function for tools
 */
export function getSessionTracker(workspaceId: number, workspacePath?: string): SessionTracker {
    const tracker = SessionTracker.getInstance(workspaceId);
    if (workspacePath && !tracker.isInitialized) {
        // Fire and forget initialization
        tracker.initialize(workspacePath).catch(err => {
            logger.error('[getSessionTracker] Failed to initialize:', err);
        });
    }
    return tracker;
}

export default SessionTracker;
