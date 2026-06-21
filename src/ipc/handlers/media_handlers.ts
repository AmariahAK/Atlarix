/**
 * Media IPC — serves captured browser/preview session reels to the renderer.
 *
 * Frames live on disk under {userData}/media/{chatId}/{recordingId}/ as JPEGs.
 * The renderer's reel player asks for a whole recording on demand (only when the
 * user expands the card), and we return the manifest plus each frame inlined as
 * a base64 data URL — no custom protocol / CSP work, and nothing large is ever
 * embedded in chat messages.
 */

import { ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";
import { getMediaPath } from "@/paths/paths";
import { readReelManifest } from "../utils/browser-reel";

const logger = log.scope("media_ipc");

/** Frame file names are `frame-<n>.jpg`; never trust caller input for paths. */
function safeFrameName(name: string): string | null {
  return /^frame-\d+\.jpg$/.test(name) ? name : null;
}

/** recordingId is `<surface>-<digits>` — reject anything with path separators. */
function safeRecordingId(id: string): string | null {
  return /^[a-z]+-\d+$/.test(id) ? id : null;
}

export function registerMediaHandlers(): void {
  ipcMain.handle(
    "media:get-recording",
    async (_e, arg: { chatId: number; recordingId: string }) => {
      const chatId = Number(arg?.chatId);
      const recordingId = safeRecordingId(String(arg?.recordingId ?? ""));
      if (!Number.isFinite(chatId) || !recordingId) return null;

      const manifest = await readReelManifest(chatId, recordingId);
      if (!manifest) return null;

      const dir = getMediaPath(chatId, recordingId);
      const frames: {
        caption: string;
        type: string;
        ts: number;
        dataUrl: string;
      }[] = [];
      for (const f of manifest.frames) {
        const file = safeFrameName(f.file);
        if (!file) continue;
        try {
          const buf = await fs.readFile(path.join(dir, file));
          frames.push({
            caption: f.caption,
            type: f.type,
            ts: f.ts,
            dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`,
          });
        } catch {
          /* missing frame — skip */
        }
      }
      return {
        recordingId,
        surface: manifest.surface,
        width: manifest.width,
        height: manifest.height,
        frames,
      };
    },
  );

  logger.log("[media] handlers registered");
}
