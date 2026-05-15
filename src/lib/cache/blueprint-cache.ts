/**
 * Blueprint cache: persist and load RTE-generated blueprints under ~/.atlarix/blueprints/{projectHash}/
 * User blueprint (rooms, edges, flowEdges) is stored in user_blueprint.json for persistence across restarts.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { getUserDataPath } from "@/paths/paths";
import { getWorkspaceHash } from "@/lib/analysis/workspace-cache";
import type { BlueprintCacheContent, BlueprintStaleness } from "@/shared/blueprint-cache-types";
import type { Blueprint } from "@/shared/blueprint-types";

const BLUEPRINTS_DIR = "blueprints";
const MANIFEST_FILE = "manifest.json";
const BLUEPRINT_FILE = "blueprint.json";
const USER_BLUEPRINT_FILE = "user_blueprint.json";

function getBlueprintCacheRoot(): string {
  return path.join(getUserDataPath(), BLUEPRINTS_DIR);
}

function getProjectCacheDir(projectHash: string): string {
  return path.join(getBlueprintCacheRoot(), projectHash);
}

/**
 * Save blueprint cache for a project. Uses projectPath to compute hash and write manifest + blueprint.
 */
export async function saveBlueprintCache(
  projectPath: string,
  content: Omit<BlueprintCacheContent, "manifest"> & { manifest: Omit<BlueprintCacheContent["manifest"], "projectHash" | "timestamp"> }
): Promise<void> {
  const projectHash = await getWorkspaceHash(projectPath);
  const manifest = {
    ...content.manifest,
    projectHash,
    projectPath,
    timestamp: Date.now(),
  };
  const dir = getProjectCacheDir(projectHash);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, MANIFEST_FILE),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );
  const toWrite = {
    ...content,
    manifest,
  };
  await fs.writeFile(
    path.join(dir, BLUEPRINT_FILE),
    JSON.stringify(toWrite, null, 2),
    "utf-8"
  );
}

/**
 * Load blueprint cache for a project. Returns null if not found or invalid.
 */
export async function loadBlueprintCache(projectPath: string): Promise<BlueprintCacheContent | null> {
  const projectHash = await getWorkspaceHash(projectPath);
  const dir = getProjectCacheDir(projectHash);
  const filePath = path.join(dir, BLUEPRINT_FILE);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as BlueprintCacheContent;
    if (data.manifest && data.nodes) return data;
  } catch {
    // not found or invalid
  }
  return null;
}

/**
 * Get staleness of cached blueprint vs current project state.
 */
export async function getStaleness(projectPath: string): Promise<BlueprintStaleness | null> {
  const currentHash = await getWorkspaceHash(projectPath);
  const cached = await loadBlueprintCache(projectPath);
  if (!cached) {
    return null;
  }
  const cachedHash = cached.manifest.projectHash;
  const isStale = currentHash !== cachedHash;
  return {
    isStale,
    currentHash,
    cachedHash,
    recommendation: isStale ? "refresh" : "use_cache",
  };
}

/**
 * Invalidate (delete) blueprint cache for a project.
 */
export async function invalidateBlueprintCacheForProject(projectPath: string): Promise<void> {
  const projectHash = await getWorkspaceHash(projectPath);
  const dir = getProjectCacheDir(projectHash);
  try {
    await fs.rm(dir, { recursive: true });
  } catch {
    // ignore
  }
}

/**
 * Save user's blueprint (rooms, edges, flowEdges) to disk. Survives app restarts.
 * Stored in same project cache dir as RTE cache.
 */
export async function saveUserBlueprint(projectPath: string, blueprint: Blueprint): Promise<void> {
  const projectHash = await getWorkspaceHash(projectPath);
  const dir = getProjectCacheDir(projectHash);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, USER_BLUEPRINT_FILE),
    JSON.stringify(blueprint, null, 2),
    "utf-8"
  );
}

/**
 * Returns the mtime (epoch ms) of the persisted `user_blueprint.json` for a
 * project, or null if it doesn't exist. Used by Workforce snapshot auto-load
 * to decide whether a committed `.atlarix/blueprint.json` is newer than the
 * current user cache.
 */
export async function getUserBlueprintMtime(projectPath: string): Promise<number | null> {
  const projectHash = await getWorkspaceHash(projectPath);
  const dir = getProjectCacheDir(projectHash);
  const filePath = path.join(dir, USER_BLUEPRINT_FILE);
  try {
    const stat = await fs.stat(filePath);
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Load user's saved blueprint if present. Returns null if not found or invalid.
 */
export async function loadUserBlueprint(projectPath: string): Promise<Blueprint | null> {
  const projectHash = await getWorkspaceHash(projectPath);
  const dir = getProjectCacheDir(projectHash);
  const filePath = path.join(dir, USER_BLUEPRINT_FILE);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as Blueprint;
    if (data && Array.isArray(data.rooms)) return data;
  } catch {
    // not found or invalid
  }
  return null;
}
