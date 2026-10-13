/**
 * Snapshot / revert IPC handlers extracted from registerChatStreamHandlers:
 * snapshot:exists, chat:revert-to-message, autonomous:revert-op,
 * autonomous:accept-all, revert:snapshot, snapshot:files,
 * revert:snapshot-range, snapshot:files-range. Self-contained callbacks
 * reaching workspace/snapshot state through shared modules.
 *
 * (Satellite: never imports the parent handler.)
 */

import * as path from "path";
import log from "electron-log";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { getAtlarixAppPath, resolveAppPath } from "@/paths/paths";
import {
  getStreamTransport,
  getStreamTransportAppId,
} from "@/lib/chat/stream-transport";
import { snapshotExists } from "@/lib/snapshot/snapshot-manager";
import { performFullRevert } from "./stream-misc";
import { ipcMain } from "electron";

const logger = log.scope("chat_stream_handlers");

export function registerRevertHandlers(): void {
  ipcMain.handle(
    "snapshot:exists",
    async (_event, payload: { appId: number; turnId: string }) => {
      const { appId, turnId } = payload;
      if (!turnId || appId == null || Number.isNaN(Number(appId))) {
        return false;
      }
      const app = await db.query.apps.findFirst({
        where: eq(apps.id, appId),
      });
      if (!app) return false;
      const workspacePath = getAtlarixAppPath(app.path);
      // v10: shadow-git store first, legacy .bak dirs second.
      return snapshotExists(workspacePath, String(turnId));
    },
  );

  ipcMain.handle(
    "chat:revert-to-message",
    async (_event, payload: { chatId: number; assistantMessageId: number }) => {
      const { chatId, assistantMessageId } = payload;
      const ec = getStreamTransport(chatId);
      const msg = ec?.messages.find((m) => m.id === assistantMessageId);
      if (!msg || msg.role !== "assistant") {
        throw new Error("Assistant message not found");
      }
      const appId = getStreamTransportAppId(chatId) ?? null;
      const turnId = String(assistantMessageId);
      if (appId != null) {
        const app = await db.query.apps.findFirst({
          where: eq(apps.id, appId),
        });
        if (app) {
          const appPath = resolveAppPath(app.path);
          const result = await performFullRevert({
            chatId,
            turnId,
            assistantMessageId,
            workspacePath: appPath,
            workspaceId: appId,
          });
          if (!result.success && result.error) {
            logger.warn("Revert: performFullRevert:", result.error);
          }
          return { success: true };
        }
      }
      return { success: true };
    },
  );

  ipcMain.handle(
    "autonomous:revert-op",
    async (
      _event,
      payload: { chatId: number; turnId: string; operationId: string },
    ) => {
      const { findAutonomousOp, markAutonomousOpReverted } = await import(
        "../autonomous-session-state"
      );
      const op = findAutonomousOp(
        payload.chatId,
        payload.turnId,
        payload.operationId,
      );
      if (!op?.path) {
        return { success: false, error: "No file path for this operation" };
      }
      const workspaceId = getStreamTransportAppId(payload.chatId);
      if (workspaceId == null) {
        return { success: false, error: "Chat has no workspace" };
      }
      const app = await db.query.apps.findFirst({
        where: eq(apps.id, workspaceId),
      });
      if (!app?.path) {
        return { success: false, error: "Chat has no workspace" };
      }
      const workspacePath = resolveAppPath(app.path);
      const rel = op.path.split(path.sep).join("/");
      const assistantMessageId = Number(payload.turnId);
      if (!Number.isFinite(assistantMessageId)) {
        return { success: false, error: "Invalid turnId" };
      }
      const result = await performFullRevert({
        chatId: payload.chatId,
        turnId: payload.turnId,
        assistantMessageId,
        workspacePath,
        workspaceId,
        options: {
          filesFilter: [rel],
          skipMessageFlags: true,
        },
      });
      if (result.success) {
        markAutonomousOpReverted(
          payload.chatId,
          payload.turnId,
          payload.operationId,
        );
      }
      return result;
    },
  );

  ipcMain.handle(
    "autonomous:accept-all",
    async (_event, payload: { chatId: number; turnId: string }) => {
      const { clearAutonomousSession } = await import(
        "../autonomous-session-state"
      );
      clearAutonomousSession(payload.chatId, payload.turnId);
      return { success: true };
    },
  );

  ipcMain.handle(
    "revert:snapshot",
    async (
      _event,
      payload: { chatId: number; turnId: string; filesOnly?: boolean },
    ) => {
      const { chatId, turnId, filesOnly } = payload;
      const assistantMessageId = Number(turnId);
      if (!Number.isFinite(assistantMessageId)) {
        return { success: false, error: "Invalid turnId" };
      }
      const ec = getStreamTransport(chatId);
      const msg = ec?.messages.find((m) => m.id === assistantMessageId);
      if (!msg || msg.role !== "assistant") {
        return {
          success: false,
          error: "Assistant message not found for this chat and turnId",
        };
      }
      const workspaceId = getStreamTransportAppId(chatId);
      if (workspaceId == null) {
        return { success: false, error: "No workspace attached" };
      }
      const app = await db.query.apps.findFirst({
        where: eq(apps.id, workspaceId),
      });
      if (!app?.path) {
        return { success: false, error: "No workspace attached" };
      }
      const workspacePath = resolveAppPath(app.path);
      const result = await performFullRevert({
        chatId,
        turnId,
        assistantMessageId,
        workspacePath,
        workspaceId,
        // v13.1: a "revert this turn's files" restore only rolls back the files;
        // it must NOT flag the conversation/messages as reverted.
        ...(filesOnly ? { options: { skipMessageFlags: true } } : {}),
      });
      if (filesOnly && result.success) {
        // The reply shows it was reverted (after a restart too), and the agent
        // is told with the next message (snapshot:take-reverted-files).
        const { markSnapshotReverted } = await import(
          "@/lib/snapshot/snapshot-manager"
        );
        await markSnapshotReverted(workspacePath, turnId).catch((err) =>
          logger.warn("revert: could not record the revert:", err),
        );
      }
      return result;
    },
  );

  // The files of this chat's turns reverted since the agent was last told
  // (see markSnapshotReverted); taken once, as the user's next message goes.
  ipcMain.handle(
    "snapshot:take-reverted-files",
    async (_event, payload: { chatId: number; turnIds: string[] }) => {
      const { chatId, turnIds } = payload;
      if (!Array.isArray(turnIds) || turnIds.length === 0) return [];
      const workspaceId = getStreamTransportAppId(chatId);
      if (workspaceId == null) return [];
      const app = await db.query.apps.findFirst({
        where: eq(apps.id, workspaceId),
      });
      if (!app?.path) return [];
      const { takeUntoldRevertedFiles } = await import(
        "@/lib/snapshot/snapshot-manager"
      );
      return takeUntoldRevertedFiles(
        resolveAppPath(app.path),
        turnIds.map(String),
      );
    },
  );

  // v13.1: list the files a turn's snapshot would restore/delete (for the
  // "revert this turn's file changes" confirmation dialog).
  ipcMain.handle(
    "snapshot:files",
    async (_event, payload: { chatId: number; turnId: string }) => {
      const { chatId, turnId } = payload;
      if (!turnId) return null;
      const workspaceId = getStreamTransportAppId(chatId);
      if (workspaceId == null) return null;
      const app = await db.query.apps.findFirst({
        where: eq(apps.id, workspaceId),
      });
      if (!app?.path) return null;
      const { listSnapshotFiles } = await import(
        "@/lib/snapshot/snapshot-manager"
      );
      return listSnapshotFiles(resolveAppPath(app.path), String(turnId));
    },
  );

  // Edit-and-resend: revert the file changes of a RANGE of turns (the turns
  // discarded by editing an earlier message). turnIds arrive in chronological
  // order; we revert NEWEST→OLDEST because each turn's snapshot holds the
  // workspace state BEFORE that turn — reverting forward would re-apply earlier
  // turns' edits. Per-turn snapshots are per-touched-file, so reverting every
  // discarded turn (not just the earliest) is required to remove files created
  // by later turns. Files-only (never flags messages). A missing/expired
  // snapshot is skipped, not fatal.
  ipcMain.handle(
    "revert:snapshot-range",
    async (_event, payload: { chatId: number; turnIds: string[] }) => {
      const { chatId, turnIds } = payload;
      if (!Array.isArray(turnIds) || turnIds.length === 0) {
        return { success: true, restoredFiles: 0, reverted: [], skipped: [] };
      }
      const workspaceId = getStreamTransportAppId(chatId);
      if (workspaceId == null) {
        return { success: false, error: "No workspace attached" };
      }
      const app = await db.query.apps.findFirst({
        where: eq(apps.id, workspaceId),
      });
      if (!app?.path) {
        return { success: false, error: "No workspace attached" };
      }
      const workspacePath = resolveAppPath(app.path);
      const ordered = [...turnIds].reverse(); // newest → oldest
      let restoredFiles = 0;
      const reverted: string[] = [];
      const skipped: string[] = [];
      let lastError: string | undefined;
      for (const turnId of ordered) {
        const assistantMessageId = Number(turnId);
        if (!Number.isFinite(assistantMessageId)) {
          skipped.push(turnId);
          continue;
        }
        try {
          const res = await performFullRevert({
            chatId,
            turnId: String(turnId),
            assistantMessageId,
            workspacePath,
            workspaceId,
            options: { skipMessageFlags: true },
          });
          if (res.success) {
            reverted.push(turnId);
            restoredFiles += res.restoredFiles ?? 0;
          } else {
            skipped.push(turnId);
            lastError = res.error ?? lastError;
          }
        } catch (e) {
          skipped.push(turnId);
          lastError = e instanceof Error ? e.message : String(e);
        }
      }
      // success = the operation ran (workspace resolved); per-turn skips (e.g.
      // an expired snapshot) are reported, not treated as a hard failure.
      return {
        success: true,
        restoredFiles,
        reverted,
        skipped,
        error: lastError,
      };
    },
  );

  // Union of files a RANGE of turn snapshots would restore/delete — powers the
  // edit-and-resend confirmation dialog's "M file change(s)" summary.
  ipcMain.handle(
    "snapshot:files-range",
    async (_event, payload: { chatId: number; turnIds: string[] }) => {
      const { chatId, turnIds } = payload;
      if (!Array.isArray(turnIds) || turnIds.length === 0) {
        return { filesChanged: [], createdFiles: [], turnsWithSnapshot: 0 };
      }
      const workspaceId = getStreamTransportAppId(chatId);
      if (workspaceId == null) return null;
      const app = await db.query.apps.findFirst({
        where: eq(apps.id, workspaceId),
      });
      if (!app?.path) return null;
      const { listSnapshotFiles } = await import(
        "@/lib/snapshot/snapshot-manager"
      );
      const workspacePath = resolveAppPath(app.path);
      const filesChanged = new Set<string>();
      const createdFiles = new Set<string>();
      let turnsWithSnapshot = 0;
      for (const turnId of turnIds) {
        const files = await listSnapshotFiles(workspacePath, String(turnId));
        if (!files) continue;
        turnsWithSnapshot++;
        for (const f of files.filesChanged ?? []) filesChanged.add(f);
        for (const f of files.createdFiles ?? []) createdFiles.add(f);
      }
      return {
        filesChanged: [...filesChanged],
        createdFiles: [...createdFiles],
        turnsWithSnapshot,
      };
    },
  );
}
