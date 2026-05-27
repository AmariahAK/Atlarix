/**
 * Shared workspace import logic for IPC and CLI open-folder.
 */

import fs from "fs/promises";
import { apps, chats } from "@/db/schema";
import { db } from "@/db";
import { eq } from "drizzle-orm";

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
}): Promise<{ appId: number; chatId: number }> {
  await fs.access(sourcePath);

  const { SubscriptionManager } = await import("../../lib/SubscriptionManager");
  const limitCheck = await SubscriptionManager.canCreateWorkspace();
  if (!limitCheck.allowed) {
    throw new Error(
      limitCheck.reason || "Workspace limit reached. Upgrade to Pro for unlimited workspaces.",
    );
  }

  const existingByPath = await db.query.apps.findFirst({
    where: eq(apps.path, sourcePath),
  });
  if (existingByPath) {
    const existingChat = await db.query.chats.findFirst({
      where: eq(chats.appId, existingByPath.id),
    });
    if (existingChat) {
      return { appId: existingByPath.id, chatId: existingChat.id };
    }
    const [newChat] = await db.insert(chats).values({ appId: existingByPath.id }).returning();
    return { appId: existingByPath.id, chatId: newChat.id };
  }

  const existingByName = await db.query.apps.findFirst({
    where: eq(apps.name, appName),
  });
  if (existingByName) {
    throw new Error("An app with this name already exists");
  }

  const [app] = await db
    .insert(apps)
    .values({
      name: appName,
      path: sourcePath,
      installCommand: installCommand ?? null,
      startCommand: startCommand ?? null,
    })
    .returning();

  const [chat] = await db.insert(chats).values({ appId: app.id }).returning();

  try {
    const { captureInitialSnapshot } = await import("../../lib/diagram-timeline/capture");
    await captureInitialSnapshot(app.id);
  } catch {
    /* non-fatal */
  }

  return { appId: app.id, chatId: chat.id };
}
