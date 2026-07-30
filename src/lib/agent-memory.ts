/**
 * Agent memory — per-note, path-keyed, never injected wholesale.
 * ==============================================================
 *
 * WHY THIS REPLACES `.atlarix/memory.md`
 * --------------------------------------
 * The old design was a single file whose ENTIRE body was appended to the system
 * prompt on every request. Three things were wrong with that:
 *
 *  1. Cost scaled with what the agent had learned, so the more useful memory got, the
 *     more every unrelated turn paid for it. On Core (open-weight, no prompt caching)
 *     that is paid in full, every turn.
 *  2. It was capped at 3000 chars and silently truncated — so past that point the
 *     agent's own notes were dropped with no signal to anyone.
 *  3. One file per project meant one shared blob: no per-note update, no deletion of a
 *     note that turned out to be wrong, and a rewrite races itself across sessions.
 *
 * THE SHAPE
 * ---------
 *   ~/.atlarix/projects/<slug>/memory/
 *     MEMORY.md          index — ONE line per note: "- [Title](file.md) — hook"
 *     <note-name>.md     frontmatter (name, description, type) + body + [[links]]
 *
 * Only the INDEX is ever put in context. Cost then scales with the NUMBER of notes
 * (one line each), not their size, which is what makes it safe to keep writing notes
 * indefinitely. Bodies are read on demand with `read_file`, exactly like the agent
 * already reads source.
 *
 * WHY GLOBAL, NOT `.atlarix/memory/` IN THE REPO
 * ---------------------------------------------
 * `<slug>` is derived from the workspace's absolute path, so isolation between projects
 * is STRUCTURAL — a different workspace resolves to a different directory and there is
 * no filtering step to get wrong. Living outside the repo also makes it per-developer
 * and keeps agent-written notes out of everyone's diffs.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import log from "electron-log";

const logger = log.scope("agent-memory");

export const MEMORY_INDEX_FILE = "MEMORY.md";

/** Note kinds. Mirrors the taxonomy that makes recall decisions easy to reason about. */
export const MEMORY_TYPES = ["project", "feedback", "reference", "user"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * Test/override seam for the global root, mirroring `globalAtlarixDirOverride` in
 * `lib/tools/permissions/ruleset.ts`. Without this, every test would write into the
 * developer's real `~/.atlarix`.
 */
let globalRootOverride: string | null = null;

export function setAgentMemoryRootOverride(dir: string | null): void {
  globalRootOverride = dir;
}

function globalAtlarixRoot(): string {
  return globalRootOverride ?? path.join(os.homedir(), ".atlarix");
}

/**
 * Stable, collision-resistant directory name for a workspace path.
 *
 * Readability matters here — someone debugging should be able to tell which project a
 * directory belongs to — so the slug keeps the recognisable path text and appends a
 * short hash. The hash is what actually guarantees uniqueness: slugification alone
 * collapses `/a/b-c` and `/a/b/c` onto the same name, which would silently merge two
 * projects' memory.
 */
export function workspaceSlug(workspacePath: string): string {
  const normalized = path.resolve(workspacePath);
  const readable =
    normalized
      .replace(/[/\\:]+/g, "-")
      .replace(/[^a-zA-Z0-9._-]/g, "")
      .replace(/^-+|-+$/g, "")
      .slice(-60) || "workspace";
  // djb2 — deterministic across runs and processes (unlike anything seeded), and we
  // only need collision resistance, not cryptographic strength.
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) | 0;
  }
  return `${readable}-${(hash >>> 0).toString(36)}`;
}

export function memoryDirFor(workspacePath: string): string {
  return path.join(globalAtlarixRoot(), "projects", workspaceSlug(workspacePath), "memory");
}

export function memoryIndexPathFor(workspacePath: string): string {
  return path.join(memoryDirFor(workspacePath), MEMORY_INDEX_FILE);
}

export type MemoryIndexStat = {
  /** Number of note files (the index line count is advisory, the files are truth). */
  noteCount: number;
  /** The index body, verbatim — this is what goes in the prompt. */
  index: string;
  dir: string;
  indexPath: string;
};

/** Note files present on disk, excluding the index itself. */
async function listNoteFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter(
        (e) => e.isFile() && e.name.endsWith(".md") && e.name !== MEMORY_INDEX_FILE,
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The index + note count for a workspace, or null when there is no memory yet.
 *
 * Returns null rather than an empty shell so callers can omit the prompt section
 * entirely — a "you have 0 notes" line is pure cost.
 */
export async function readMemoryIndex(
  workspacePath: string,
): Promise<MemoryIndexStat | null> {
  const dir = memoryDirFor(workspacePath);
  const indexPath = path.join(dir, MEMORY_INDEX_FILE);
  const notes = await listNoteFiles(dir);
  let index = "";
  try {
    index = (await fs.readFile(indexPath, "utf8")).trim();
  } catch {
    index = "";
  }
  // Notes with no index yet still count: the agent can list the directory. An index
  // with no notes is a leftover and shouldn't advertise anything.
  if (notes.length === 0) return null;
  return { noteCount: notes.length, index, dir, indexPath };
}

/**
 * One-way migration of a pre-v14.23.0 `.atlarix/memory.md` into the new store.
 *
 * The original is deliberately LEFT IN PLACE. It's the user's file in the user's repo;
 * copying is recoverable, deleting is not. Idempotent — the presence of the migrated
 * note is the marker, so this is safe to call on every read.
 */
export async function migrateLegacyMemoryMd(
  workspacePath: string,
  legacyBody: string,
): Promise<boolean> {
  const body = legacyBody.trim();
  if (!body) return false;
  const dir = memoryDirFor(workspacePath);
  const target = path.join(dir, "project-notes.md");
  try {
    await fs.access(target);
    return false; // already migrated
  } catch {
    /* not migrated yet */
  }
  try {
    await fs.mkdir(dir, { recursive: true });
    const note = [
      "---",
      "name: project-notes",
      "description: Project stack, architecture and layout (migrated from .atlarix/memory.md)",
      "metadata:",
      "  type: project",
      "---",
      "",
      body,
      "",
    ].join("\n");
    await fs.writeFile(target, note, "utf8");
    await appendIndexLine(
      workspacePath,
      "- [Project notes](project-notes.md) — stack, architecture and layout (migrated)",
    );
    logger.info(`[agent-memory] migrated .atlarix/memory.md → ${target}`);
    return true;
  } catch (e) {
    logger.warn("[agent-memory] legacy migration failed (non-fatal):", e);
    return false;
  }
}

/** Append one line to the index, creating it if absent. No-op when already present. */
export async function appendIndexLine(
  workspacePath: string,
  line: string,
): Promise<void> {
  const dir = memoryDirFor(workspacePath);
  const indexPath = path.join(dir, MEMORY_INDEX_FILE);
  const entry = line.trim();
  if (!entry) return;
  await fs.mkdir(dir, { recursive: true });
  let current = "";
  try {
    current = await fs.readFile(indexPath, "utf8");
  } catch {
    current = `# Memory Index\n\n`;
  }
  if (current.includes(entry)) return;
  const next = `${current.replace(/\s*$/, "")}\n${entry}\n`;
  await fs.writeFile(indexPath, next, "utf8");
}

/** True when memory is switched off for this process (benchmarks, headless runs). */
export function isAgentMemoryDisabled(): boolean {
  const v = (process.env.ATLARIX_MEMORY ?? "").trim().toLowerCase();
  return v === "off" || v === "0" || v === "false";
}
