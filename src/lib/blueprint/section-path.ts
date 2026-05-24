/**
 * Validate workspace-relative `focus_path` before blueprint parse.
 */

import * as fs from "node:fs/promises";
import path from "node:path";
import { distance } from "fastest-levenshtein";
import {
  isWorkspaceRootFocusPath,
  normalizeBlueprintFocusPath,
  resolveScanRoot,
} from "@/lib/blueprint/parse-scope";

const SKIP_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "dist",
  "build",
  "target",
]);

export type BlueprintFocusPathValidation =
  | { valid: true; scanRoot: string; focusPath: string }
  | {
      valid: false;
      scanRoot: string;
      focusPath: string;
      error: string;
      suggestions: string[];
    };

/** Top-level workspace folders suitable as blueprint sections. */
export async function listWorkspaceSectionCandidates(workspacePath: string): Promise<string[]> {
  let entries: string[] = [];
  try {
    const dirents = await fs.readdir(workspacePath, { withFileTypes: true });
    entries = dirents
      .filter((d) => d.isDirectory() && !SKIP_DIR_NAMES.has(d.name) && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
  return entries;
}

function rankSuggestions(input: string, candidates: string[], limit = 5): string[] {
  const norm = input.toLowerCase();
  const scored = candidates
    .map((c) => ({ c, d: distance(norm, c.toLowerCase()) }))
    .filter((x) => x.d <= Math.max(3, Math.floor(norm.length * 0.4)))
    .sort((a, b) => a.d - b.d || a.c.localeCompare(b.c));
  return scored.slice(0, limit).map((x) => x.c);
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Verify `focus_path` resolves to an existing directory under the workspace.
 */
export async function validateBlueprintFocusPath(
  workspacePath: string,
  focusPath: string,
  options?: { allowWorkspaceRoot?: boolean },
): Promise<BlueprintFocusPathValidation> {
  const fp = normalizeBlueprintFocusPath(focusPath);
  const scanRoot = resolveScanRoot(workspacePath, fp);

  if (!options?.allowWorkspaceRoot && isWorkspaceRootFocusPath(fp)) {
    const candidates = await listWorkspaceSectionCandidates(workspacePath);
    return {
      valid: false,
      scanRoot,
      focusPath: fp || ".",
      error:
        'focus_path must be a section folder (e.g. "packages/api"), not "." or workspace root.',
      suggestions: candidates.slice(0, 8),
    };
  }

  if (await isDirectory(scanRoot)) {
    return { valid: true, scanRoot, focusPath: fp };
  }

  const candidates = await listWorkspaceSectionCandidates(workspacePath);
  const suggestions = rankSuggestions(fp, candidates);

  return {
    valid: false,
    scanRoot,
    focusPath: fp,
    error: `Section path does not exist: "${fp}"`,
    suggestions,
  };
}

/** True when every segment of focus_path exists (for nested sections). */
export async function validateNestedFocusPath(
  workspacePath: string,
  focusPath: string,
): Promise<boolean> {
  const fp = normalizeBlueprintFocusPath(focusPath);
  if (!fp || fp === ".") return isDirectory(workspacePath);
  const parts = fp.split("/").filter(Boolean);
  let cur = workspacePath;
  for (const seg of parts) {
    cur = path.join(cur, seg);
    if (!(await isDirectory(cur))) return false;
  }
  return true;
}
