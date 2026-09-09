/**
 * Dev Server IPC Handlers
 * =======================
 * IPC handlers for starting/stopping dev servers for live preview
 */

import { ipcMain, app, BrowserWindow } from "electron";
import log from "electron-log";
import { devServerManager, detectFramework } from "@/lib/dev_server_manager";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { eq } from "drizzle-orm";
import { abortAllStreams } from "./chat_stream_handlers";

const logger = log.scope("dev-server-handlers");

// Register after app is ready so cleanup hooks align with the main lifecycle (avoids edge cases on early quit).
function registerDevServerLifecycleCleanup(): void {
  app.on("before-quit", () => {
    logger.log("App quitting, stopping all dev servers and AI streams");
    devServerManager.stopAllServers();
    abortAllStreams();
  });
  app.on("window-all-closed", () => {
    logger.log("All windows closed, stopping all dev servers");
    devServerManager.stopAllServers();
  });
}

if (app.isReady()) {
  registerDevServerLifecycleCleanup();
} else {
  app.whenReady().then(() => {
    registerDevServerLifecycleCleanup();
  });
}

// ============================================
// IPC HANDLERS
// ============================================

/**
 * Check if workspace is a frontend project
 */
ipcMain.handle(
  "dev-server:is-frontend",
  async (_, { workspaceId }: { workspaceId: number }) => {
    try {
      // Get workspace path
      const [workspace] = await db
        .select({ path: apps.path })
        .from(apps)
        .where(eq(apps.id, workspaceId));

      if (!workspace?.path) {
        return { isFrontend: false, error: "Workspace not found" };
      }

      const config = await detectFramework(workspace.path);
      return {
        isFrontend: config !== null,
        framework: config?.framework || null,
      };
    } catch (error) {
      logger.error("Error checking if frontend:", error);
      return { isFrontend: false, error: String(error) };
    }
  },
);

/**
 * Start dev server for a workspace
 */
ipcMain.handle(
  "dev-server:start",
  async (
    _,
    {
      workspaceId,
      enableTypeCheck = true,
    }: { workspaceId: number; enableTypeCheck?: boolean },
  ) => {
    try {
      // Get workspace path
      const [workspace] = await db
        .select({ path: apps.path })
        .from(apps)
        .where(eq(apps.id, workspaceId));

      if (!workspace?.path) {
        return { success: false, error: "Workspace not found" };
      }

      logger.log(
        `Starting dev server for workspace ${workspaceId} at ${workspace.path}`,
      );

      // (A CDP console debugger used to attach to the APP window here. It
      // predated v14.15.0, when the user's app moved out of an in-window
      // iframe and into a Browser tab — a separate WebContentsView, and so a
      // separate CDP target it could never see. What it did still capture was
      // Atlarix's OWN renderer console, and its filter only recognised the
      // dev-server port, so in a packaged build those surfaced to users as
      // errors in their app. Removed; the browser tabs report their own
      // console natively via `browser:console`.)

      const result = await devServerManager.startServer(
        workspaceId,
        workspace.path,
        (url) => {
          // This callback might be called later when port is detected
          const win = BrowserWindow.getAllWindows()[0];
          if (win) {
            win.webContents.send("dev-server:url", { workspaceId, url });
          }
        },
        enableTypeCheck, // Pass the type check flag
      );
      return result;
    } catch (error) {
      logger.error("Error starting dev server:", error);
      return { success: false, error: String(error) };
    }
  },
);

/**
 * Stop dev server for a workspace
 */
ipcMain.handle(
  "dev-server:stop",
  async (_, { workspaceId }: { workspaceId: number }) => {
    try {
      devServerManager.stopServer(workspaceId);
      return { success: true };
    } catch (error) {
      logger.error("Error stopping dev server:", error);
      return { success: false, error: String(error) };
    }
  },
);

/**
 * Get dev server status for a workspace
 */
ipcMain.handle(
  "dev-server:status",
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
      logger.error("Error getting dev server status:", error);
      return { success: false, isRunning: false, url: null };
    }
  },
);

/**
 * Get all running dev servers
 */
ipcMain.handle("dev-server:list-running", async () => {
  try {
    const servers = devServerManager.getRunningServers();
    return { success: true, servers };
  } catch (error) {
    logger.error("Error listing dev servers:", error);
    return { success: false, servers: [] };
  }
});

logger.log("Dev server IPC handlers registered");
