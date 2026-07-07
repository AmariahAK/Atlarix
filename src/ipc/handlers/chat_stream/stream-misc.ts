/**
 * Small unrelated pure-leaf helpers extracted from chat_stream_handlers.ts:
 * a promise/timeout race, a text-file test, and the full snapshot-revert
 * routine. No module state. (Satellite: never imports the parent handler.)
 */

import * as path from "path";
import log from "electron-log";
import {
  revertSnapshot,
  revertSnapshotFiles,
} from "@/lib/snapshot/snapshot-manager";
import { getStreamTransport } from "@/lib/chat/stream-transport";

const logger = log.scope("chat_stream_handlers");

export async function awaitWithTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  await Promise.race([
    p.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}

export async function isTextFile(filePath: string): Promise<boolean> {
  // W3 (v14.8.11): one shared list with read_attachment — the old 8-entry
  // local whitelist meant a .py/.go upload got NO inline preview at all.
  const { isSupportedTextExtension } = await import("@/lib/attachment-extensions");
  return isSupportedTextExtension(path.extname(filePath).toLowerCase());
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
  const { chatId, turnId, assistantMessageId, workspacePath } =
    params;
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
