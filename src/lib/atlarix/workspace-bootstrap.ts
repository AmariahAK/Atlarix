/**
 * One-time workspace folder setup when a workspace is opened or imported.
 */

import * as fs from "fs/promises";
import * as path from "path";
import log from "electron-log";
import { migrateLegacyAtlarixFiles } from "@/lib/project-memory";

const logger = log.scope("workspace-bootstrap");

const LEGACY_PLAN_REL = path.join(".atlarix", "ATLARIX_PLAN.md");
const ARCHIVE_DIR_REL = path.join(".atlarix", "plans", "archive");

/**
 * Migrate atlarix.md and archive legacy ATLARIX_PLAN.md (reference only). No
 * `.atlarixignore` scaffold — grep/glob run on ripgrep, which honors the user's
 * own .gitignore/.ignore/.atlarixignore if present (see ripgrep-ignore.ts).
 */
export async function bootstrapAtlarixWorkspaceFolder(workspacePath: string): Promise<void> {
  if (!workspacePath?.trim()) return;
  try {
    await migrateLegacyAtlarixFiles(workspacePath);
    await archiveLegacyPlanFileIfPresent(workspacePath);
  } catch (err) {
    logger.warn("workspace bootstrap failed:", err);
  }
}

async function archiveLegacyPlanFileIfPresent(workspacePath: string): Promise<void> {
  const planPath = path.join(workspacePath, LEGACY_PLAN_REL);
  try {
    const body = await fs.readFile(planPath, "utf8");
    if (!body.trim()) return;
    const archiveDir = path.join(workspacePath, ARCHIVE_DIR_REL);
    await fs.mkdir(archiveDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(archiveDir, `ATLARIX_PLAN-${stamp}.md`);
    await fs.writeFile(dest, body, "utf8");
    await fs.rename(planPath, `${planPath}.old`);
    logger.info(`Archived legacy ATLARIX_PLAN.md to ${dest}`);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      logger.debug("legacy plan archive skipped:", err);
    }
  }
}
