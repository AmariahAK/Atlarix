/**
 * Project-level .atlarix/ memory and spec (Claude Code style)
 * ===========================================================
 * - .atlarix/memory.md: User-created or auto-written on compaction; guides AI on how to code.
 * - .atlarix/spec.md: Model-created task breakdown.
 * Both are read and injected into system prompt for workspace chats.
 */

import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";

const logger = log.scope("project-memory");

const ATLARIX_DIR = ".atlarix";
const MEMORY_FILE = "memory.md";
const SPEC_FILE = "spec.md";

/** Max chars to inject into system prompt (avoid context bloat) */
const MAX_INJECT_CHARS = 3000;

/**
 * Path to .atlarix/memory.md for a workspace
 */
export function getMemoryPath(workspacePath: string): string {
  return path.join(workspacePath, ATLARIX_DIR, MEMORY_FILE);
}

/**
 * Path to .atlarix/spec.md for a workspace
 */
export function getSpecPath(workspacePath: string): string {
  return path.join(workspacePath, ATLARIX_DIR, SPEC_FILE);
}

/**
 * Ensure .atlarix directory exists
 */
async function ensureAtlarixDir(workspacePath: string): Promise<void> {
  const dir = path.join(workspacePath, ATLARIX_DIR);
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Read .atlarix/memory.md if it exists.
 * Fallback: root-level MEMORY.md (legacy).
 * Returns null if missing or on error.
 */
export async function readMemoryMd(workspacePath: string): Promise<string | null> {
  if (!workspacePath) return null;
  const primaryPath = getMemoryPath(workspacePath);
  const legacyPath = path.join(workspacePath, "MEMORY.md");
  for (const filePath of [primaryPath, legacyPath]) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const trimmed = content.trim();
      if (!trimmed) continue;
      if (trimmed.length > MAX_INJECT_CHARS) {
        return trimmed.slice(0, MAX_INJECT_CHARS) + "\n\n...(truncated)";
      }
      return trimmed;
    } catch (err: any) {
      if (err?.code === "ENOENT") continue;
      logger.warn(`Failed to read ${path.basename(filePath)}:`, err?.message ?? err);
      return null;
    }
  }
  return null;
}

/**
 * Read .atlarix/spec.md if it exists (task breakdown, model-created).
 * Returns null if missing or on error.
 */
export async function readSpecMd(workspacePath: string): Promise<string | null> {
  if (!workspacePath) return null;
  const filePath = getSpecPath(workspacePath);
  try {
    const content = await fs.readFile(filePath, "utf8");
    const trimmed = content.trim();
    if (!trimmed) return null;
    if (trimmed.length > MAX_INJECT_CHARS) {
      return trimmed.slice(0, MAX_INJECT_CHARS) + "\n\n...(truncated)";
    }
    return trimmed;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    logger.warn("Failed to read spec.md:", err?.message ?? err);
    return null;
  }
}

/**
 * Write .atlarix/memory.md with the given summary.
 * Creates .atlarix dir if needed.
 */
export async function writeMemoryMd(workspacePath: string, summaryText: string): Promise<void> {
  if (!workspacePath || !summaryText?.trim()) return;
  try {
    await ensureAtlarixDir(workspacePath);
    const filePath = getMemoryPath(workspacePath);
    const header = `# Project memory (cross-session)\n\nLast updated: ${new Date().toISOString()}\n\n`;
    await fs.writeFile(filePath, header + summaryText.trim(), "utf8");
    logger.info(`Wrote .atlarix/memory.md for ${workspacePath}`);
  } catch (err: any) {
    logger.warn("Failed to write memory.md:", err?.message ?? err);
  }
}
