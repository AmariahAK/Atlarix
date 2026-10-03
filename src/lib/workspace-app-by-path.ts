/**
 * The `apps` row for a folder: the OLDEST row whose path normalises to it (the
 * one the desktop treats as canonical, see canonical-app.ts), inserted only
 * when there is none. Every surface that opens a folder by path (the CLI, the
 * `atlarix run` batch runner) goes through here, so the same folder is the
 * same workspace everywhere and runs do not pile up duplicate rows.
 */
import path from "node:path";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { normalizeAppPath } from "@/lib/canonical-app-path";

export async function workspaceAppIdForPath(dir: string): Promise<number> {
  const want = normalizeAppPath(dir);
  const rows = db
    .select({ id: apps.id, path: apps.path })
    .from(apps)
    .all()
    .sort((a, b) => a.id - b.id);
  const hit = rows.find((r) => normalizeAppPath(r.path) === want);
  if (hit) return hit.id;
  const [row] = db
    .insert(apps)
    .values({ name: path.basename(dir) || dir, path: dir })
    .returning({ id: apps.id })
    .all();
  return row!.id;
}
