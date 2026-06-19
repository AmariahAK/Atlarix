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

/** Max chars to inject into system prompt (avoid context bloat) */
const MAX_INJECT_CHARS = 3000;

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

export async function migrateLegacyAtlarixFiles(workspacePath: string): Promise<void> {
  if (!workspacePath) return;
  await ensureAtlarixDir(workspacePath);

  const canonicalPath = getAtlarixMdPath(workspacePath);
  const legacyDotPath = legacyDotAtlarixMdPath(workspacePath);
  const rootAtlarixPath = rootLegacyAtlarixMdPath(workspacePath);
  const legacySpecPath = path.join(workspacePath, ATLARIX_DIR, LEGACY_SPEC_FILE);
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

/** Clamp injected content to the prompt budget (shared by all readers). */
function capInject(content: string): string {
  if (content.length > MAX_INJECT_CHARS) {
    return content.slice(0, MAX_INJECT_CHARS) + "\n\n...(truncated)";
  }
  return content;
}

export async function readAtlarixMd(workspacePath: string): Promise<string | null> {
  if (!workspacePath) return null;
  await migrateLegacyAtlarixFiles(workspacePath);

  const content = await safeRead(getAtlarixMdPath(workspacePath));
  return content ? capInject(content) : null;
}

/** v13: memory.md is auto-injected (the `memory` tool family was removed). */
export async function readMemoryMd(workspacePath: string): Promise<string | null> {
  if (!workspacePath) return null;
  const content = await safeRead(getMemoryMdPath(workspacePath));
  return content ? capInject(content) : null;
}

/** Where the project instructions came from (drives the injected heading). */
export type ProjectInstructionsSource = "atlarix" | "agents" | "claude";

/**
 * v13.1: project-instruction interop. Prefer `.atlarix/atlarix.md` (canonical,
 * with legacy migration); when it's absent/empty, fall back to a repo's
 * `AGENTS.md` (the cross-agent standard) then `CLAUDE.md` so Atlarix is
 * drop-in friendly on repos already configured for other agents. Read-only —
 * never copies the fallback into `.atlarix/`.
 */
export async function readProjectInstructions(
  workspacePath: string,
): Promise<{ content: string; source: ProjectInstructionsSource } | null> {
  if (!workspacePath) return null;

  const atlarix = await readAtlarixMd(workspacePath);
  if (atlarix) return { content: atlarix, source: "atlarix" };

  const agents = await safeRead(path.join(workspacePath, "AGENTS.md"));
  if (agents) return { content: capInject(agents), source: "agents" };

  const claude = await safeRead(path.join(workspacePath, "CLAUDE.md"));
  if (claude) return { content: capInject(claude), source: "claude" };

  return null;
}

export type MemoryMdStat = {
  exists: boolean;
  sizeKb: number;
  /** ISO date (YYYY-MM-DD) of last modification. */
  modified: string;
};

/** Lightweight stat for the prompt hint — never reads the file body. */
export async function statMemoryMd(workspacePath: string): Promise<MemoryMdStat | null> {
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
 * One-line(ish) project-docs hint for the system prompt. Informs the model that
 * `.atlarix/memory.md` can be read on demand (never injects its body) and
 * states the atlarix.md follow-when-non-empty rule.
 */
export async function buildProjectDocsPromptHint(
  workspacePath: string,
  opts?: { canWrite?: boolean },
): Promise<string> {
  if (!workspacePath) return "";
  const canWrite = opts?.canWrite ?? false;
  const stat = await statMemoryMd(workspacePath);
  const lines: string[] = ["<project_docs>"];
  lines.push(
    "Rules in `.atlarix/atlarix.md` apply when the file is non-empty; if absent or empty, proceed without it.",
  );
  if (stat) {
    lines.push(
      `A project knowledge file exists at \`.atlarix/memory.md\` (${stat.sizeKb} KB, updated ${stat.modified}). Reading it with read_file is optional but usually saves a full project re-scan — it records the tech stack, architecture, and layout.${canWrite ? " Keep it current: when durable facts change (e.g. payments PayPal → Stripe, auth Supabase → Clerk), update it with edit_file." : ""}`,
    );
  } else if (canWrite) {
    lines.push(
      "No `.atlarix/memory.md` yet. After substantial exploration, you may create it (edit_file with operation:\"write\") with the project's tech stack, architecture, and layout so future sessions can skip a full re-scan. Optional — do not interrupt the user's task for it.",
    );
  }
  lines.push("</project_docs>");
  return lines.join("\n");
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
