/**
 * Project memory — `.atlarix/atlarix.md`
 * ==========================================
 * Canonical: {workspace}/.atlarix/atlarix.md
 * Legacy: root atlarix.md, .atlarix/ATLARIX.md, memory.md, spec.md
 */

import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";

const logger = log.scope("project-memory");

export const ATLARIX_DIR = ".atlarix";
const CANONICAL_MD = "atlarix.md";
const LEGACY_DOT_ATLARIX_MD = "ATLARIX.md";
const LEGACY_MEMORY_FILE = "memory.md";
const LEGACY_SPEC_FILE = "spec.md";
const ROOT_LEGACY_ATLARIX_MD = "atlarix.md";

/** Max chars to inject into system prompt (avoid context bloat) */
const MAX_INJECT_CHARS = 3000;

export function getAtlarixDirPath(workspacePath: string): string {
  return path.join(workspacePath, ATLARIX_DIR);
}

export function getAtlarixMdPath(workspacePath: string): string {
  return path.join(workspacePath, ATLARIX_DIR, CANONICAL_MD);
}

function legacyDotAtlarixMdPath(workspacePath: string): string {
  return path.join(workspacePath, ATLARIX_DIR, LEGACY_DOT_ATLARIX_MD);
}

function rootLegacyAtlarixMdPath(workspacePath: string): string {
  return path.join(workspacePath, ROOT_LEGACY_ATLARIX_MD);
}

async function ensureAtlarixDir(workspacePath: string): Promise<void> {
  await fs.mkdir(getAtlarixDirPath(workspacePath), { recursive: true });
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
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      logger.warn(`Failed to read ${path.basename(filePath)}:`, err);
    }
    return null;
  }
}

async function safeRenameToOld(filePath: string): Promise<void> {
  try {
    await fs.rename(filePath, `${filePath}.old`);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      logger.warn(`Failed to archive ${path.basename(filePath)}:`, err);
    }
  }
}

export async function migrateLegacyAtlarixFiles(workspacePath: string): Promise<void> {
  if (!workspacePath) return;
  await ensureAtlarixDir(workspacePath);

  const canonicalPath = getAtlarixMdPath(workspacePath);
  const legacyDotPath = legacyDotAtlarixMdPath(workspacePath);
  const rootAtlarixPath = rootLegacyAtlarixMdPath(workspacePath);
  const legacyMemoryPath = path.join(workspacePath, ATLARIX_DIR, LEGACY_MEMORY_FILE);
  const legacySpecPath = path.join(workspacePath, ATLARIX_DIR, LEGACY_SPEC_FILE);
  const rootMemoryPath = path.join(workspacePath, "MEMORY.md");

  const [canonical, legacyDot, rootAtlarix, memoryMd, specMd, rootMemoryMd] = await Promise.all([
    safeRead(canonicalPath),
    safeRead(legacyDotPath),
    safeRead(rootAtlarixPath),
    safeRead(legacyMemoryPath),
    safeRead(legacySpecPath),
    safeRead(rootMemoryPath),
  ]);

  let finalContent =
    canonical?.trim() || legacyDot?.trim() || rootAtlarix?.trim() || "";
  if (!finalContent) {
    const memoryContent = memoryMd || rootMemoryMd;
    const specContent = specMd;
    if (memoryContent || specContent) {
      const parts: string[] = [];
      if (memoryContent) {
        parts.push(`# Project memory\n\n${memoryContent.trim()}`);
      }
      if (
        specContent &&
        (!memoryContent || normalizeForCompare(specContent) !== normalizeForCompare(memoryContent))
      ) {
        parts.push(`## Legacy spec notes\n\n${specContent.trim()}`);
      }
      finalContent = parts.join("\n\n");
    }
  }

  if (finalContent && !canonical) {
    await fs.writeFile(canonicalPath, finalContent.trim() + "\n", "utf8");
    if (legacyDot) await safeRenameToOld(legacyDotPath);
    if (rootAtlarix) await safeRenameToOld(rootAtlarixPath);
  }

  await Promise.all([
    safeRenameToOld(legacyMemoryPath),
    safeRenameToOld(legacySpecPath),
    safeRenameToOld(rootMemoryPath),
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
    await migrateLegacyAtlarixFiles(workspacePath);
    const filePath = getAtlarixMdPath(workspacePath);
    const existing = await safeRead(filePath);
    const header = existing?.startsWith("#") ? "" : `# Project memory\n\n`;
    const merged = `${header}Last updated: ${new Date().toISOString()}\n\n${summaryText.trim()}\n`;
    await fs.writeFile(filePath, merged, "utf8");
    logger.info(`Wrote .atlarix/atlarix.md for ${workspacePath}`);
  } catch (err: unknown) {
    logger.warn("Failed to write .atlarix/atlarix.md:", err);
  }
}

export async function readMemoryMd(workspacePath: string): Promise<string | null> {
  return readAtlarixMd(workspacePath);
}

export async function readSpecMd(_workspacePath: string): Promise<string | null> {
  return null;
}

export async function writeMemoryMd(workspacePath: string, summaryText: string): Promise<void> {
  return writeAtlarixMd(workspacePath, summaryText);
}

/** Workspace-relative path for plan-mode write checks. */
export function isWorkspaceAtlarixMdPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return (
    norm === `${ATLARIX_DIR}/${CANONICAL_MD}` ||
    norm === CANONICAL_MD ||
    norm === `${ATLARIX_DIR}/${LEGACY_DOT_ATLARIX_MD}` ||
    norm === LEGACY_DOT_ATLARIX_MD
  );
}
