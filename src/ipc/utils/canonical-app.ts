/**
 * Bug 5 defense-in-depth: resolve any appId to the CANONICAL (oldest) apps row
 * that shares its normalized path. The startup merge routine
 * (`mergeDuplicateAppsByPathIfNeeded`) collapses duplicate rows, and import
 * dedup prevents new ones — but routing permission WRITES through this keeps the
 * write side aligned with the runtime read side (the chat's bound app row) even
 * for a duplicate created mid-session before the next merge.
 */
import { getDb } from "@/db";
import { normalizeAppPath } from "@/lib/canonical-app-path";

export function resolveCanonicalAppId(
  appId: number | null | undefined,
): number | null | undefined {
  if (appId == null) return appId;
  try {
    const client = getDb().$client;
    const row = client.prepare("SELECT path FROM apps WHERE id = ?").get(appId) as
      | { path?: string }
      | undefined;
    if (!row?.path) return appId;
    const norm = normalizeAppPath(row.path);
    const all = client
      .prepare("SELECT id, path FROM apps ORDER BY id ASC")
      .all() as Array<{ id: number; path: string }>;
    const match = all.find((a) => normalizeAppPath(a.path) === norm);
    const canonical = match?.id ?? appId;
    if (process.env.ATLARIX_DIAG_146 === "1" && canonical !== appId) {
      // eslint-disable-next-line no-console
      console.info(
        `[DIAG_146] canonical-app divergence: appId=${appId} → canonical=${canonical} (path=${row.path})`,
      );
    }
    return canonical;
  } catch {
    return appId;
  }
}
