import { ipcMain } from "electron";
import log from "electron-log";
import { buildAtlarixCoreTierCatalog } from "@/lib/atlarix-core-catalog";
import { isCompassBuildConfigured } from "../shared/compass_constants";

const logger = log.scope("compass_ipc");

export function registerCompassHandlers(): void {
  ipcMain.handle("compass:is-build-configured", () => {
    return isCompassBuildConfigured();
  });

  ipcMain.handle("compass:get-tier-catalog", () => {
    return buildAtlarixCoreTierCatalog();
  });

  logger.log("[compass] handlers registered");
}
