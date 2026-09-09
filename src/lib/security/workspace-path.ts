import * as path from "node:path";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { PATH_ESCAPE_BLOCK_MESSAGE } from "@/lib/security/env-secret-paths";

/**
 * Ensure a file path is under a registered workspace root (apps.path).
 */
export async function assertFileUnderRegisteredWorkspace(
  filePath: string,
): Promise<void> {
  const resolved = path.resolve(filePath);
  const rows = await db.select({ path: apps.path }).from(apps);
  const allowed = rows.some((row) => {
    if (!row.path) return false;
    const root = path.resolve(row.path);
    return resolved === root || resolved.startsWith(root + path.sep);
  });
  if (!allowed) {
    throw new Error(PATH_ESCAPE_BLOCK_MESSAGE);
  }
}
