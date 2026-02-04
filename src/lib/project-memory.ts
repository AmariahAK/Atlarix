/**
 * Project-level MEMORY.md (Claude Code / OpenCode style)
 * =======================================================
 * File-based cross-session memory at <workspace>/.atlarix/MEMORY.md.
 * Written when compaction runs; read and injected into system prompt for workspace chats.
 */

import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";

const logger = log.scope("project-memory");

const MEMORY_DIR = ".atlarix";
const MEMORY_FILE = "MEMORY.md";

/** Max chars to inject into system prompt (avoid context bloat) */
const MAX_INJECT_CHARS = 3000;

/**
 * Path to MEMORY.md for a workspace root
 */
export function getMemoryPath(workspacePath: string): string {
  return path.join(workspacePath, MEMORY_DIR, MEMORY_FILE);
}

/**
 * Read MEMORY.md if it exists. Returns null if missing or on error.
 * Truncates to MAX_INJECT_CHARS for safe injection.
 */
export async function readMemoryMd(workspacePath: string): Promise<string | null> {
  if (!workspacePath) return null;
  const filePath = getMemoryPath(workspacePath);
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
    logger.warn("Failed to read MEMORY.md:", err?.message ?? err);
    return null;
  }
}

/**
 * Write MEMORY.md with the given summary. Creates .atlarix dir if needed.
 * Overwrites the file (single rolling summary per project).
 */
export async function writeMemoryMd(workspacePath: string, summaryText: string): Promise<void> {
  if (!workspacePath || !summaryText?.trim()) return;
  const dirPath = path.join(workspacePath, MEMORY_DIR);
  const filePath = getMemoryPath(workspacePath);
  try {
    await fs.mkdir(dirPath, { recursive: true });
    const header = `# Project memory (cross-session)\n\nLast updated: ${new Date().toISOString()}\n\n`;
    await fs.writeFile(filePath, header + summaryText.trim(), "utf8");
    logger.info(`Wrote MEMORY.md for ${workspacePath}`);
  } catch (err: any) {
    logger.warn("Failed to write MEMORY.md:", err?.message ?? err);
  }
}
