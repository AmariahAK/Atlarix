/**
 * Workspace Cleanup Handlers
 * Handles deletion of workspace-related data when workspace is removed
 * 
 * NOTE: All workspace data is now stored in the SQLite database.
 * We no longer use .atlarix folders inside workspaces.
 */

import { db } from "./index";
import { workspaceModifications } from "./schema";
import { eq } from "drizzle-orm";
import log from "electron-log";
import { app } from "electron";

const logger = log.scope("workspace-cleanup");

/**
 * Delete all workspace modifications from database when workspace is removed
 * @param workspacePath - Absolute path to workspace
 */
export async function cleanupWorkspaceDatabase(workspacePath: string): Promise<void> {
    try {
        const result = await db
            .delete(workspaceModifications)
            .where(eq(workspaceModifications.workspacePath, workspacePath))
            .run();

        logger.info(`Deleted ${result.changes} modifications for workspace: ${workspacePath}`);
    } catch (error) {
        logger.error(`Failed to delete workspace modifications: ${error}`);
    }
}

/**
 * Complete workspace removal - database cleanup only
 * Called when user removes workspace from app
 * 
 * NOTE: We only clean up the database. The actual workspace files
 * are NOT deleted since we now register workspaces by their original
 * location (no copying).
 * 
 * @param workspacePath - Absolute path to workspace
 */
export async function onWorkspaceRemoved(workspacePath: string): Promise<void> {
    logger.info(`Workspace removed: ${workspacePath}`);

    // Delete all modifications from database
    await cleanupWorkspaceDatabase(workspacePath);

    logger.info(`Database cleanup complete for: ${workspacePath}`);
}

/**
 * Register cleanup handlers for app lifecycle
 * Called during app initialization
 */
export function registerCleanupHandlers(): void {
    // Handle app quit
    app.on("will-quit", async () => {
        logger.info("App is quitting...");
        // Note: Normal quit doesn't delete data
        // Only explicit workspace removal triggers data deletion
    });

    // Handle app before-quit (for macOS)
    app.on("before-quit", async () => {
        logger.info("App preparing to quit");

        // Flush any pending diagram captures
        try {
            const { flushPendingCaptures } = await import("../lib/diagram-timeline/capture");
            await flushPendingCaptures();
            logger.info("Flushed pending diagram captures");
        } catch (error) {
            logger.error(`Failed to flush pending captures: ${error}`);
        }
    });
}
