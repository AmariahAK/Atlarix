/**
 * Shared workspace import logic for IPC and CLI open-folder.
 */

import fs from "fs/promises";
import { apps } from "@/db/schema";
import { db } from "@/db";
import { eq } from "drizzle-orm";
import { parseRemoteUri } from "@/lib/workspace-fs";
import { PlanLimitError } from "@/lib/plan-limit-error";
import { startWorkspaceSession } from "./workspace_session_handlers";
import { normalizeAppPath } from "@/lib/canonical-app-path";

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

  const { SubscriptionManager } = await import("../../lib/SubscriptionManager");
  const limitCheck = await SubscriptionManager.canCreateWorkspace();
  if (!limitCheck.allowed) {
    throw new PlanLimitError(
      limitCheck.reason || "Workspace limit reached. Upgrade to Pro for unlimited workspaces.",
    );
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
    const { sessionId, chatId } = await startWorkspaceSession(existingByPath.id);
    return { appId: existingByPath.id, chatId, sessionId };
  }

  const existingByName = await db.query.apps.findFirst({
    where: eq(apps.name, appName),
  });
  if (existingByName) {
    throw new Error("An app with this name already exists");
  }

  const now = new Date();
  const [app] = await db
    .insert(apps)
    .values({
      name: appName,
      path: sourcePath,
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

  const { sessionId, chatId } = await startWorkspaceSession(app.id);

  return { appId: app.id, chatId, sessionId };
}
