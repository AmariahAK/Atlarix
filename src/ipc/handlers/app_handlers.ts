import { ipcMain, app } from "electron";
import { noteWorkspaceCreated } from "@/ipc/utils/workspace-quota";
import { perfMark } from "@/lib/perf-marks";
import { db, getDatabasePath, reinitializeDatabaseAfterReset } from "../../db";
import {
  apps,
  chatSessions,
  sessionMessages,
  dailyLogs,
} from "../../db/schema";

import { desc, eq, like } from "drizzle-orm";
import type {
  App,
  RenameBranchParams,
  CopyAppParams,
  RespondToAppInputParams,
} from "../ipc_types";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  getAtlarixAppPath,
  getUserDataPath,
  isAtlarixManagedWorkspacePath,
} from "../../paths/paths";
import { ChildProcess, spawn } from "node:child_process";
import { promises as fsPromises } from "node:fs";

// Import our utility modules
import { withLock } from "../utils/lock_utils";
import {
  workspacePathExists,
  invalidateWorkspacePathStatus,
} from "../utils/workspace_path_status_broadcast";
import { bootstrapAtlarixWorkspaceFolder } from "@/lib/atlarix/workspace-bootstrap";
import {
  runningApps,
  processCounter,
  removeAppIfCurrentProcess,
  stopAppByInfo,
} from "../utils/process_manager";
import { getEnvVar } from "../utils/read_env";

import killPort from "kill-port";
import util from "util";
import log from "electron-log";
import { createLoggedHandler } from "./safe_handle";
import { getLanguageModelProviders } from "../shared/language_model_helpers";
import { startProxy } from "../utils/start_proxy_server";
import { Worker } from "worker_threads";
import {
  gitCommit,
  gitListBranches,
  gitRenameBranch,
} from "../utils/git_utils";
import { safeSend } from "../utils/safe_sender";
import { AppSearchResult } from "@/lib/schemas";
import { onWorkspaceRemoved } from "../../db/workspace_cleanup";
import { capture as analyticsCapture } from "../../main/lib/analytics";
import { SENTRY_DSN } from "../../main/sentry-config";

import { getAppPort } from "../../../shared/ports";

function getDefaultCommand(appId: number): string {
  const port = getAppPort(appId);
  return `(pnpm install && pnpm run dev --port ${port}) || (npm install --legacy-peer-deps && npm run dev -- --port ${port})`;
}
async function copyDir(
  source: string,
  destination: string,
  filter?: (source: string) => boolean,
) {
  await fsPromises.cp(source, destination, {
    recursive: true,
    filter: (src: string) => {
      if (path.basename(src) === "node_modules") {
        return false;
      }
      if (filter) {
        return filter(src);
      }
      return true;
    },
  });
}

const logger = log.scope("app_handlers");
const handle = createLoggedHandler(logger);

let proxyWorker: Worker | null = null;

async function executeApp({
  appPath,
  appId,
  event, // Keep event for local-node case
  installCommand,
  startCommand,
}: {
  appPath: string;
  appId: number;
  event: Electron.IpcMainInvokeEvent;
  installCommand?: string | null;
  startCommand?: string | null;
}): Promise<void> {
  if (proxyWorker) {
    proxyWorker.terminate();
    proxyWorker = null;
  }
  await executeAppLocalNode({
    appPath,
    appId,
    event,
    installCommand,
    startCommand,
  });
}

async function executeAppLocalNode({
  appPath,
  appId,
  event,
  installCommand,
  startCommand,
}: {
  appPath: string;
  appId: number;
  event: Electron.IpcMainInvokeEvent;
  installCommand?: string | null;
  startCommand?: string | null;
}): Promise<void> {
  const command = getCommand({ appId, installCommand, startCommand });
  const spawnedProcess = spawn(command, [], {
    cwd: appPath,
    shell: true,
    stdio: "pipe", // Ensure stdio is piped so we can capture output/errors and detect close
    detached: false, // Ensure child process is attached to the main process lifecycle unless explicitly backgrounded
  });

  // Check if process spawned correctly
  if (!spawnedProcess.pid) {
    // Attempt to capture any immediate errors if possible
    let errorOutput = "";
    let spawnErr: any | null = null;
    spawnedProcess.stderr?.on(
      "data",
      (data) => (errorOutput += data.toString()),
    );
    await new Promise<void>((resolve) => {
      spawnedProcess.once("error", (err) => {
        spawnErr = err;
        resolve();
      });
    }); // Wait for error event

    const details = [
      spawnErr?.message ? `message=${spawnErr.message}` : null,
      spawnErr?.code ? `code=${spawnErr.code}` : null,
      spawnErr?.errno ? `errno=${spawnErr.errno}` : null,
      spawnErr?.syscall ? `syscall=${spawnErr.syscall}` : null,
      spawnErr?.path ? `path=${spawnErr.path}` : null,
      spawnErr?.spawnargs
        ? `spawnargs=${JSON.stringify(spawnErr.spawnargs)}`
        : null,
    ]
      .filter(Boolean)
      .join(", ");

    logger.error(
      `Failed to spawn process for app ${appId}. Command="${command}", CWD="${appPath}", ${details}\nSTDERR:\n${
        errorOutput || "(empty)"
      }`,
    );

    throw new Error(
      `Failed to spawn process for app ${appId}.
Error output:
${errorOutput || "(empty)"}
Details: ${details || "n/a"}
`,
    );
  }

  // Increment the counter and store the process reference with its ID
  const currentProcessId = processCounter.increment();
  runningApps.set(appId, {
    process: spawnedProcess,
    processId: currentProcessId,
  });

  listenToProcess({
    process: spawnedProcess,
    appId,
    event,
  });
}

function listenToProcess({
  process: spawnedProcess,
  appId,
  event,
}: {
  process: ChildProcess;
  appId: number;
  event: Electron.IpcMainInvokeEvent;
}) {
  // Log output
  spawnedProcess.stdout?.on("data", async (data) => {
    const message = util.stripVTControlCharacters(data.toString());
    logger.debug(
      `App ${appId} (PID: ${spawnedProcess.pid}) stdout: ${message}`,
    );

    // Check if this is an interactive prompt requiring user input
    const inputRequestPattern = /\s*›\s*\([yY]\/[nN]\)\s*$/;
    const isInputRequest = inputRequestPattern.test(message);
    if (isInputRequest) {
      // Send special input-requested event for interactive prompts
      safeSend(event.sender, "app:output", {
        type: "input-requested",
        message,
        appId,
      });
    } else {
      // Normal stdout handling
      safeSend(event.sender, "app:output", {
        type: "stdout",
        message,
        appId,
      });

      const urlMatch = message.match(/(https?:\/\/localhost:\d+\/?)/);
      if (urlMatch) {
        proxyWorker = await startProxy(urlMatch[1], {
          onStarted: (proxyUrl) => {
            safeSend(event.sender, "app:output", {
              type: "stdout",
              message: `[atlarix-preview-proxy]started=[${proxyUrl}] original=[${urlMatch[1]}]`,
              appId,
            });
          },
        });
      }
    }
  });

  spawnedProcess.stderr?.on("data", (data) => {
    const message = util.stripVTControlCharacters(data.toString());
    logger.error(
      `App ${appId} (PID: ${spawnedProcess.pid}) stderr: ${message}`,
    );
    safeSend(event.sender, "app:output", {
      type: "stderr",
      message,
      appId,
    });
  });

  // Handle process exit/close
  spawnedProcess.on("close", (code, signal) => {
    logger.log(
      `App ${appId} (PID: ${spawnedProcess.pid}) process closed with code ${code}, signal ${signal}.`,
    );
    removeAppIfCurrentProcess(appId, spawnedProcess);
  });

  // Handle errors during process lifecycle (e.g., command not found)
  spawnedProcess.on("error", (err) => {
    logger.error(
      `Error in app ${appId} (PID: ${spawnedProcess.pid}) process: ${err.message}`,
    );
    removeAppIfCurrentProcess(appId, spawnedProcess);
    // Note: We don't throw here as the error is asynchronous. The caller got a success response already.
    // Consider adding ipcRenderer event emission to notify UI of the error.
  });
}

// Helper to kill process on a specific port (cross-platform, using kill-port)
async function killProcessOnPort(port: number): Promise<void> {
  try {
    await killPort(port, "tcp");
  } catch {
    // Ignore if nothing was running on that port
  }
}

export function registerAppHandlers() {
  handle("apps:touch-last-opened", async (_, appId: number) => {
    const now = new Date();
    await db
      .update(apps)
      .set({ lastOpenedAt: now, updatedAt: now })
      .where(eq(apps.id, appId));
    return { ok: true };
  });

  handle("restart-atlarix", async () => {
    app.relaunch();
    app.quit();
  });

  handle(
    "copy-app",
    async (_, params: CopyAppParams): Promise<{ app: any }> => {
      const { appId, newAppName, withHistory } = params;

      // 1. Check if an app with the new name already exists
      const existingApp = await db.query.apps.findFirst({
        where: eq(apps.name, newAppName),
      });

      if (existingApp) {
        throw new Error(`An app named "${newAppName}" already exists.`);
      }

      // 2. Find the original app
      const originalApp = await db.query.apps.findFirst({
        where: eq(apps.id, appId),
      });

      if (!originalApp) {
        throw new Error("Original app not found.");
      }

      const originalAppPath = getAtlarixAppPath(originalApp.path);
      // Use absolute path (same default as create-app), not legacy atlarix-apps
      const defaultCopyBase = path.join(os.homedir(), "Documents", "Atlarix");
      const newAppPath = path.join(defaultCopyBase, newAppName);

      if (fs.existsSync(newAppPath)) {
        throw new Error(`Directory already exists at: ${newAppPath}`);
      }

      // 3. Copy the app folder
      try {
        await copyDir(originalAppPath, newAppPath, (source: string) => {
          if (!withHistory && path.basename(source) === ".git") {
            return false;
          }
          return true;
        });
      } catch (error) {
        logger.error("Failed to copy app directory:", error);
        throw new Error("Failed to copy app directory.");
      }

      if (!withHistory) {
        await gitCommit({
          path: newAppPath,
          message: "Init Atlarix app",
        });
      }

      // 4. Create a new app entry in the database (store absolute path)
      //
      // A copy is a new workspace and counts against the plan, same as opening a
      // folder. This path had NO cap check at all — only the import path did, so
      // duplicating was a way past a limit the product otherwise enforces.
      const [newDbApp] = await db
        .insert(apps)
        .values({
          name: newAppName,
          path: newAppPath,
          // Explicitly set these to null because we don't want to copy them over.
          // Note: we could just leave them out since they're nullable field, but this
          // is to make it explicit we intentionally don't want to copy them over.
          githubOrg: null,
          githubRepo: null,
          installCommand: originalApp.installCommand,
          startCommand: originalApp.startCommand,
        })
        .returning();

      noteWorkspaceCreated();

      return { app: newDbApp };
    },
  );

  handle("get-app", async (_, appId: number): Promise<App> => {
    const app = await db.query.apps.findFirst({
      where: eq(apps.id, appId),
    });

    if (!app) {
      throw new Error("App not found");
    }

    const appPath = getAtlarixAppPath(app.path);
    const pathExists = fs.existsSync(appPath);
    if (pathExists) {
      void bootstrapAtlarixWorkspaceFolder(appPath);
    }

    // `appId` is a local DB row id — never the path or folder name. The extra
    // properties describe the workspace's SHAPE, which is what makes "is this
    // person actually working in here" answerable; `{ appId }` alone couldn't
    // distinguish a real project from an empty folder opened once.
    analyticsCapture("workspace_opened", {
      appId,
      exists: pathExists,
      is_git_repo: pathExists && fs.existsSync(path.join(appPath, ".git")),
    });
    perfMark(`workspace-open:${appId}`);
    const status = pathExists ? ("active" as const) : ("missing" as const);
    return {
      ...app,
      remoteConnection: (app.remoteConnection ?? null) as Record<
        string,
        unknown
      > | null,
      pathExists,
      status,
    };
  });

  ipcMain.handle("list-apps", async () => {
    const allApps = await db.query.apps.findMany({
      orderBy: [desc(apps.createdAt)],
    });
    // Read existence through the shared session cache so the app list and the
    // focus refresh don't each re-stat every workspace (which re-prompted for
    // folder access on macOS). See workspace_path_status_broadcast.ts.
    const appsWithPathExists = allApps.map((a) => {
      const pathExists = workspacePathExists(a.id, a.path);
      return {
        ...a,
        pathExists,
        status: pathExists ? ("active" as const) : ("missing" as const),
      };
    });
    return {
      apps: appsWithPathExists,
      appBasePath: getAtlarixAppPath("$APP_BASE_PATH"),
    };
  });

  // Do NOT use handle for this, it contains sensitive information.
  ipcMain.handle("get-env-vars", async () => {
    const envVars: Record<string, string | undefined> = {};
    const providers = await getLanguageModelProviders();
    for (const provider of providers) {
      if (provider.envVarName) {
        envVars[provider.envVarName] = getEnvVar(provider.envVarName);
      }
    }
    return envVars;
  });

  ipcMain.handle(
    "run-app",
    async (
      event: Electron.IpcMainInvokeEvent,
      { appId }: { appId: number },
    ): Promise<void> => {
      // Running a workspace is the moment the user expects us to touch its
      // folder, so re-verify it here instead of on window focus (which is what
      // made the macOS folder-access prompt recur). This keeps the app-list chip
      // honest in the direction the existence cache can't self-correct: a folder
      // that was present at first stat and has since been deleted or moved.
      invalidateWorkspacePathStatus(appId);
      return withLock(appId, async () => {
        // Check if app is already running
        if (runningApps.has(appId)) {
          logger.debug(`App ${appId} is already running.`);
          return;
        }

        const app = await db.query.apps.findFirst({
          where: eq(apps.id, appId),
        });

        if (!app) {
          throw new Error("App not found");
        }

        logger.debug(`Starting app ${appId} in path ${app.path}`);

        const appPath = getAtlarixAppPath(app.path);
        try {
          // There may have been a previous run that left a process on this port.
          await cleanUpPort(getAppPort(appId));
          await executeApp({
            appPath,
            appId,
            event,
            installCommand: app.installCommand,
            startCommand: app.startCommand,
          });

          return;
        } catch (error: any) {
          logger.error(`Error running app ${appId}:`, error);
          // Ensure cleanup if error happens during setup but before process events are handled
          if (
            runningApps.has(appId) &&
            runningApps.get(appId)?.processId === processCounter.value
          ) {
            runningApps.delete(appId);
          }
          throw new Error(`Failed to run app ${appId}: ${error.message}`);
        }
      });
    },
  );

  ipcMain.handle(
    "stop-app",
    async (_, { appId }: { appId: number }): Promise<void> => {
      logger.log(
        `Attempting to stop app ${appId}. Current running apps: ${runningApps.size}`,
      );
      return withLock(appId, async () => {
        const appInfo = runningApps.get(appId);

        if (!appInfo) {
          logger.log(
            `App ${appId} not found in running apps map. Assuming already stopped.`,
          );
          return;
        }

        const { process, processId } = appInfo;
        logger.log(
          `Found running app ${appId} with processId ${processId} (PID: ${process.pid}). Attempting to stop.`,
        );

        // Check if the process is already exited or closed
        if (process.exitCode !== null || process.signalCode !== null) {
          logger.log(
            `Process for app ${appId} (PID: ${process.pid}) already exited (code: ${process.exitCode}, signal: ${process.signalCode}). Cleaning up map.`,
          );
          runningApps.delete(appId); // Ensure cleanup if somehow missed
          return;
        }

        try {
          await stopAppByInfo(appId, appInfo);

          // Now, safely remove the app from the map *after* confirming closure
          removeAppIfCurrentProcess(appId, process);

          return;
        } catch (error: any) {
          logger.error(
            `Error stopping app ${appId} (PID: ${process.pid}, processId: ${processId}):`,
            error,
          );
          // Attempt cleanup even if an error occurred during the stop process
          removeAppIfCurrentProcess(appId, process);
          throw new Error(`Failed to stop app ${appId}: ${error.message}`);
        }
      });
    },
  );

  ipcMain.handle(
    "restart-app",
    async (
      event: Electron.IpcMainInvokeEvent,
      {
        appId,
        removeNodeModules,
      }: { appId: number; removeNodeModules?: boolean },
    ): Promise<void> => {
      logger.log(`Restarting app ${appId}`);
      return withLock(appId, async () => {
        try {
          // First stop the app if it's running
          const appInfo = runningApps.get(appId);
          if (appInfo) {
            const { processId } = appInfo;
            logger.log(
              `Stopping app ${appId} (processId ${processId}) before restart`,
            );
            await stopAppByInfo(appId, appInfo);
          } else {
            logger.log(`App ${appId} not running. Proceeding to start.`);
          }

          // There may have been a previous run that left a process on this port.
          await cleanUpPort(getAppPort(appId));

          // Now start the app again
          const app = await db.query.apps.findFirst({
            where: eq(apps.id, appId),
          });

          if (!app) {
            throw new Error("App not found");
          }

          const appPath = getAtlarixAppPath(app.path);

          // Remove node_modules if requested
          if (removeNodeModules) {
            const nodeModulesPath = path.join(appPath, "node_modules");
            logger.log(
              `Removing node_modules for app ${appId} at ${nodeModulesPath}`,
            );
            if (fs.existsSync(nodeModulesPath)) {
              await fsPromises.rm(nodeModulesPath, {
                recursive: true,
                force: true,
              });
              logger.log(`Successfully removed node_modules for app ${appId}`);
            } else {
              logger.log(`No node_modules directory found for app ${appId}`);
            }
          }

          logger.debug(
            `Executing app ${appId} in path ${app.path} after restart request`,
          ); // Adjusted log

          await executeApp({
            appPath,
            appId,
            event,
            installCommand: app.installCommand,
            startCommand: app.startCommand,
          }); // This will handle starting either mode

          return;
        } catch (error) {
          logger.error(`Error restarting app ${appId}:`, error);
          throw error;
        }
      });
    },
  );

  ipcMain.handle(
    "delete-app",
    async (_, { appId }: { appId: number }): Promise<void> => {
      // Static server worker is NOT terminated here anymore

      return withLock(appId, async () => {
        // Check if app exists
        const app = await db.query.apps.findFirst({
          where: eq(apps.id, appId),
        });

        if (!app) {
          throw new Error(
            `Workspace not found (ID: ${appId}). It may have already been deleted.`,
          );
        }

        // Stop the app if it's running
        if (runningApps.has(appId)) {
          const appInfo = runningApps.get(appId)!;
          try {
            logger.log(`Stopping app ${appId} before deletion.`);
            await stopAppByInfo(appId, appInfo);
          } catch (error: any) {
            logger.error(`Error stopping app ${appId} before deletion:`, error);
            // Continue with deletion even if stopping fails
          }
        }

        // Delete app from database (including related records)
        try {
          // Delete daily logs
          await db.delete(dailyLogs).where(eq(dailyLogs.workspaceId, appId));

          // Finally delete the app (chats cascade delete automatically)
          await db.delete(apps).where(eq(apps.id, appId));
          logger.info(
            `Deleted workspace "${app.name}" (ID: ${appId}) from database`,
          );
        } catch (error: any) {
          logger.error(`Error deleting app ${appId} from database:`, error);
          throw new Error(
            `Failed to delete workspace from database: ${error.message}`,
          );
        }

        // Remove clone folders under Atlarix-managed roots (atlarix-apps, ~/Documents/Atlarix).
        const workspacePath = path.isAbsolute(app.path)
          ? path.resolve(app.path)
          : getAtlarixAppPath(app.path);
        if (isAtlarixManagedWorkspacePath(workspacePath)) {
          try {
            if (fs.existsSync(workspacePath)) {
              await fsPromises.rm(workspacePath, {
                recursive: true,
                force: true,
              });
              logger.log(`Deleted managed workspace files at ${workspacePath}`);
            }
          } catch (error: any) {
            logger.warn(
              `Could not delete managed workspace path ${workspacePath}: ${error.message}`,
            );
          }
        }

        // Clean up any legacy copied files in atlarix-apps folder (if they exist)
        const legacyInternalPath = getAtlarixAppPath(app.name);
        try {
          if (
            legacyInternalPath !== workspacePath &&
            fs.existsSync(legacyInternalPath)
          ) {
            await fsPromises.rm(legacyInternalPath, {
              recursive: true,
              force: true,
            });
            logger.log(`Deleted legacy copied files at ${legacyInternalPath}`);
          }
        } catch (error: any) {
          logger.warn(
            `Could not delete legacy path ${legacyInternalPath}: ${error.message}`,
          );
        }

        // Clean up any remaining database records (workspaceModifications by path)
        try {
          await onWorkspaceRemoved(workspacePath);
          logger.info(`Database cleanup completed for: ${workspacePath}`);
        } catch (error: any) {
          logger.error(
            `Error during workspace cleanup for ${workspacePath}:`,
            error,
          );
          // Don't fail - main deletion already succeeded
        }

        // Clear workspace count cache so next check gets fresh count
        try {
          const { SubscriptionManager } = await import(
            "../../lib/SubscriptionManager"
          );
          SubscriptionManager.clearWorkspaceCache();
          logger.info(
            `Cleared workspace count cache after deleting workspace ${appId}`,
          );
        } catch (error) {
          logger.warn(`Could not clear workspace cache: ${error}`);
          // Don't fail - main deletion succeeded
        }
      });
    },
  );

  ipcMain.handle(
    "add-to-favorite",
    async (
      _,
      { appId }: { appId: number },
    ): Promise<{ isFavorite: boolean }> => {
      return withLock(appId, async () => {
        try {
          // Fetch the current isFavorite value
          const result = await db
            .select({ isFavorite: apps.isFavorite })
            .from(apps)
            .where(eq(apps.id, appId))
            .limit(1);

          if (result.length === 0) {
            throw new Error(`App with ID ${appId} not found.`);
          }

          const currentIsFavorite = result[0].isFavorite;

          // Toggle the isFavorite value
          const updated = await db
            .update(apps)
            .set({ isFavorite: !currentIsFavorite })
            .where(eq(apps.id, appId))
            .returning({ isFavorite: apps.isFavorite });

          if (updated.length === 0) {
            throw new Error(
              `Failed to update favorite status for app ID ${appId}.`,
            );
          }

          // Return the updated isFavorite value
          return { isFavorite: updated[0].isFavorite };
        } catch (error: any) {
          logger.error(
            `Error in add-to-favorite handler for app ID ${appId}:`,
            error,
          );
          throw new Error(`Failed to toggle favorite status: ${error.message}`);
        }
      });
    },
  );

  ipcMain.handle(
    "rename-app",
    async (
      _,
      {
        appId,
        appName,
        appPath,
      }: { appId: number; appName: string; appPath: string },
    ): Promise<void> => {
      return withLock(appId, async () => {
        // Check if app exists
        const app = await db.query.apps.findFirst({
          where: eq(apps.id, appId),
        });

        if (!app) {
          throw new Error("App not found");
        }

        const pathChanged = appPath !== app.path;

        if (pathChanged) {
          const invalidChars = /[<>:"|?*/\\]/;
          const hasInvalidChars =
            // eslint-disable-next-line no-control-regex -- detect ASCII control chars in path
            invalidChars.test(appPath) || /[\x00-\x1f]/.test(appPath);

          if (hasInvalidChars) {
            throw new Error(
              `App path "${appPath}" contains characters that are not allowed in folder names: < > : " | ? * / \\ or control characters. Please use a different path.`,
            );
          }
        }

        // Check for conflicts with existing apps
        const nameConflict = await db.query.apps.findFirst({
          where: eq(apps.name, appName),
        });

        const pathConflict = await db.query.apps.findFirst({
          where: eq(apps.path, appPath),
        });

        if (nameConflict && nameConflict.id !== appId) {
          throw new Error(`An app with the name '${appName}' already exists`);
        }

        if (pathConflict && pathConflict.id !== appId) {
          throw new Error(`An app with the path '${appPath}' already exists`);
        }

        // Stop the app if it's running
        if (runningApps.has(appId)) {
          const appInfo = runningApps.get(appId)!;
          try {
            await stopAppByInfo(appId, appInfo);
          } catch (error: any) {
            logger.error(`Error stopping app ${appId} before renaming:`, error);
            throw new Error(
              `Failed to stop app before renaming: ${error.message}`,
            );
          }
        }

        const oldAppPath = getAtlarixAppPath(app.path);
        const newAppPath = getAtlarixAppPath(appPath);
        // Only move files if needed
        if (newAppPath !== oldAppPath) {
          // Move app files
          try {
            // Check if destination directory already exists
            if (fs.existsSync(newAppPath)) {
              throw new Error(
                `Destination path '${newAppPath}' already exists`,
              );
            }

            // Create parent directory if it doesn't exist
            await fsPromises.mkdir(path.dirname(newAppPath), {
              recursive: true,
            });

            // Copy the directory without node_modules
            await copyDir(oldAppPath, newAppPath);
          } catch (error: any) {
            logger.error(
              `Error moving app files from ${oldAppPath} to ${newAppPath}:`,
              error,
            );
            throw new Error(`Failed to move app files: ${error.message}`);
          }

          try {
            // Delete the old directory
            await fsPromises.rm(oldAppPath, { recursive: true, force: true });
          } catch (error: any) {
            // Why is this just a warning? This happens quite often on Windows
            // because it has an aggressive file lock.
            //
            // Not deleting the old directory is annoying, but not a big deal
            // since the user can do it themselves if they need to.
            logger.warn(
              `Error deleting old app directory ${oldAppPath}:`,
              error,
            );
          }
        }

        // Update app in database
        try {
          await db
            .update(apps)
            .set({
              name: appName,
              path: appPath,
            })
            .where(eq(apps.id, appId))
            .returning();

          return;
        } catch (error: any) {
          // Attempt to rollback the file move
          if (newAppPath !== oldAppPath) {
            try {
              // Copy back from new to old
              await copyDir(newAppPath, oldAppPath);
              // Delete the new directory
              await fsPromises.rm(newAppPath, { recursive: true, force: true });
            } catch (rollbackError) {
              logger.error(
                `Failed to rollback file move during rename error:`,
                rollbackError,
              );
            }
          }

          logger.error(`Error updating app ${appId} in database:`, error);
          throw new Error(`Failed to update app in database: ${error.message}`);
        }
      });
    },
  );

  ipcMain.handle("reset-all", async (): Promise<void> => {
    logger.log("start: resetting all apps and settings.");
    // Stop all running apps first
    logger.log("stopping all running apps...");
    const runningAppIds = Array.from(runningApps.keys());
    for (const appId of runningAppIds) {
      try {
        const appInfo = runningApps.get(appId)!;
        await stopAppByInfo(appId, appInfo);
      } catch (error) {
        logger.error(`Error stopping app ${appId} during reset:`, error);
        // Continue with reset even if stopping fails
      }
    }
    logger.log("all running apps stopped.");
    logger.log("deleting database...");
    // 1. Drop the database by deleting the SQLite file
    const dbPath = getDatabasePath();
    if (fs.existsSync(dbPath)) {
      // Close database connections first
      if (db.$client) {
        db.$client.close();
      }
      // WAL/SHM siblings too: deleting only the main file leaves a stale -wal that
      // SQLite may replay into the fresh database, resurrecting rows the user just
      // asked us to destroy.
      for (const suffix of ["", "-wal", "-shm"]) {
        await fsPromises.rm(`${dbPath}${suffix}`, { force: true });
      }
      logger.log(`Database file deleted: ${dbPath}`);
    }
    // Re-open immediately. This handler RETURNS and the app keeps running, so without
    // this every later query hits the closed handle and throws better-sqlite3's opaque
    // "The database connection is not open".
    reinitializeDatabaseAfterReset();
    logger.log("database deleted.");
    logger.log("deleting settings...");
    // 2. Remove settings
    const userDataPath = getUserDataPath();
    const settingsPath = path.join(userDataPath, "user-settings.json");

    if (fs.existsSync(settingsPath)) {
      await fsPromises.unlink(settingsPath);
      logger.log(`Settings file deleted: ${settingsPath}`);
    }
    logger.log("settings deleted.");
    // 3. Remove all app files recursively
    // Doing this last because it's the most time-consuming and the least important
    // in terms of resetting the app state.
    logger.log("removing all app files...");
    const workspaceAppsPath = getAtlarixAppPath(".");
    if (fs.existsSync(workspaceAppsPath)) {
      await fsPromises.rm(workspaceAppsPath, { recursive: true, force: true });
      // Recreate the base directory
      await fsPromises.mkdir(workspaceAppsPath, { recursive: true });
    }
    logger.log("all app files removed.");
    logger.log("reset all complete.");
  });

  ipcMain.handle("get-app-version", async (): Promise<{ version: string }> => {
    return { version: app.getVersion() };
  });

  // The bottom-left "what's new" note. Main resolves it because the fetch, the
  // cache and the validation all live there; the renderer only decides whether
  // this particular note has already been dismissed.
  ipcMain.handle("whats-new:get", async () => {
    const { getWhatsNewEntry } = await import("../../main/whats-new");
    return getWhatsNewEntry();
  });

  ipcMain.handle(
    "get-sentry-config",
    async (): Promise<{
      dsn: string | undefined;
      version: string;
      isPackaged: boolean;
    }> => {
      return {
        dsn: SENTRY_DSN,
        version: app.getVersion(),
        isPackaged: app.isPackaged,
      };
    },
  );

  ipcMain.handle(
    "perf:tool-snapshot",
    async (): Promise<{ name: string; ms: number; at: number }[]> => {
      if (app.isPackaged) return [];
      const { getToolPerfSnapshot } = await import("../../lib/perf/tool-perf");
      return getToolPerfSnapshot();
    },
  );

  ipcMain.handle(
    "get-posthog-config",
    async (): Promise<{
      posthogApiKey: string | undefined;
      analyticsId: string;
    }> => {
      const { getPostHogConfigForRenderer } = await import(
        "../../main/lib/analytics"
      );
      return getPostHogConfigForRenderer();
    },
  );

  handle("rename-branch", async (_, params: RenameBranchParams) => {
    const { appId, oldBranchName, newBranchName } = params;
    const app = await db.query.apps.findFirst({
      where: eq(apps.id, appId),
    });

    if (!app) {
      throw new Error("App not found");
    }

    const appPath = getAtlarixAppPath(app.path);

    return withLock(appId, async () => {
      try {
        // Check if the old branch exists
        const branches = await gitListBranches({ path: appPath });
        if (!branches.includes(oldBranchName)) {
          throw new Error(`Branch '${oldBranchName}' not found.`);
        }

        // Check if the new branch name already exists
        if (branches.includes(newBranchName)) {
          // If newBranchName is 'main' and oldBranchName is 'master',
          // and 'main' already exists, we might want to allow this if 'main' is the current branch
          // and just switch to it, or delete 'master'.
          // For now, let's keep it simple and throw an error.
          throw new Error(
            `Branch '${newBranchName}' already exists. Cannot rename.`,
          );
        }

        await gitRenameBranch({
          path: appPath,
          oldBranch: oldBranchName,
          newBranch: newBranchName,
        });
        logger.info(
          `Branch renamed from '${oldBranchName}' to '${newBranchName}' for app ${appId}`,
        );
      } catch (error: any) {
        logger.error(
          `Failed to rename branch for app ${appId}: ${error.message}`,
        );
        throw new Error(
          `Failed to rename branch '${oldBranchName}' to '${newBranchName}': ${error.message}`,
        );
      }
    });
  });

  handle(
    "respond-to-app-input",
    async (_, { appId, response }: RespondToAppInputParams) => {
      if (response !== "y" && response !== "n") {
        throw new Error(`Invalid response: ${response}`);
      }
      const appInfo = runningApps.get(appId);

      if (!appInfo) {
        throw new Error(`App ${appId} is not running`);
      }

      const { process } = appInfo;

      if (!process.stdin) {
        throw new Error(`App ${appId} process has no stdin available`);
      }

      try {
        // Write the response to stdin with a newline
        process.stdin.write(`${response}\n`);
        logger.debug(`Sent response '${response}' to app ${appId} stdin`);
      } catch (error: any) {
        logger.error(`Error sending response to app ${appId}:`, error);
        throw new Error(`Failed to send response to app: ${error.message}`);
      }
    },
  );

  handle(
    "search-app",
    async (_, searchQuery: string): Promise<AppSearchResult[]> => {
      // Use parameterized query to prevent SQL injection
      const pattern = `%${searchQuery.replace(/[%_]/g, "\\$&")}%`;

      // 1) Apps whose name matches
      const appNameMatches = await db
        .select({
          id: apps.id,
          name: apps.name,
          createdAt: apps.createdAt,
        })
        .from(apps)
        .where(like(apps.name, pattern))
        .orderBy(desc(apps.createdAt));

      const appNameMatchesResult: AppSearchResult[] = appNameMatches.map(
        (r) => ({
          id: r.id,
          name: r.name,
          createdAt: r.createdAt,
          matchedChatTitle: null,
          matchedChatMessage: null,
        }),
      );

      // 2) Apps whose session title matches
      const chatTitleMatches = await db
        .select({
          id: apps.id,
          name: apps.name,
          createdAt: apps.createdAt,
          matchedChatTitle: chatSessions.title,
        })
        .from(apps)
        .innerJoin(chatSessions, eq(apps.id, chatSessions.workspaceId))
        .where(like(chatSessions.title, pattern))
        .orderBy(desc(apps.createdAt));

      const chatTitleMatchesResult: AppSearchResult[] = chatTitleMatches.map(
        (r) => ({
          id: r.id,
          name: r.name,
          createdAt: r.createdAt,
          matchedChatTitle: r.matchedChatTitle,
          matchedChatMessage: null,
        }),
      );

      // 3) Apps whose session message content matches
      const chatMessageMatches = await db
        .select({
          id: apps.id,
          name: apps.name,
          createdAt: apps.createdAt,
          matchedChatTitle: chatSessions.title,
          matchedChatMessage: sessionMessages.content,
        })
        .from(apps)
        .innerJoin(chatSessions, eq(apps.id, chatSessions.workspaceId))
        .innerJoin(
          sessionMessages,
          eq(chatSessions.id, sessionMessages.sessionId),
        )
        .where(like(sessionMessages.content, pattern))
        .orderBy(desc(apps.createdAt));

      // Flatten and dedupe by app id
      const allMatches: AppSearchResult[] = [
        ...appNameMatchesResult,
        ...chatTitleMatchesResult,
        ...chatMessageMatches,
      ];
      const uniqueApps = Array.from(
        new Map(allMatches.map((app) => [app.id, app])).values(),
      );

      // Sort newest apps first
      uniqueApps.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

      return uniqueApps;
    },
  );
}

function getCommand({
  appId,
  installCommand,
  startCommand,
}: {
  appId: number;
  installCommand?: string | null;
  startCommand?: string | null;
}) {
  const hasCustomCommands = !!installCommand?.trim() && !!startCommand?.trim();
  return hasCustomCommands
    ? `${installCommand!.trim()} && ${startCommand!.trim()}`
    : getDefaultCommand(appId);
}

async function cleanUpPort(port: number) {
  await killProcessOnPort(port);
}
