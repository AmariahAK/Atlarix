/**
 * Reference projects: load/save list per workspace, build combined blueprint with [PRIMARY] / [REF: name] markers.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { Blueprint, BlueprintRoom, BlueprintEdge } from "@/shared/blueprint-types";
import { buildBlueprintFromFileTree } from "./fileTreeSource";

const REFERENCE_PROJECTS_FILE = ".atlarix/reference-projects.json";

export async function getReferencePaths(workspacePath: string): Promise<string[]> {
  const filePath = path.join(workspacePath, REFERENCE_PROJECTS_FILE);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as { paths?: string[] };
    return Array.isArray(data.paths) ? data.paths : [];
  } catch {
    return [];
  }
}

export async function setReferencePaths(
  workspacePath: string,
  paths: string[]
): Promise<void> {
  const filePath = path.join(workspacePath, REFERENCE_PROJECTS_FILE);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify({ paths }, null, 2),
    "utf-8"
  );
}

function workspaceIdFromPath(workspacePath: string): string {
  return crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
}

function getCombinedCachePath(workspacePath: string): string {
  const wid = workspaceIdFromPath(workspacePath);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getUserDataPath } = require("../../paths/paths") as { getUserDataPath: () => string };
    return path.join(getUserDataPath(), "atlarix", "combined", wid, "combined-blueprint.json");
  } catch {
    return path.join(process.cwd(), "userData", "atlarix", "combined", wid, "combined-blueprint.json");
  }
}

/**
 * Build combined blueprint: primary + reference projects, with prefixed ids and [PRIMARY] / [REF: name] labels.
 * Cross-project edges: by matching room/function labels or paths (simplified).
 */
export async function buildCombinedBlueprint(
  primaryPath: string,
  referencePaths: string[]
): Promise<Blueprint> {
  const primary = await buildBlueprintFromFileTree(primaryPath);
  const rooms: BlueprintRoom[] = primary.rooms.map((r) => ({
    ...r,
    id: `primary::${r.id}`,
    label: r.hidden ? r.label : `[PRIMARY] ${r.label}`,
    functions: r.functions.map((f) => ({
      ...f,
      id: `primary::${f.id}`,
    })),
    flowEdges: (r.flowEdges ?? []).map((e) => ({
      ...e,
      from: `primary::${e.from}`,
      to: `primary::${e.to}`,
    })),
  }));

  const edges: BlueprintEdge[] = primary.inferredEdges.map((e) => ({
    ...e,
    from: `primary::${e.from}`,
    to: `primary::${e.to}`,
  }));

  for (let i = 0; i < referencePaths.length; i++) {
    const refPath = referencePaths[i];
    const name = path.basename(refPath) || `ref-${i}`;
    const prefix = `ref::${name}::`;
    try {
      const ref = await buildBlueprintFromFileTree(refPath);
      for (const r of ref.rooms) {
        rooms.push({
          ...r,
          id: prefix + r.id,
          label: r.hidden ? r.label : `[REF: ${name}] ${r.label}`,
          functions: r.functions.map((f) => ({
            ...f,
            id: prefix + f.id,
          })),
          flowEdges: (r.flowEdges ?? []).map((e) => ({
            ...e,
            from: prefix + e.from,
            to: prefix + e.to,
          })),
        });
      }
      for (const e of ref.inferredEdges) {
        edges.push({
          ...e,
          from: prefix + e.from,
          to: prefix + e.to,
        });
      }
    } catch (err) {
      console.warn(`[reference-manager] Skip reference ${refPath}:`, err);
    }
  }

  return { rooms, edges };
}

/**
 * Persist combined blueprint to user data for the workspace.
 */
export async function saveCombinedBlueprint(
  workspacePath: string,
  blueprint: Blueprint
): Promise<void> {
  const filePath = getCombinedCachePath(workspacePath);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(blueprint, null, 2), "utf-8");
}

/**
 * Load combined blueprint from cache if present.
 */
export async function loadCombinedBlueprint(workspacePath: string): Promise<Blueprint | null> {
  const filePath = getCombinedCachePath(workspacePath);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as Blueprint;
  } catch {
    return null;
  }
}
