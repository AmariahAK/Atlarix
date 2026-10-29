import { app, ipcMain, IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import * as Sentry from "@sentry/electron/main";
import {
  ExpectedUserError,
  expectedErrorMessage,
} from "@/shared/expected_error";

const verboseIpc = process.env.ATLARIX_VERBOSE_IPC === "1";

/**
 * Sender-frame guard (A4/H-2): in a packaged build the legitimate main frame is
 * always loaded from `file://`. Any IPC whose sender frame is an http(s) origin
 * can only be off-origin content that hijacked the frame — reject it. Dev builds
 * load the renderer from the http localhost dev server, so the guard is
 * production-only. A null senderFrame (detached/unknown) is not blocked here.
 */
function isUntrustedSenderFrame(event: IpcMainInvokeEvent): boolean {
  if (!app.isPackaged) return false;
  const frameUrl = event.senderFrame?.url ?? "";
  return /^https?:\/\//i.test(frameUrl);
}

export function createLoggedHandler(logger: log.LogFunctions) {
  return (
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any>,
  ) => {
    ipcMain.handle(
      channel,
      async (event: IpcMainInvokeEvent, ...args: any[]) => {
        if (isUntrustedSenderFrame(event)) {
          logger.error(
            `IPC ${channel} rejected: untrusted sender frame ${event.senderFrame?.url}`,
          );
          throw new Error(`[${channel}] rejected: untrusted sender frame`);
        }
        if (verboseIpc) {
          logger.log(
            `IPC: ${channel} called with args: ${JSON.stringify(args)}`,
          );
        }
        try {
          const result = await fn(event, ...args);
          if (verboseIpc) {
            logger.log(
              `IPC: ${channel} returned: ${JSON.stringify(result)?.slice(0, 100)}...`,
            );
          }
          return result;
        } catch (error) {
          // The user's own doing (a moved folder): logged, never reported.
          if (error instanceof ExpectedUserError) {
            logger.warn(`IPC ${channel}: ${error.message}`);
            throw new Error(expectedErrorMessage(error));
          }
          logger.error(
            `Error in ${fn.name}: args: ${JSON.stringify(args)}`,
            error,
          );
          Sentry.captureException(error);
          throw new Error(`[${channel}] ${error}`);
        }
      },
    );
  };
}
