import { dialog } from "electron";
import fs from "fs/promises";
import path from "path";
import { createLoggedHandler } from "./safe_handle";
import log from "electron-log";
import { apps, chats } from "@/db/schema";
import { db } from "@/db";
import { eq } from "drizzle-orm";

import { ImportAppParams, ImportAppResult } from "../ipc_types";
import { importWorkspaceFromPath } from "./import_workspace_core";
import { resolveAppPath } from "@/paths/paths";

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
      const isRemoteUri = sourcePath.startsWith("atlarix-remote://");
      const resolvedPath =
        !isRemoteUri && !path.isAbsolute(sourcePath)
          ? resolveAppPath(sourcePath)
          : sourcePath;
      if (!isRemoteUri) {
        try {
          await fs.access(resolvedPath);
        } catch {
          throw new Error("Source folder does not exist");
        }
      }
      return importWorkspaceFromPath({
        path: resolvedPath,
        appName,
        installCommand,
        startCommand,
      });
    },
  );

  logger.debug("Registered import IPC handlers");
}
