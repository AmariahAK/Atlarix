/**
 * Workspace Snapshots (Pro)
 * =========================
 * One-click save/restore of workspace state: files, prompt, chat.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { db } from "../db";
import { workspaceSnapshots } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { resolveAppPath } from "../paths/paths";
import { glob } from "glob";
import log from "electron-log";

const logger = log.scope("workspace-snapshots");

const IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/__pycache__/**",
  "**/*.pyc",
  "**/.env",
  "**/.env.*",
];
const MAX_FILES = 500;
const MAX_FILE_SIZE = 500_000; // 500KB per file

export async function createSnapshot(
  appId: number,
  name: string,
  appPath: string,
  chatMessages?: Array<{ role: string; content: string }>,
): Promise<{ id: number }> {
  const fullPath = path.isAbsolute(appPath) ? appPath : resolveAppPath(appPath);

  const files: Record<string, string> = {};
  const rawFiles = await glob("**/*", {
    cwd: fullPath,
    nodir: true,
    ignore: IGNORE_PATTERNS,
  });

  let count = 0;
  for (const rel of rawFiles) {
    if (count >= MAX_FILES) break;
    try {
      const abs = path.join(fullPath, rel);
      const stat = await fs.stat(abs);
      if (stat.size > MAX_FILE_SIZE) continue;
      const content = await fs.readFile(abs, "utf-8");
      files[rel] = content;
      count++;
    } catch {
      // Skip unreadable files
    }
  }

  const [snapshot] = await db
    .insert(workspaceSnapshots)
    .values({
      appId,
      name,
      filesJson: files,
      promptContent: null,
      chatMessagesJson: chatMessages ?? null,
    })
    .returning({ id: workspaceSnapshots.id });

  logger.log(
    `Created snapshot ${snapshot.id} for app ${appId}: ${Object.keys(files).length} files`,
  );
  return { id: snapshot.id };
}

export async function listSnapshots(appId: number): Promise<
  Array<{
    id: number;
    name: string;
    createdAt: Date;
    fileCount: number;
  }>
> {
  const rows = await db
    .select()
    .from(workspaceSnapshots)
    .where(eq(workspaceSnapshots.appId, appId))
    .orderBy(desc(workspaceSnapshots.createdAt));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    fileCount: Object.keys((r.filesJson as Record<string, string>) || {})
      .length,
  }));
}

export async function restoreSnapshot(
  snapshotId: number,
  appPath: string,
): Promise<{ success: boolean; error?: string }> {
  const [snapshot] = await db
    .select()
    .from(workspaceSnapshots)
    .where(eq(workspaceSnapshots.id, snapshotId));

  if (!snapshot) {
    return { success: false, error: "Snapshot not found" };
  }

  const fullPath = path.isAbsolute(appPath) ? appPath : resolveAppPath(appPath);
  const files = (snapshot.filesJson as Record<string, string>) || {};

  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(fullPath, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf-8");
    }
    logger.log(
      `Restored snapshot ${snapshotId}: ${Object.keys(files).length} files`,
    );
    return { success: true };
  } catch (e) {
    logger.error("Restore failed:", e);
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function getSnapshotForRestore(snapshotId: number): Promise<{
  promptContent: string | null;
  chatMessages: Array<{ role: string; content: string }> | null;
} | null> {
  const [snapshot] = await db
    .select()
    .from(workspaceSnapshots)
    .where(eq(workspaceSnapshots.id, snapshotId));

  if (!snapshot) return null;
  return {
    promptContent: snapshot.promptContent,
    chatMessages: snapshot.chatMessagesJson as Array<{
      role: string;
      content: string;
    }> | null,
  };
}
