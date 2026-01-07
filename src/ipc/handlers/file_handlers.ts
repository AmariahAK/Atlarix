/**
 * File Handlers
 * =============
 * IPC handlers for direct file read/write operations.
 * Used by the ErrorFileEditor for live code editing.
 */

import { ipcMain } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
// Simple logger for file operations
const logger = {
    log: (...args: any[]) => console.log('[FileHandlers]', ...args),
    error: (...args: any[]) => console.error('[FileHandlers]', ...args),
};

/**
 * Register file-related IPC handlers
 */
export function registerFileHandlers() {
    // Read file content
    ipcMain.handle('file:read-content', async (_, params: { filePath: string }) => {
        try {
            const content = await fs.readFile(params.filePath, 'utf-8');
            logger.log(`[file:read-content] Read ${params.filePath} (${content.length} bytes)`);
            return { success: true, content };
        } catch (error) {
            logger.error('[file:read-content] Failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    });

    // Write file content
    ipcMain.handle('file:write-content', async (_, params: { filePath: string; content: string }) => {
        try {
            // Ensure directory exists
            const dir = path.dirname(params.filePath);
            await fs.mkdir(dir, { recursive: true });

            await fs.writeFile(params.filePath, params.content, 'utf-8');
            logger.log(`[file:write-content] Wrote ${params.filePath} (${params.content.length} bytes)`);
            return { success: true };
        } catch (error) {
            logger.error('[file:write-content] Failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    });

    // Get file stats (for checking if file exists, last modified, etc.)
    ipcMain.handle('file:get-stats', async (_, params: { filePath: string }) => {
        try {
            const stats = await fs.stat(params.filePath);
            return {
                success: true,
                exists: true,
                size: stats.size,
                modifiedTime: stats.mtime.getTime(),
                isDirectory: stats.isDirectory(),
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return { success: true, exists: false };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    });

    logger.log('[File Handlers] Registered file:read-content, file:write-content, file:get-stats');
}
