/**
 * Shared workspace import logic for IPC and CLI open-folder.
 */

import fs from "fs/promises";
import { apps } from "@/db/schema";
import { db } from "@/db";
import { eq } from "drizzle-orm";
import { parseRemoteUri } from "@/lib/workspace-fs";
import { noteWorkspaceCreated } from "@/ipc/utils/workspace-quota";
import { startWorkspaceSession } from "./workspace_session_handlers";
import { normalizeAppPath, realAppPath } from "@/lib/canonical-app-path";

export async function importWorkspaceFromPath({
  path: sourcePath,
  appName,
  installCommand,
  startCommand,
}: {
  path: string;
  appName: string;
  installCommand?: string | null;
  startCommand?: string | null;
}): Promise<{ appId: number; chatId: number; sessionId: string }> {
  const remote = parseRemoteUri(sourcePath);
  const workspaceKind = remote ? "remote-ssh" : "local";
  if (!remote) {
    await fs.access(sourcePath);
  }

  // Bug 5: dedupe by NORMALIZED path (not exact string) for local workspaces so
  // reopening the same folder with a different representation (trailing slash,
  // separators, case) reuses the existing row instead of creating a duplicate.
  // Remote URIs keep exact matching (path.resolve would mangle them).
  let existingByPath = await db.query.apps.findFirst({
    where: eq(apps.path, sourcePath),
  });
  if (!existingByPath && !remote) {
    const targetNorm = normalizeAppPath(sourcePath);
    const all = await db.query.apps.findMany();
    existingByPath =
      all
        .filter((a) => a.workspaceKind !== "remote-ssh")
        .sort((a, b) => a.id - b.id)
        .find((a) => normalizeAppPath(a.path) === targetNorm) ?? undefined;
  }
  if (existingByPath) {
    await db
      .update(apps)
      .set({ lastOpenedAt: new Date(), updatedAt: new Date() })
      .where(eq(apps.id, existingByPath.id));
    const { sessionId, chatId } = await startWorkspaceSession(
      existingByPath.id,
    );
    return { appId: existingByPath.id, chatId, sessionId };
  }

  const existingByName = await db.query.apps.findFirst({
    where: eq(apps.name, appName),
  });
  if (existingByName) {
    throw new Error("An app with this name already exists");
  }

  // The plan cap applies to a genuinely NEW workspace, and only here.
  //
  // It used to run at the TOP of this function, BEFORE the two lookups above —
  // so a Free user sitting at their 1-workspace cap could not re-open the very
  // workspace they already had: the check threw before the dedupe could return
  // the existing row. Re-opening your own folder does not increase the count and
  // must never be refused by a limit it cannot exceed.

  const now = new Date();
  const [app] = await db
    .insert(apps)
    .values({
      name: appName,
      // A local folder as the OS names it, symlinks resolved (E13).
      path: remote ? sourcePath : realAppPath(sourcePath),
      installCommand: installCommand ?? null,
      startCommand: startCommand ?? null,
      workspaceKind,
      remoteConnection: remote
        ? JSON.stringify({
            hostAlias: remote.hostAlias,
            remotePath: remote.remotePath,
          })
        : null,
      lastOpenedAt: now,
    })
    .returning();

  // getWorkspaceCount() memoises and was only invalidated on DELETE, so without
  // this the next check reads a count one too low.
  noteWorkspaceCreated();

  const { sessionId, chatId } = await startWorkspaceSession(app.id);

  return { appId: app.id, chatId, sessionId };
}
