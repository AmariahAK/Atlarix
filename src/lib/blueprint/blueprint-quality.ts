/**
 * Blueprint richness assessment — detects thin ctags-only graphs that need file-tree supplement.
 */

import type { Blueprint, BlueprintRoom } from "@/shared/blueprint-types";

export type BlueprintQuality = "rich" | "moderate" | "thin";

export interface BlueprintRichness {
  quality: BlueprintQuality;
  visibleRooms: number;
  functionCount: number;
  uniqueFiles: number;
  edgeCount: number;
}

const THIN_FUNCTION_COUNT = 15;
const THIN_UNIQUE_FILES = 8;
const THIN_ROOMS_WITH_FEW_EDGES = 4;
const THIN_EDGE_COUNT = 5;
const RICH_FUNCTION_COUNT = 40;
const RICH_UNIQUE_FILES = 15;

function relFilePath(file?: string, description?: string): string {
  const p = (file ?? description ?? "").replace(/\\/g, "/").replace(/^\//, "");
  return p;
}

export function countBlueprintFunctions(rooms: BlueprintRoom[]): number {
  let n = 0;
  for (const r of rooms) {
    if (r.hidden) continue;
    n += r.functions?.length ?? 0;
  }
  return n;
}

export function uniqueBlueprintFiles(rooms: BlueprintRoom[]): number {
  const files = new Set<string>();
  for (const r of rooms) {
    if (r.hidden) continue;
    for (const fn of r.functions ?? []) {
      const p = relFilePath(fn.file, fn.description);
      if (p) files.add(p);
    }
  }
  return files.size;
}

/**
 * Classify blueprint density for merge/tool decisions.
 */
export function assessBlueprintRichness(
  blueprint: Blueprint,
  _opts?: { fileCount?: number },
): BlueprintRichness {
  const visibleRooms = (blueprint.rooms ?? []).filter((r) => !r.hidden).length;
  const functionCount = countBlueprintFunctions(blueprint.rooms ?? []);
  const uniqueFiles = uniqueBlueprintFiles(blueprint.rooms ?? []);
  const edgeCount = blueprint.edges?.length ?? 0;

  let quality: BlueprintQuality = "moderate";

  if (
    functionCount < THIN_FUNCTION_COUNT ||
    uniqueFiles < THIN_UNIQUE_FILES ||
    (visibleRooms < THIN_ROOMS_WITH_FEW_EDGES && edgeCount < THIN_EDGE_COUNT)
  ) {
    quality = "thin";
  } else if (functionCount >= RICH_FUNCTION_COUNT && uniqueFiles >= RICH_UNIQUE_FILES) {
    quality = "rich";
  }

  return {
    quality,
    visibleRooms,
    functionCount,
    uniqueFiles,
    edgeCount,
  };
}

/** RTE node list thin check before room conversion. */
export function isThinRteNodeSet(
  nodes: Array<{ file: string }>,
  fileCount?: number,
): boolean {
  if (nodes.length < 20) return true;
  const uniqueFiles = new Set(nodes.map((n) => n.file.replace(/\\/g, "/")));
  if (uniqueFiles.size < THIN_UNIQUE_FILES) return true;
  if (fileCount != null && fileCount > 0) {
    return uniqueFiles.size < Math.max(8, Math.floor(fileCount * 0.08));
  }
  return false;
}
