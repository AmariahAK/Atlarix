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

/**
 * Records which workspace owns a project directory, so ownership stops being an
 * inference. Written on adoption; checked before adopting anything.
 */
const WORKSPACE_STAMP_FILE = ".workspace";

/**
 * Reclaim notes an agent wrote to a GUESSED memory directory.
 *
 * The store is keyed by `workspaceSlug()`, which appends a hash. But until the fix in
 * `context-sections.ts`, the absolute path was published to the agent only once notes
 * already existed — so on a fresh workspace the agent had nothing to go on and wrote
 * to the obvious human-readable guess, `~/.atlarix/projects/<basename>/memory/`. Those
 * notes were then invisible to `readMemoryIndex`, which kept the real store empty,
 * which kept the path unpublished. This adopts them.
 *
 * Unlike `migrateLegacyMemoryMd`, which copies and leaves the original alone, this
 * MOVES: the source is Atlarix's own guessed directory, not a file in the user's repo,
 * and leaving a second store behind is what caused the confusion. Removing it also
 * closes the only cross-contamination risk — two workspaces can share a basename
 * (`/a/api`, `/b/api`), and once the directory is claimed there is nothing left for a
 * second one to adopt. The exposure reduces to "the first claimer might be the wrong
 * project", bounded by notes being advisory background, never authoritative.
 *
 * Deletion happens ONLY after the copy is read back and verified. Idempotent, and safe
 * to call on every turn.
 */
export async function adoptMisplacedMemoryDir(
  workspacePath: string,
): Promise<boolean> {
  try {
    const target = memoryDirFor(workspacePath);
    // Guard 1: never touch a store that already holds notes.
    if ((await listNoteFiles(target)).length > 0) return false;

    const candidateRoot = path.join(
      globalAtlarixRoot(),
      "projects",
      path.basename(path.resolve(workspacePath)),
    );
    const candidate = path.join(candidateRoot, "memory");
    // Guard 2: a workspace whose basename already yields the real slug has no
    // separate candidate — comparing resolved paths avoids adopting from itself.
    if (path.resolve(candidate) === path.resolve(target)) return false;

    // Guard 3: something to adopt.
    const notes = await listNoteFiles(candidate);
    if (notes.length === 0) return false;

    // Guard 4: don't steal a directory another workspace has already claimed.
    try {
      const stamp = (
        await fs.readFile(path.join(candidateRoot, WORKSPACE_STAMP_FILE), "utf8")
      ).trim();
      if (stamp && stamp !== path.resolve(workspacePath)) {
        logger.warn(
          `[agent-memory] not adopting ${candidate} — stamped for a different workspace (${stamp})`,
        );
        return false;
      }
    } catch {
      /* unstamped: legacy directory, fair to claim */
    }

    await fs.mkdir(target, { recursive: true });
    const copy = [...notes, MEMORY_INDEX_FILE];
    for (const name of copy) {
      try {
        await fs.copyFile(path.join(candidate, name), path.join(target, name));
      } catch {
        // MEMORY.md may legitimately be absent; a missing NOTE is a real failure and
        // is caught by the read-back below rather than trusted here.
      }
    }

    // VERIFY BEFORE DELETING. A partial copy that then removed the source would lose
    // notes with no original to recover from.
    const landed = await listNoteFiles(target);
    if (landed.length !== notes.length) {
      logger.warn(
        `[agent-memory] adoption incomplete (${landed.length}/${notes.length}) — leaving ${candidate} in place`,
      );
      return false;
    }

    await fs.writeFile(
      path.join(path.dirname(target), WORKSPACE_STAMP_FILE),
      `${path.resolve(workspacePath)}\n`,
      "utf8",
    );
    await fs.rm(candidateRoot, { recursive: true, force: true });
    logger.info(
      `[agent-memory] adopted ${notes.length} note(s): ${candidate} → ${target} (source removed)`,
    );
    return true;
  } catch (e) {
    // Memory is optional; never block a turn on it.
    logger.warn("[agent-memory] adoption failed (non-fatal):", e);
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

// ═══════════════════════════════════════════════════════════════════════════
// Compaction (NOT a cap)
// ═══════════════════════════════════════════════════════════════════════════
//
// Notes are written indefinitely and nothing ever pruned them. Cost to the PROMPT is
// bounded by design (only the one-line index is injected), so the failure mode isn't
// token spend — it is an index whose entries increasingly point at bloated, redundant
// notes that nobody rewrote.
//
// Memory is therefore treated exactly like context: it COMPACTS, it does not fill up.
// Nothing is ever refused and nothing is deleted to make room — past the threshold the
// harness tells the agent to rewrite specific notes more accurately, and keeps telling
// it until the store is smaller. A hard ceiling would fail the one write that mattered
// (often the one consolidating everything) and would make the agent's first signal a
// failure.
//
// PER PROJECT, deliberately: the threshold is computed from the note's own directory,
// and one busy project can't force compaction on the rest.
//
// Named notes, not a blanket sweep: the guidance points at the LARGEST notes, because
// those are where accuracy has actually decayed, and a whole-store pass is a decision
// for the user to ask for.

/** Size at which the agent is required to compact this project's memory. */
export const MEMORY_COMPACT_BYTES = 25 * 1024 * 1024;

/** Fraction of the threshold at which compaction is first raised. */
export const MEMORY_COMPACT_NUDGE_RATIO = 0.8;

/** How many of the largest notes the directive names. */
const MEMORY_COMPACT_TARGET_COUNT = 3;

export type MemoryNoteSize = { name: string; bytes: number };

/** Every note file in a project's memory directory, largest first (index included). */
export async function listMemoryNoteSizes(
  workspacePath: string,
): Promise<MemoryNoteSize[]> {
  const dir = memoryDirFor(workspacePath);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const sizes = await Promise.all(
      entries
        .filter((e) => e.isFile())
        .map(async (e) => {
          try {
            return { name: e.name, bytes: (await fs.stat(path.join(dir, e.name))).size };
          } catch {
            return { name: e.name, bytes: 0 }; // vanished mid-scan
          }
        }),
    );
    return sizes.sort((a, b) => b.bytes - a.bytes);
  } catch {
    return []; // no memory directory yet
  }
}

/** Total bytes of every note file in a project's memory directory (index included). */
export async function memoryDirBytes(workspacePath: string): Promise<number> {
  const notes = await listMemoryNoteSizes(workspacePath);
  return notes.reduce((sum, n) => sum + n.bytes, 0);
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type MemoryCompactionPlan = {
  /** Projected directory size, in bytes. */
  totalBytes: number;
  /** True once past the full threshold rather than the early nudge. */
  required: boolean;
  /** The notes to rewrite, largest first. */
  targets: MemoryNoteSize[];
  /**
   * The whole signal, as a FLAG — a handful of tokens naming the state and the notes.
   *
   * Deliberately not a lesson. This rides `loadMemoryMdSection`, which runs on every
   * turn, so a paragraph here is a paragraph on every request until the store shrinks:
   * the first version of this cost 147 tokens per turn (~7,350 over a 50-turn session),
   * which is precisely the payload-instead-of-index mistake v14.25.0 existed to undo.
   *
   * The HOW lives in `skills/guides/memory.md`, which the memory section already points
   * at. Atlarix's job is to tell the model the one thing it cannot derive — that this
   * store needs a pass, and which notes — not to re-teach the convention every turn.
   */
  flag: string;
};

/**
 * Decide whether this project's memory needs compacting, and name the notes to do it
 * on. Returns null when there is nothing to say.
 *
 * `notes` is the directory's current contents; `pendingWrite` (optional) is a note
 * about to be written, so the decision reflects the size the store is heading for
 * rather than the one it just left. A write that SHRINKS its note therefore counts as
 * progress immediately.
 *
 * Pure — the thresholds and the wording are testable without a filesystem.
 */
export function planMemoryCompaction(args: {
  notes: MemoryNoteSize[];
  pendingWrite?: { name: string; bytes: number };
}): MemoryCompactionPlan | null {
  const projected = new Map(args.notes.map((n) => [n.name, n.bytes]));
  if (args.pendingWrite) {
    projected.set(args.pendingWrite.name, args.pendingWrite.bytes);
  }
  const all = [...projected.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes);
  const totalBytes = all.reduce((sum, n) => sum + n.bytes, 0);

  if (totalBytes <= MEMORY_COMPACT_BYTES * MEMORY_COMPACT_NUDGE_RATIO) return null;

  const required = totalBytes > MEMORY_COMPACT_BYTES;
  // Only notes with real bulk are worth naming — compacting a 300-byte note is noise.
  const targets = all
    .filter((n) => n.name !== MEMORY_INDEX_FILE && n.bytes > 0)
    .slice(0, MEMORY_COMPACT_TARGET_COUNT);
  const named = targets.map((t) => t.name).join(", ");

  const flag = required
    ? `${mb(totalBytes)} — compact ${named} (see guides/memory)`
    : `${mb(totalBytes)} — compact ${named} when next open`;

  return { totalBytes, required, targets, flag };
}

/** True when `absPath` is inside this workspace's memory directory. */
export function isAgentMemoryPath(workspacePath: string, absPath: string): boolean {
  const dir = path.resolve(memoryDirFor(workspacePath));
  const rel = path.relative(dir, path.resolve(absPath));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
