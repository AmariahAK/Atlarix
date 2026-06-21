/**
 * Browser/preview session recordings (frame-sequence reels).
 *
 * Antigravity-style "proof of work": whenever the agent drives the in-app
 * browser or the live preview, we capture WebContentsView frames via
 * capturePage() (the only frame source — WebContentsView has no
 * beginFrameSubscription) and store them as JPEGs under
 * `{userData}/media/{chatId}/{recordingId}/`, plus a manifest. The renderer
 * plays them back as a short, scrubbable reel.
 *
 * One reel per surface ("browser" | "preview") per turn: frames accumulate on
 * the active reel until finalizeReels() is called at turn end. Bounded so a long
 * automation can't grow unbounded; capture is best-effort and never throws into
 * the calling tool handler.
 */

import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";
import type { NativeImage, WebContents } from "electron";
import { getMediaPath } from "@/paths/paths";

const logger = log.scope("browser_reel");

export type ReelSurface = "browser" | "preview";

export interface ReelFrame {
  /** File name within the recording dir (e.g. "frame-3.jpg"). */
  file: string;
  ts: number;
  /** Short human caption (the action that produced this frame). */
  caption: string;
  /** navigate | inspect | click | fill */
  type: string;
}

export interface ReelManifest {
  recordingId: string;
  chatId: number;
  surface: ReelSurface;
  width: number;
  height: number;
  frames: ReelFrame[];
}

/** A finalized recording reference handed to the renderer (no frame data). */
export interface ReelRef {
  recordingId: string;
  chatId: number;
  surface: ReelSurface;
  frameCount: number;
  /** First frame file name, for a thumbnail. */
  firstFrame: string;
}

/** Cap so a long automation can't grow unbounded (~one reel ≈ 60s of activity). */
const MAX_FRAMES = 150;
/** Frame width cap — reels are for review, not pixel-perfect inspection. */
const FRAME_WIDTH = 800;
const JPEG_QUALITY = 60;

interface ActiveReel extends ReelManifest {
  dir: string;
  seq: number;
}

const active = new Map<string, ActiveReel>();

function key(chatId: number, surface: ReelSurface): string {
  return `${chatId}:${surface}`;
}

/** Stable-ish id without Math.random — monotonic per (chat,surface) via ts+seq. */
function newRecordingId(surface: ReelSurface): string {
  return `${surface}-${Date.now()}`;
}

/**
 * Capture one frame for the (chatId, surface) reel. Best-effort and async —
 * errors are logged and swallowed so a capture hiccup never breaks the tool.
 */
export async function recordReelFrame(args: {
  chatId: number | undefined;
  surface: ReelSurface;
  webContents: WebContents | null | undefined;
  caption: string;
  type: string;
}): Promise<void> {
  const { chatId, surface, webContents, caption, type } = args;
  if (chatId == null || !webContents || webContents.isDestroyed()) return;
  try {
    let reel = active.get(key(chatId, surface));
    if (reel && reel.frames.length >= MAX_FRAMES) return; // bounded
    if (!reel) {
      const recordingId = newRecordingId(surface);
      const dir = getMediaPath(chatId, recordingId);
      await fs.mkdir(dir, { recursive: true });
      reel = {
        recordingId,
        chatId,
        surface,
        width: FRAME_WIDTH,
        height: 0,
        frames: [],
        dir,
        seq: 0,
      };
      active.set(key(chatId, surface), reel);
    }
    let image: NativeImage = await webContents.capturePage();
    if (image.isEmpty()) return; // view hidden / zero-size — skip silently
    const size = image.getSize();
    if (size.width > FRAME_WIDTH) image = image.resize({ width: FRAME_WIDTH });
    const finalSize = image.getSize();
    reel.height = finalSize.height;
    reel.width = finalSize.width;
    const file = `frame-${reel.seq++}.jpg`;
    await fs.writeFile(path.join(reel.dir, file), image.toJPEG(JPEG_QUALITY));
    reel.frames.push({ file, ts: Date.now(), caption: caption.slice(0, 200), type });
  } catch (err) {
    logger.warn(`[reel] frame capture failed (${surface}): ${String(err)}`);
  }
}

/**
 * Finalize the active reels for a chat (called at turn end). Writes each
 * manifest and returns refs for reels that captured ≥1 frame. Clears them so
 * the next turn starts fresh.
 */
export async function finalizeReels(
  chatId: number | undefined,
): Promise<ReelRef[]> {
  if (chatId == null) return [];
  const refs: ReelRef[] = [];
  for (const surface of ["browser", "preview"] as const) {
    const reel = active.get(key(chatId, surface));
    if (!reel) continue;
    active.delete(key(chatId, surface));
    if (reel.frames.length === 0) continue;
    const manifest: ReelManifest = {
      recordingId: reel.recordingId,
      chatId: reel.chatId,
      surface: reel.surface,
      width: reel.width,
      height: reel.height,
      frames: reel.frames,
    };
    try {
      await fs.writeFile(
        path.join(reel.dir, "manifest.json"),
        JSON.stringify(manifest, null, 2),
      );
      refs.push({
        recordingId: reel.recordingId,
        chatId: reel.chatId,
        surface: reel.surface,
        frameCount: reel.frames.length,
        firstFrame: reel.frames[0]!.file,
      });
    } catch (err) {
      logger.warn(`[reel] finalize failed: ${String(err)}`);
    }
  }
  if (refs.length > 0) await pruneChatReels(chatId);
  return refs;
}

/** Keep at most this many recording dirs per chat (bounds disk growth). */
const MAX_REELS_PER_CHAT = 12;

/** Remove the oldest reel directories for a chat beyond MAX_REELS_PER_CHAT. */
async function pruneChatReels(chatId: number): Promise<void> {
  const base = getMediaPath(chatId);
  try {
    const entries = await fs.readdir(base, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (dirs.length <= MAX_REELS_PER_CHAT) return;
    // recordingId ends with a millisecond timestamp ("surface-<ts>") — sort by it.
    const ts = (name: string) => Number(name.split("-").pop()) || 0;
    const stale = dirs.sort((a, b) => ts(a) - ts(b)).slice(0, dirs.length - MAX_REELS_PER_CHAT);
    await Promise.all(
      stale.map((d) =>
        fs.rm(path.join(base, d), { recursive: true, force: true }).catch(() => {}),
      ),
    );
  } catch {
    /* no media dir yet — nothing to prune */
  }
}

/** Read a finalized reel's manifest (for the renderer player). */
export async function readReelManifest(
  chatId: number,
  recordingId: string,
): Promise<ReelManifest | null> {
  try {
    const raw = await fs.readFile(
      path.join(getMediaPath(chatId, recordingId), "manifest.json"),
      "utf8",
    );
    return JSON.parse(raw) as ReelManifest;
  } catch {
    return null;
  }
}

/** Remove all captured media for a chat (called on chat delete). */
export async function clearChatMedia(chatId: number | undefined): Promise<void> {
  if (chatId == null) return;
  active.delete(key(chatId, "browser"));
  active.delete(key(chatId, "preview"));
  try {
    await fs.rm(getMediaPath(chatId), { recursive: true, force: true });
  } catch (err) {
    logger.warn(`[reel] clear media failed for chat ${chatId}: ${String(err)}`);
  }
}
