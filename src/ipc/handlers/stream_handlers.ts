/**
 * IPC handlers for stream tools (terminal / pipeline output collection).
 * v3.9
 */

import { ipcMain } from "electron";
import {
  openStream,
  closeStream,
  getCollectedLines,
  listActiveStreams,
  feedTerminalOutput,
  type StreamSource,
} from "../../lib/streams/StreamManager";

export function registerStreamHandlers(): void {
  ipcMain.handle(
    "stream:open",
    (
      _event,
      payload: {
        source: StreamSource;
        chatId?: number | null;
        filter?: string | null;
        maxLines?: number;
        maxBytes?: number;
        timeoutMs?: number;
        jobId?: number;
        mode?: "error_first" | "progress_first" | "raw_capped";
      },
    ) => {
      const {
        source,
        chatId,
        filter,
        maxLines,
        maxBytes,
        timeoutMs,
        jobId,
        mode,
      } = payload;
      return openStream(source, {
        chatId: chatId ?? null,
        filter: filter ?? null,
        maxLines,
        maxBytes,
        timeoutMs,
        jobId,
        mode,
      });
    },
  );

  ipcMain.handle("stream:close", (_event, streamId: string) => {
    closeStream(streamId);
    return { success: true };
  });

  ipcMain.handle("stream:get-lines", (_event, streamId: string) => {
    return getCollectedLines(streamId);
  });

  ipcMain.handle("stream:list-active", () => {
    return listActiveStreams();
  });

  /** Called from chat stream handler when terminal output is received for a chat. */
  ipcMain.handle(
    "stream:feed-terminal",
    (_event, chatId: number, output: string) => {
      feedTerminalOutput(chatId, output);
      return { success: true };
    },
  );
}
