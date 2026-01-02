/**
 * Workspace Fingerprint
 * =====================
 * Track workspace state to detect when diagrams become stale.
 * Uses file counts, types, and hash to detect significant changes.
 */

import * as path from 'path';
import * as crypto from 'crypto';
import log from 'electron-log';
import { getWorkspaceHash } from './workspace-cache';
import * as fs from 'fs/promises';

const logger = log.scope('workspace-fingerprint');

// Dirs to exclude from fingerprinting
const EXCLUDE_DIRS = [
    'node_modules', '.git', '.next', 'dist', 'build', '__pycache__',
    'venv', '.venv', 'target', '.cache', 'coverage', '.turbo',
];

// Code file extensions
const CODE_EXTENSIONS = [
    '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.json',
    '.css', '.scss', '.html', '.vue', '.svelte', '.md',
];

export interface WorkspaceFingerprint {
    fileCount: number;
    directoryCount: number;
    fileTypes: Record<string, number>;  // e.g., {'.ts': 45, '.tsx': 12}
    totalSize: number;
    lastModified: number;
    hash: string;  // Quick comparison hash
}

/**
 * Generate a fingerprint of the workspace state.
 * Used to detect when diagrams become stale.
 */
export async function generateFingerprint(
    workspacePath: string
): Promise<WorkspaceFingerprint> {
    logger.info(`Generating fingerprint for: ${path.basename(workspacePath)}`);

    const { files, directories, fileTypes, totalSize, lastModified } =
        await scanWorkspace(workspacePath);

    // Get hash from existing workspace-cache utility
    const hash = await getWorkspaceHash(workspacePath);

    const fingerprint: WorkspaceFingerprint = {
        fileCount: files.length,
        directoryCount: directories,
        fileTypes,
        totalSize,
        lastModified,
        hash,
    };

    logger.info(`Fingerprint: ${files.length} files, ${directories} dirs, hash: ${hash}`);

    return fingerprint;
}

/**
 * Scan workspace for files, directories, and metadata.
 */
async function scanWorkspace(workspacePath: string): Promise<{
    files: string[];
    directories: number;
    fileTypes: Record<string, number>;
    totalSize: number;
    lastModified: number;
}> {
    const files: string[] = [];
    let directories = 0;
    const fileTypes: Record<string, number> = {};
    let totalSize = 0;
    let lastModified = 0;

    async function scan(dir: string): Promise<void> {
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                if (EXCLUDE_DIRS.includes(entry.name)) continue;
                if (entry.name.startsWith('.')) continue; // Skip hidden files/dirs

                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    directories++;
                    await scan(fullPath);
                } else {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (CODE_EXTENSIONS.includes(ext) || ext === '' || ext === '.json') {
                        files.push(fullPath);
                        fileTypes[ext] = (fileTypes[ext] || 0) + 1;

                        try {
                            const stats = await fs.stat(fullPath);
                            totalSize += stats.size;
                            lastModified = Math.max(lastModified, stats.mtimeMs);
                        } catch {
                            // File may have been deleted
                        }
                    }
                }
            }
        } catch (error) {
            // Permission error or similar
        }
    }

    await scan(workspacePath);

    return { files, directories, fileTypes, totalSize, lastModified };
}

/**
 * Compare two fingerprints and return a change summary.
 */
export function compareFingerprints(
    stored: WorkspaceFingerprint | null,
    current: WorkspaceFingerprint
): {
    filesAdded: number;
    filesRemoved: number;
    percentChange: number;
    hasHashChanged: boolean;
} {
    if (!stored) {
        return {
            filesAdded: current.fileCount,
            filesRemoved: 0,
            percentChange: 100,
            hasHashChanged: true,
        };
    }

    const fileCountChange = current.fileCount - stored.fileCount;
    const filesAdded = Math.max(0, fileCountChange);
    const filesRemoved = Math.abs(Math.min(0, fileCountChange));

    const baseline = Math.max(stored.fileCount, 1);
    const percentChange = (Math.abs(fileCountChange) / baseline) * 100;

    return {
        filesAdded,
        filesRemoved,
        percentChange,
        hasHashChanged: current.hash !== stored.hash,
    };
}
