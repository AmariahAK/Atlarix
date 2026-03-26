/**
 * Project-level .atlarix/ instruction memory
 * ==========================================
 * Canonical file: .atlarix/ATLARIX.md
 * Legacy files: .atlarix/memory.md and .atlarix/spec.md are auto-migrated.
 */

import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";

const logger = log.scope("project-memory");

const ATLARIX_DIR = ".atlarix";
const ATLARIX_MD_FILE = "ATLARIX.md";
const LEGACY_MEMORY_FILE = "memory.md";
const LEGACY_SPEC_FILE = "spec.md";

/** Max chars to inject into system prompt (avoid context bloat) */
const MAX_INJECT_CHARS = 3000;

export function getAtlarixMdPath(workspacePath: string): string {
  return path.join(workspacePath, ATLARIX_DIR, ATLARIX_MD_FILE);
}

/**
 * Ensure .atlarix directory exists
 */
async function ensureAtlarixDir(workspacePath: string): Promise<void> {
  const dir = path.join(workspacePath, ATLARIX_DIR);
  await fs.mkdir(dir, { recursive: true });
}

function normalizeForCompare(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

async function safeRead(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const trimmed = content.trim();
    if (!trimmed) return null;
    return trimmed;
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      logger.warn(`Failed to read ${path.basename(filePath)}:`, err?.message ?? err);
    }
    return null;
  }
}

async function safeRenameToOld(filePath: string): Promise<void> {
  try {
    const oldPath = `${filePath}.old`;
    await fs.rename(filePath, oldPath);
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      logger.warn(`Failed to archive ${path.basename(filePath)}:`, err?.message ?? err);
    }
  }
}

export async function migrateLegacyAtlarixFiles(workspacePath: string): Promise<void> {
  if (!workspacePath) return;
  await ensureAtlarixDir(workspacePath);

  const atlarixMdPath = getAtlarixMdPath(workspacePath);
  const legacyMemoryPath = path.join(workspacePath, ATLARIX_DIR, LEGACY_MEMORY_FILE);
  const legacySpecPath = path.join(workspacePath, ATLARIX_DIR, LEGACY_SPEC_FILE);
  const rootLegacyMemoryPath = path.join(workspacePath, "MEMORY.md");

  const [existingAtlarixMd, memoryMd, specMd, rootMemoryMd] = await Promise.all([
    safeRead(atlarixMdPath),
    safeRead(legacyMemoryPath),
    safeRead(legacySpecPath),
    safeRead(rootLegacyMemoryPath),
  ]);

  let finalContent = existingAtlarixMd?.trim() || "";
  if (!finalContent) {
    const memoryContent = memoryMd || rootMemoryMd;
    const specContent = specMd;

    if (memoryContent || specContent) {
      const parts: string[] = [];
      if (memoryContent) {
        parts.push(`# ATLARIX Project Memory\n\n${memoryContent.trim()}`);
      }
      if (
        specContent &&
        (!memoryContent || normalizeForCompare(specContent) !== normalizeForCompare(memoryContent))
      ) {
        parts.push(`## Legacy Spec Notes\n\n${specContent.trim()}`);
      }
      finalContent = parts.join("\n\n");
    }
  }

  if (finalContent) {
    await fs.writeFile(atlarixMdPath, finalContent.trim() + "\n", "utf8");
  }

  // Archive old files after successful migration/write.
  await Promise.all([
    safeRenameToOld(legacyMemoryPath),
    safeRenameToOld(legacySpecPath),
    safeRenameToOld(rootLegacyMemoryPath),
  ]);
}

export async function readAtlarixMd(workspacePath: string): Promise<string | null> {
  if (!workspacePath) return null;
  await migrateLegacyAtlarixFiles(workspacePath);
  const content = await safeRead(getAtlarixMdPath(workspacePath));
  if (!content) return null;
  if (content.length > MAX_INJECT_CHARS) {
    return content.slice(0, MAX_INJECT_CHARS) + "\n\n...(truncated)";
  }
  return content;
}

export async function writeAtlarixMd(workspacePath: string, summaryText: string): Promise<void> {
  if (!workspacePath || !summaryText?.trim()) return;
  try {
    await ensureAtlarixDir(workspacePath);
    await migrateLegacyAtlarixFiles(workspacePath);
    const filePath = getAtlarixMdPath(workspacePath);
    const existing = await safeRead(filePath);
    const header = existing?.startsWith("# ATLARIX Project Memory")
      ? ""
      : `# ATLARIX Project Memory\n\n`;
    const merged = `${header}Last updated: ${new Date().toISOString()}\n\n${summaryText.trim()}\n`;
    await fs.writeFile(filePath, merged, "utf8");
    logger.info(`Wrote .atlarix/ATLARIX.md for ${workspacePath}`);
  } catch (err: any) {
    logger.warn("Failed to write ATLARIX.md:", err?.message ?? err);
  }
}

// Backwards-compatible wrappers used by existing call-sites.
export async function readMemoryMd(workspacePath: string): Promise<string | null> {
  return readAtlarixMd(workspacePath);
}

export async function readSpecMd(_workspacePath: string): Promise<string | null> {
  return null;
}

export async function writeMemoryMd(workspacePath: string, summaryText: string): Promise<void> {
  return writeAtlarixMd(workspacePath, summaryText);
}
