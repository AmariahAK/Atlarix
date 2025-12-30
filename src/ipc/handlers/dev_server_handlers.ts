/**
 * Dev Server IPC Handlers
 * =======================
 * IPC handlers for starting/stopping dev servers for live preview
 */

import { ipcMain, app } from 'electron';
import log from 'electron-log';
import { devServerManager, detectFramework } from '@/lib/dev_server_manager';
import { db } from '@/db';
import { apps } from '@/db/schema';
import { eq } from 'drizzle-orm';

const logger = log.scope('dev-server-handlers');

// ============================================
// IPC HANDLERS
// ============================================

/**
 * Check if workspace is a frontend project
 */
ipcMain.handle(
    'dev-server:is-frontend',
    async (_, { workspaceId }: { workspaceId: number }) => {
        try {
            // Get workspace path
            const [workspace] = await db
                .select({ path: apps.path })
                .from(apps)
                .where(eq(apps.id, workspaceId));

            if (!workspace?.path) {
                return { isFrontend: false, error: 'Workspace not found' };
            }

            const config = await detectFramework(workspace.path);
            return {
                isFrontend: config !== null,
                framework: config?.framework || null,
            };
        } catch (error) {
            logger.error('Error checking if frontend:', error);
            return { isFrontend: false, error: String(error) };
        }
    }
);

/**
 * Start dev server for a workspace
 */
ipcMain.handle(
    'dev-server:start',
    async (_, { workspaceId }: { workspaceId: number }) => {
        try {
            // Get workspace path
            const [workspace] = await db
                .select({ path: apps.path })
                .from(apps)
                .where(eq(apps.id, workspaceId));

            if (!workspace?.path) {
                return { success: false, error: 'Workspace not found' };
            }

            logger.log(`Starting dev server for workspace ${workspaceId} at ${workspace.path}`);

            const result = await devServerManager.startServer(workspaceId, workspace.path);
            return result;
        } catch (error) {
            logger.error('Error starting dev server:', error);
            return { success: false, error: String(error) };
        }
    }
);

/**
 * Stop dev server for a workspace
 */
ipcMain.handle(
    'dev-server:stop',
    async (_, { workspaceId }: { workspaceId: number }) => {
        try {
            devServerManager.stopServer(workspaceId);
            return { success: true };
        } catch (error) {
            logger.error('Error stopping dev server:', error);
            return { success: false, error: String(error) };
        }
    }
);

/**
 * Get dev server status for a workspace
 */
ipcMain.handle(
    'dev-server:status',
    async (_, { workspaceId }: { workspaceId: number }) => {
        try {
            const url = devServerManager.getServerUrl(workspaceId);
            const isRunning = devServerManager.isServerRunning(workspaceId);
            return {
                success: true,
                isRunning,
                url,
            };
        } catch (error) {
            logger.error('Error getting dev server status:', error);
            return { success: false, isRunning: false, url: null };
        }
    }
);

/**
 * Get all running dev servers
 */
ipcMain.handle('dev-server:list-running', async () => {
    try {
        const servers = devServerManager.getRunningServers();
        return { success: true, servers };
    } catch (error) {
        logger.error('Error listing dev servers:', error);
        return { success: false, servers: [] };
    }
});

// ============================================
// CLEANUP ON APP QUIT
// ============================================

app.on('before-quit', () => {
    logger.log('App quitting, stopping all dev servers');
    devServerManager.stopAllServers();
});

app.on('window-all-closed', () => {
    logger.log('All windows closed, stopping all dev servers');
    devServerManager.stopAllServers();
});

logger.log('Dev server IPC handlers registered');
