import { ipcMain } from "electron";
import log from "electron-log";
import { readTourState, writeTourState, type TourState } from "../../main/tour-store";

const logger = log.scope("tour-handlers");

export function registerTourHandlers(): void {
  ipcMain.handle("tour:get-state", async (): Promise<TourState> => {
    return readTourState();
  });

  ipcMain.handle("tour:set-state", async (_e, partial: Partial<TourState>): Promise<TourState> => {
    logger.log("tour:set-state", partial);
    return writeTourState(partial);
  });
}
