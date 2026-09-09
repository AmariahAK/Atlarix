/**
 * Project memory — `.atlarix/atlarix.md` + `.atlarix/memory.md`
 * =============================================================
 * Instructions (canonical): {workspace}/.atlarix/atlarix.md — followed when
 * non-empty, ignored when absent/empty.
 * Knowledge file: {workspace}/.atlarix/memory.md — agent-maintained project
 * facts (stack, architecture, layout). Never auto-injected; the prompt only
 * carries a one-line hint that it exists so the model can read it on demand.
 * Legacy: root atlarix.md, .atlarix/ATLARIX.md, spec.md
 */

import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";

const logger = log.scope("project-memory");

export const ATLARIX_DIR = ".atlarix";
const CANONICAL_MD = "atlarix.md";
export const MEMORY_MD = "memory.md";
const LEGACY_DOT_ATLARIX_MD = "ATLARIX.md";
const LEGACY_SPEC_FILE = "spec.md";
const ROOT_LEGACY_ATLARIX_MD = "atlarix.md";

export function getAtlarixDirPath(workspacePath: string): string {
  return path.join(workspacePath, ATLARIX_DIR);
}

export function getAtlarixMdPath(workspacePath: string): string {
  return path.join(workspacePath, ATLARIX_DIR, CANONICAL_MD);
}

export function getMemoryMdPath(workspacePath: string): string {
  return path.join(workspacePath, ATLARIX_DIR, MEMORY_MD);
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

export async function migrateLegacyAtlarixFiles(
  workspacePath: string,
): Promise<void> {
  if (!workspacePath) return;
  await ensureAtlarixDir(workspacePath);

  const canonicalPath = getAtlarixMdPath(workspacePath);
  const legacyDotPath = legacyDotAtlarixMdPath(workspacePath);
  const rootAtlarixPath = rootLegacyAtlarixMdPath(workspacePath);
  const legacySpecPath = path.join(
    workspacePath,
    ATLARIX_DIR,
    LEGACY_SPEC_FILE,
  );
  // NOTE: `.atlarix/memory.md` is a live, first-class knowledge file (v10) —
  // it is intentionally NOT part of this legacy migration.

  const [canonical, legacyDot, rootAtlarix, specMd] = await Promise.all([
    safeRead(canonicalPath),
    safeRead(legacyDotPath),
    safeRead(rootAtlarixPath),
    safeRead(legacySpecPath),
  ]);

  let finalContent =
    canonical?.trim() || legacyDot?.trim() || rootAtlarix?.trim() || "";
  if (!finalContent && specMd) {
    finalContent = `## Legacy spec notes\n\n${specMd.trim()}`;
  }

  if (finalContent && !canonical) {
    await fs.writeFile(canonicalPath, finalContent.trim() + "\n", "utf8");
    if (legacyDot) await safeRenameToOld(legacyDotPath);
    if (rootAtlarix) await safeRenameToOld(rootAtlarixPath);
  }

  await safeRenameToOld(legacySpecPath);
}

/**
 * `capInject` is GONE (v14.23.0).
 *
 * It clamped both files to 3000 chars and appended "...(truncated)". Nothing about
 * that was visible to the user, so a project-instructions file longer than the cap had
 * its tail silently dropped and the rules in it simply never applied. Instructions are
 * now POINTED AT rather than pasted, and the agent reads the whole file with
 * `read_file` — which is strictly more correct than a truncated copy, as well as
 * cheaper on every turn that doesn't need it.
 *
 * These readers now return the file verbatim. The only caller that puts content in the
 * prompt is the pointer builder, which uses headings and a byte count, not the body.
 */
export async function readAtlarixMd(
  workspacePath: string,
): Promise<string | null> {
  if (!workspacePath) return null;
  await migrateLegacyAtlarixFiles(workspacePath);
  return (await safeRead(getAtlarixMdPath(workspacePath))) || null;
}

/** Legacy single-file memory. Read only to MIGRATE it into the per-note store. */
export async function readMemoryMd(
  workspacePath: string,
): Promise<string | null> {
  if (!workspacePath) return null;
  return (await safeRead(getMemoryMdPath(workspacePath))) || null;
}

/**
 * The markdown headings of a project-instructions file, for the pointer.
 *
 * A bare "instructions exist, go read them" is a coin flip on a weak model. Listing
 * the headings costs ~100–200 chars and tells the model WHAT the rules cover, so it
 * can decide whether they bear on the current task instead of guessing. Capped so a
 * file with a hundred headings can't reintroduce the problem this replaced.
 */
export function extractHeadings(content: string, max = 12): string[] {
  const out: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^#{1,3}\s+(.+?)\s*$/);
    const heading = m?.[1]?.replace(/[*_`]/g, "").trim();
    if (heading) out.push(heading);
    if (out.length >= max) break;
  }
  return out;
}

/** Where the project instructions came from (drives the injected heading). */
export type ProjectInstructionsSource =
  | "rules"
  | "atlarix"
  | "agents"
  | "claude";

/** `.atlarix/rules/` — the canonical home for project instructions since v14.45. */
export function getRulesDirPath(workspacePath: string): string {
  return path.join(workspacePath, ".atlarix", "rules");
}

/**
 * Every `.md` in `.atlarix/rules/`, concatenated in filename order.
 *
 * Rules are plural — a project accumulates them per concern (testing, style, the way
 * migrations are written), and one file made people either maintain a monolith or keep
 * the rest out of the agent's reach.
 *
 * DELIBERATELY NOT RECURSIVE, and no per-file applicability. Every file here applies,
 * always; a directory whose files each declared when they applied would be a different
 * and much larger feature, and this one is worth having first. Subdirectories are
 * skipped rather than walked so nesting cannot quietly change what is in scope.
 *
 * Sorted by codepoint, not `localeCompare`: this decides the ORDER instructions reach
 * the model, and a locale-sensitive sort would order differently on different machines
 * for the same repo.
 *
 * Creates nothing. `readAtlarixMd` below mkdirs `.atlarix/` as a migration side effect;
 * this must not add a second one, or every workspace that merely gets READ ends up with
 * a rules directory it never asked for.
 */
export async function readRulesDir(
  workspacePath: string,
): Promise<{ content: string; fileCount: number } | null> {
  if (!workspacePath) return null;
  const dir = getRulesDirPath(workspacePath);

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null; // No `.atlarix/rules/` — the common case, not an error.
  }

  const names = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => e.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const parts: string[] = [];
  for (const name of names) {
    // Per-file isolation: one unreadable rule must not silently discard the others.
    const body = await safeRead(path.join(dir, name));
    if (body) parts.push(body);
  }
  if (!parts.length) return null;

  return { content: parts.join("\n\n"), fileCount: parts.length };
}

/**
 * v13.1: project-instruction interop, widened in v14.45.
 *
 * Prefer `.atlarix/rules/` (canonical), then `.atlarix/atlarix.md` — which STAYS, and
 * is not a deprecation to be tidied away later: every existing user has one, and
 * dropping the rung would silently delete their instructions rather than fail visibly.
 * Then a repo's `AGENTS.md` (the cross-agent standard) and `CLAUDE.md`, so Atlarix is
 * drop-in friendly on repos configured for other agents.
 *
 * First non-empty wins, and it is read-only — a fallback is never copied into
 * `.atlarix/`.
 */
export async function readProjectInstructions(workspacePath: string): Promise<{
  content: string;
  source: ProjectInstructionsSource;
  /** Only set for `rules`, whose pointer names a directory and its size. */
  fileCount?: number;
} | null> {
  if (!workspacePath) return null;

  const rules = await readRulesDir(workspacePath);
  if (rules) {
    return {
      content: rules.content,
      source: "rules",
      fileCount: rules.fileCount,
    };
  }

  const atlarix = await readAtlarixMd(workspacePath);
  if (atlarix) return { content: atlarix, source: "atlarix" };

  const agents = await safeRead(path.join(workspacePath, "AGENTS.md"));
  if (agents) return { content: agents, source: "agents" };

  const claude = await safeRead(path.join(workspacePath, "CLAUDE.md"));
  if (claude) return { content: claude, source: "claude" };

  return null;
}

export type MemoryMdStat = {
  exists: boolean;
  sizeKb: number;
  /** ISO date (YYYY-MM-DD) of last modification. */
  modified: string;
};

/** Lightweight stat for the prompt hint — never reads the file body. */
export async function statMemoryMd(
  workspacePath: string,
): Promise<MemoryMdStat | null> {
  if (!workspacePath) return null;
  try {
    const st = await fs.stat(getMemoryMdPath(workspacePath));
    if (!st.isFile() || st.size === 0) return null;
    return {
      exists: true,
      sizeKb: Math.max(1, Math.round(st.size / 1024)),
      modified: st.mtime.toISOString().slice(0, 10),
    };
  } catch {
    return null;
  }
}

/**
 * Project-docs hint for the system prompt: the atlarix.md follow-when-non-empty rule.
 *
 * The `.atlarix/memory.md` paragraph is GONE (v14.23.0). That file is superseded by the
 * per-note store in `lib/agent-memory.ts`, whose index is surfaced by
 * `loadMemoryMdSection` — describing a knowledge file that no longer exists would send
 * the model reading (or worse, WRITING) the wrong path.
 *
 * This stays deliberately short and stays here rather than moving into the context
 * section: it applies even with no workspace-side section loaded, and it is the one place
 * that states the rule's CONDITION (non-empty ⇒ applies).
 */
export async function buildProjectDocsPromptHint(
  workspacePath: string,
  opts?: { canWrite?: boolean },
): Promise<string> {
  if (!workspacePath) return "";
  void opts;
  return [
    "<project_docs>",
    "Rules in `.atlarix/rules/` (or the older `.atlarix/atlarix.md`) apply when present; if absent or empty, proceed without them. Your context carries a pointer with the section list — read the files themselves with read_file before changing code or making a design decision.",
    "</project_docs>",
  ].join("\n");
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

/** Workspace-relative path check for the agent knowledge file. */
export function isWorkspaceMemoryMdPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return norm === `${ATLARIX_DIR}/${MEMORY_MD}` || norm === MEMORY_MD;
}

/** Plan mode may write either .atlarix doc (instructions or knowledge file). */
export function isAtlarixDocWritePath(relPath: string): boolean {
  return isWorkspaceAtlarixMdPath(relPath) || isWorkspaceMemoryMdPath(relPath);
}
