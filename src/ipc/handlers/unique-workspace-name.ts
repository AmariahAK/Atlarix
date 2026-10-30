import path from "node:path";

/**
 * A name for a new workspace that no existing workspace has.
 *
 * Opening a folder whose basename another workspace already uses ("ws", when
 * Recents holds several folders called ws) used to fail with "An app with this
 * name already exists", and the app sat on the home screen with nothing to say
 * (QA 2026-10-30). Two folders may share a basename; their workspaces must not
 * share a name. The parent folder tells them apart ("ws (atlarix)"); when even
 * that is taken, a counter does ("ws (2)").
 */
export function uniqueWorkspaceName(folderPath: string, taken: ReadonlySet<string>): string {
  const base = path.basename(folderPath) || "Workspace";
  if (!taken.has(base)) return base;
  const parent = path.basename(path.dirname(folderPath));
  if (parent && parent !== base) {
    const withParent = `${base} (${parent})`;
    if (!taken.has(withParent)) return withParent;
  }
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
}
