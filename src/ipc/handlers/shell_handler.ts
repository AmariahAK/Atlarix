import { shell } from "electron";
import log from "electron-log";
import { validateOpenExternalUrl } from "../../lib/external_url";
import { assertFileUnderRegisteredWorkspace } from "@/lib/security/workspace-path";
import { createLoggedHandler } from "./safe_handle";

const logger = log.scope("shell_handlers");
const handle = createLoggedHandler(logger);

export function registerShellHandlers() {
  handle("open-external-url", async (_event, url: string) => {
    validateOpenExternalUrl(url);
    await shell.openExternal(url);
    logger.debug("Opened external URL:", url);
  });

  handle("show-item-in-folder", async (_event, fullPath: string) => {
    if (!fullPath) {
      throw new Error("No file path provided.");
    }

    try {
      await assertFileUnderRegisteredWorkspace(fullPath);
    } catch (err) {
      logger.warn("show-item-in-folder rejected path:", fullPath, err);
      throw err;
    }

    shell.showItemInFolder(fullPath);
    logger.debug("Showed item in folder:", fullPath);
  });
}
