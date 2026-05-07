/**
 * Workspace Cache
 * ===============
 * Hash-based caching for workspace analysis with file change detection
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import log from 'electron-log';
import { app } from 'electron';
import { WorkspaceAnalysis } from './workspace-analyzer';
import { isExcludedDir } from '@/ipc/utils/file_utils';

const logger = log.scope('workspace-cache');

interface CachedAnalysis {
    hash: string;
    analysis: WorkspaceAnalysis;
    diagram: string;
    summary: string;
    systemPromptContext: string;
    timestamp: number;
}

// In-memory cache
const memoryCache = new Map<string, CachedAnalysis>();

// File extensions to include in hash calculation
const HASH_EXTENSIONS = [
    '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.json',
];

// Dirs to exclude from hash — uses isExcludedDir from file_utils for consistency
// isExcludedDir handles all variants including .venv-*, site-packages, tzdata, etc.

/**
 * Get cache file path for persistence
 */
function getCacheDir(): string {
    return path.join(app.getPath('userData'), 'workspace-cache');
}

function getCacheFilePath(workspacePath: string): string {
    const hash = crypto.createHash('md5').update(workspacePath).digest('hex');
    return path.join(getCacheDir(), `${hash}.json`);
}

/**
 * Calculate hash of workspace files to detect changes
 */
export async function getWorkspaceHash(workspacePath: string): Promise<string> {
    const files = await getRelevantFiles(workspacePath);

    // Hash file paths + modification times (faster than content)
    const hashInput: string[] = [];

    for (const file of files.slice(0, 100)) { // Limit for performance
        try {
            const stats = await fs.stat(file);
            hashInput.push(`${file}:${stats.mtimeMs}`);
        } catch {
            // File may have been deleted
        }
    }

    return crypto
        .createHash('sha256')
        .update(hashInput.join('\n'))
        .digest('hex')
        .substring(0, 16); // Short hash
}

/**
 * Get relevant files for hashing
 */
async function getRelevantFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    async function scan(currentDir: string) {
        try {
            const entries = await fs.readdir(currentDir, { withFileTypes: true });

            for (const entry of entries) {
                if (isExcludedDir(entry.name)) continue;

                const fullPath = path.join(currentDir, entry.name);

                if (entry.isDirectory()) {
                    await scan(fullPath);
                } else {
                    const ext = path.extname(entry.name);
                    if (HASH_EXTENSIONS.includes(ext)) {
                        files.push(fullPath);
                    }
                }
            }
        } catch (error) {
            // Ignore permission errors
        }
    }

    await scan(dir);
    return files.sort();
}

/**
 * Get cached analysis if valid (files unchanged)
 */
export async function getCachedAnalysis(
    workspacePath: string
): Promise<CachedAnalysis | null> {
    const currentHash = await getWorkspaceHash(workspacePath);

    // Check memory cache first
    const memoryCached = memoryCache.get(workspacePath);
    if (memoryCached && memoryCached.hash === currentHash) {
        return memoryCached;
    }

    // Check disk cache
    try {
        const cacheFile = getCacheFilePath(workspacePath);
        const content = await fs.readFile(cacheFile, 'utf-8');
        const diskCached: CachedAnalysis = JSON.parse(content);

        if (diskCached.hash === currentHash) {
            // Valid cache - load into memory
            memoryCache.set(workspacePath, diskCached);
            return diskCached;
        }
    } catch {
        // No disk cache or invalid
    }

    logger.info(`Cache MISS: ${path.basename(workspacePath)}`);
    return null;
}

/**
 * Store analysis in cache (memory + disk)
 */
export async function setCachedAnalysis(
    workspacePath: string,
    hash: string,
    analysis: WorkspaceAnalysis,
    diagram: string,
    summary: string,
    systemPromptContext: string
): Promise<void> {
    const cached: CachedAnalysis = {
        hash,
        analysis,
        diagram,
        summary,
        systemPromptContext,
        timestamp: Date.now(),
    };

    // Store in memory
    memoryCache.set(workspacePath, cached);

    // Persist to disk
    try {
        const cacheDir = getCacheDir();
        await fs.mkdir(cacheDir, { recursive: true });

        const cacheFile = getCacheFilePath(workspacePath);
        await fs.writeFile(cacheFile, JSON.stringify(cached, null, 2));

        logger.info(`Cached analysis for: ${path.basename(workspacePath)}`);
    } catch (error) {
        logger.warn('Failed to persist cache to disk:', error);
    }
}

/**
 * Invalidate cache for a workspace
 */
export async function invalidateCache(workspacePath: string): Promise<void> {
    memoryCache.delete(workspacePath);

    try {
        const cacheFile = getCacheFilePath(workspacePath);
        await fs.unlink(cacheFile);
    } catch {
        // File may not exist
    }

    logger.info(`Invalidated cache for: ${path.basename(workspacePath)}`);
}

/**
 * Clear all caches
 */
export async function clearAllCaches(): Promise<void> {
    memoryCache.clear();

    try {
        const cacheDir = getCacheDir();
        await fs.rm(cacheDir, { recursive: true, force: true });
    } catch {
        // Directory may not exist
    }

    logger.info('Cleared all workspace caches');
}

/**
 * Get cache stats
 */
export function getCacheStats(): { memoryCacheSize: number; entries: string[] } {
    return {
        memoryCacheSize: memoryCache.size,
        entries: Array.from(memoryCache.keys()).map(k => path.basename(k)),
    };
}
