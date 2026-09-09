/**
 * Small unrelated pure-leaf helpers extracted from chat_stream_handlers.ts:
 * a promise/timeout race, a text-file test, and the full snapshot-revert
 * routine. No module state. (Satellite: never imports the parent handler.)
 */

import log from "electron-log";
import {
  revertSnapshot,
  revertSnapshotFiles,
} from "@/lib/snapshot/snapshot-manager";
import { getStreamTransport } from "@/lib/chat/stream-transport";

const logger = log.scope("chat_stream_handlers");

export async function awaitWithTimeout(
  p: Promise<unknown>,
  ms: number,
): Promise<void> {
  await Promise.race([
    p.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}

/**
 * Is this attachment readable as text? Decided by reading its head, not its name.
 *
 * Was an extension allowlist, which meant a `.mjs`, `.vue`, `.ps1` or extensionless
 * `Dockerfile` attachment got NO inline preview and was labelled `binary` to the
 * model — while a `.ts` on macOS was reported as `video/mp2t` and mishandled the
 * other way. Sniffing answers both, and covers file types nobody has invented yet.
 *
 * Only the first `SNIFF_SAMPLE_BYTES` are read: classifying must not mean loading a
 * large attachment in full.
 */
export async function isTextFile(filePath: string): Promise<boolean> {
  const { open } = await import("node:fs/promises");
  const { classifyContent, SNIFF_SAMPLE_BYTES } = await import(
    "@/lib/file-content-type"
  );
  let handle;
  try {
    handle = await open(filePath, "r");
    const buf = Buffer.alloc(SNIFF_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SNIFF_SAMPLE_BYTES, 0);
    return (
      classifyContent(new Uint8Array(buf.subarray(0, bytesRead))).kind ===
      "text"
    );
  } catch (err) {
    // Unreadable is not "binary" — say so and let the caller skip the preview.
    logger.warn(`isTextFile: could not sample ${filePath}: ${String(err)}`);
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Full snapshot revert + ledger cancel + message `isReverted` flags + blueprint (via `revertSnapshot` or partial files + sync). */
export async function performFullRevert(params: {
  chatId: number;
  turnId: string;
  assistantMessageId: number;
  workspacePath: string;
  workspaceId: number;
  options?: {
    /** Only restore these workspace-relative paths from the turn snapshot (no full diagram rollback). */
    filesFilter?: string[];
    /** Skip isReverted / hasAnsweredQuestions updates (e.g. autonomous single-file revert). */
    skipMessageFlags?: boolean;
  };
}): Promise<{
  success: boolean;
  error?: string;
  restoredFiles?: number;
}> {
  const { chatId, turnId, assistantMessageId, workspacePath } = params;
  const skipMessageFlags = params.options?.skipMessageFlags ?? false;
  const filesFilter = params.options?.filesFilter;

  const snap =
    filesFilter != null && filesFilter.length > 0
      ? await revertSnapshotFiles({
          workspacePath,
          turnId,
          relativePaths: filesFilter,
        })
      : await revertSnapshot({
          workspacePath,
          turnId,
        });
  if (!snap.success) {
    logger.warn("performFullRevert: snapshot restore failed:", snap.error);
  }

  if (skipMessageFlags) {
    return {
      success: snap.success,
      error: snap.error,
      restoredFiles: snap.restoredFiles,
    };
  }

  const ec = getStreamTransport(chatId);
  if (ec) {
    const idx = ec.messages.findIndex((m) => m.id === assistantMessageId);
    if (idx < 0) {
      return {
        success: false,
        error: "Message not in chat",
        restoredFiles: snap.restoredFiles,
      };
    }
    ec.messages = ec.messages.map((m, i) => ({
      ...m,
      isReverted: i >= idx ? true : false,
    }));
  }

  return {
    success: snap.success,
    error: snap.error,
    restoredFiles: snap.restoredFiles,
  };
}
