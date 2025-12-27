/**
 * Workspace Cleanup Handlers
 * Handles deletion of workspace-related data when workspace is removed or app is uninstalled
 */

import * as fs from "fs/promises";
import * as path from "path";
import { db } from "./index";
import { workspaceModifications } from "./schema";
import { eq } from "drizzle-orm";
import log from "electron-log";
import { app } from "electron";
import os from "os";

const logger = log.scope("workspace-cleanup");

/**
 * Delete .atlarix folder from workspace when workspace is removed
 * @param workspacePath - Absolute path to workspace
 */
export async function cleanupWorkspaceFolder(workspacePath: string): Promise<void> {
    const atlarixFolder = path.join(workspacePath, ".atlarix");

    try {
        // Check if folder exists
        await fs.access(atlarixFolder);

        // Delete recursively
        await fs.rm(atlarixFolder, { recursive: true, force: true });

        logger.info(`Deleted .atlarix folder from workspace: ${workspacePath}`);
    } catch (error) {
        // Folder doesn't exist or already deleted
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            logger.error(`Failed to delete .atlarix folder: ${error}`);
        }
    }
}

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
 * Complete workspace removal - folder + database
 * Called when user removes workspace from app
 * @param workspacePath - Absolute path to workspace
 */
export async function onWorkspaceRemoved(workspacePath: string): Promise<void> {
    logger.info(`Workspace removed: ${workspacePath}`);

    // Delete .atlarix folder from workspace
    await cleanupWorkspaceFolder(workspacePath);

    // Delete all modifications from database
    await cleanupWorkspaceDatabase(workspacePath);

    logger.info(`Cleanup complete for: ${workspacePath}`);
}

/**
 * Delete all Atlarix application data
 * Called when app is being uninstalled
 */
export async function onAppUninstall(): Promise<void> {
    logger.info("App uninstall detected - cleaning up all data");

    const homeDir = os.homedir();
    const atlarixDataDir = path.join(homeDir, ".Atlarix");

    try {
        // Check if directory exists
        await fs.access(atlarixDataDir);

        // Delete entire ~/.Atlarix directory
        await fs.rm(atlarixDataDir, { recursive: true, force: true });

        logger.info("Deleted all app data from ~/.Atlarix");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            logger.error(`Failed to delete app data: ${error}`);
        }
    }
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
        // Only explicit uninstall triggers data deletion
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
