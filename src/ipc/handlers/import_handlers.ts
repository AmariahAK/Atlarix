import { dialog } from "electron";
import fs from "fs/promises";
import path from "path";
import { createLoggedHandler } from "./safe_handle";
import log from "electron-log";
import { apps, chats } from "@/db/schema";
import { db } from "@/db";
import { eq } from "drizzle-orm";

import { ImportAppParams, ImportAppResult } from "../ipc_types";
import { getCoAuthorTrailerForCommit, gitCommit, gitAdd, gitInit } from "../utils/git_utils";

const logger = log.scope("import-handlers");
const handle = createLoggedHandler(logger);

export function registerImportHandlers() {
  // Handler for selecting an app folder
  handle("select-app-folder", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Select App Folder to Import",
    });

    if (result.canceled) {
      return { path: null, name: null };
    }

    const selectedPath = result.filePaths[0];
    const folderName = path.basename(selectedPath);

    return { path: selectedPath, name: folderName };
  });

  // Handler for checking if an app name is already taken
  // Imports use absolute path; atlarix-apps not used. Just check database.
  handle("check-app-name", async (_, { appName }: { appName: string }) => {
    const existingApp = await db.query.apps.findFirst({
      where: eq(apps.name, appName),
    });
    return { exists: !!existingApp };
  });

  // Handler for importing an app
  handle(
    "import-app",
    async (
      _,
      {
        path: sourcePath,
        appName,
        installCommand,
        startCommand,
      }: ImportAppParams,
    ): Promise<ImportAppResult> => {
      // Validate the source path exists
      try {
        await fs.access(sourcePath);
      } catch {
        throw new Error("Source folder does not exist");
      }

      // Check workspace limit (safeguard - frontend should check first)
      const { SubscriptionManager } = await import("../../lib/SubscriptionManager");
      const limitCheck = await SubscriptionManager.canCreateWorkspace();
      if (!limitCheck.allowed) {
        throw new Error(limitCheck.reason || "Workspace limit reached. Upgrade to Pro for unlimited workspaces.");
      }

      // Check if an app with this PATH already exists (return existing if so)
      const existingByPath = await db.query.apps.findFirst({
        where: eq(apps.path, sourcePath),
      });
      if (existingByPath) {
        // This workspace is already registered - return existing IDs
        const existingChat = await db.query.chats.findFirst({
          where: eq(chats.appId, existingByPath.id),
        });
        if (existingChat) {
          return { appId: existingByPath.id, chatId: existingChat.id };
        }
        // No chat exists, create one
        const [newChat] = await db
          .insert(chats)
          .values({ appId: existingByPath.id })
          .returning();
        return { appId: existingByPath.id, chatId: newChat.id };
      }

      // Check if an app with this NAME already exists (different path)
      const existingByName = await db.query.apps.findFirst({
        where: eq(apps.name, appName),
      });
      if (existingByName) {
        throw new Error("An app with this name already exists");
      }

      // NO COPYING - We use the source folder directly
      // This is the key change: workspaces are registered by their original location

      // Initialize git if not already a repo (in the SOURCE folder)
      const isGitRepo = await fs
        .access(path.join(sourcePath, ".git"))
        .then(() => true)
        .catch(() => false);
      if (!isGitRepo) {
        // Initialize git repo and create first commit
        await gitInit({ path: sourcePath, ref: "main" });

        // Stage all files
        await gitAdd({ path: sourcePath, filepath: "." });

        // Create initial commit (allowEmpty so empty folders get a commit and HEAD exists)
        await gitCommit({
          path: sourcePath,
          message: "Init Atlarix app",
          allowEmpty: true,
          coAuthorTrailer: getCoAuthorTrailerForCommit(),
        });
      }

      // Create a new app - store the ORIGINAL source path (absolute path)
      // so tools can find files directly without any copying
      const [app] = await db
        .insert(apps)
        .values({
          name: appName,
          path: sourcePath,
          installCommand: installCommand ?? null,
          startCommand: startCommand ?? null,
        })
        .returning();

      // Create an initial chat for this app
      const [chat] = await db
        .insert(chats)
        .values({
          appId: app.id,
        })
        .returning();

      // Capture initial diagram snapshot for the new workspace
      try {
        const { captureInitialSnapshot } = await import("../../lib/diagram-timeline/capture");
        await captureInitialSnapshot(app.id);
        logger.info(`Captured initial diagram snapshot for app ${app.id}`);
      } catch (error) {
        logger.error(`Failed to capture initial snapshot: ${error}`);
        // Don't fail the import if snapshot fails
      }

      return { appId: app.id, chatId: chat.id };
    },
  );

  logger.debug("Registered import IPC handlers");
}
