import { ipcMain } from "electron";
import log from "electron-log";
import { buildAtlarixCoreTierCatalog } from "@/lib/atlarix-core-catalog";
import { isCompassBuildConfigured } from "../shared/compass_constants";
import { getCompassUsageFromSupabase } from "../../lib/auth/compass_usage";

const logger = log.scope("compass_ipc");

export function registerCompassHandlers(): void {
  ipcMain.handle("compass:is-build-configured", () => {
    return isCompassBuildConfigured();
  });

  ipcMain.handle("compass:get-tier-catalog", () => {
    return buildAtlarixCoreTierCatalog();
  });

  ipcMain.handle("compass:get-usage", async () => {
    try {
      return await getCompassUsageFromSupabase();
    } catch (e) {
      logger.warn("compass:get-usage", e);
      return null;
    }
  });

  logger.log("[compass] handlers registered");
}
