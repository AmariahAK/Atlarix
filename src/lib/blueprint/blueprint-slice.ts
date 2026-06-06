/**
 * Pure blueprint slice helpers for `get_blueprint` — section-local room paths,
 * focus_path prefix stripping, and scope resolution.
 */

import type { Blueprint, BlueprintRoom } from "@/shared/blueprint-types";

export function normalizeSlicePath(p: string): string {
  return String(p || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

function pathLower(p: string): string {
  return normalizeSlicePath(p).toLowerCase();
}

/** True when the path means "whole section" (not a subfolder drill-down). */
export function isSectionRootPath(path: string | undefined, focusPath?: string): boolean {
  const p = normalizeSlicePath(path ?? "");
  if (!p || p === "." || p === "./") return true;
  const fp = normalizeSlicePath(focusPath ?? "");
  if (fp && pathLower(p) === pathLower(fp)) return true;
  return false;
}

/** Strip workspace `focus_path` prefix so slice targets are section-relative. */
export function stripFocusPathPrefix(path: string, focusPath: string): string {
  const p = normalizeSlicePath(path);
  const fp = normalizeSlicePath(focusPath);
  if (!fp || fp === ".") return p;
  const pl = p.toLowerCase();
  const fpl = fp.toLowerCase();
  if (pl === fpl) return "";
  const prefix = `${fpl}/`;
  if (pl.startsWith(prefix)) {
    return normalizeSlicePath(p.slice(fp.length + 1));
  }
  return p;
}

export interface ResolvedSliceParams {
  scope: "file" | "folder" | "full";
  /** Undefined when scope is full (match all rooms in section blueprint). */
  path?: string;
}

/**
 * Map tool scope/path/focus_path to effective slice parameters.
 * Section blueprints already cover `focus_path`; omit path or use `.` for the whole section.
 */
export function resolveSliceParams(
  scope: "file" | "folder" | "full",
  path: string | undefined,
  focusPath: string,
): ResolvedSliceParams {
  if (scope === "full") {
    return { scope: "full", path: undefined };
  }

  const raw = path?.trim();
  if (scope === "folder" && isSectionRootPath(raw, focusPath)) {
    return { scope: "full", path: undefined };
  }

  if (!raw) {
    if (scope === "folder") {
      return { scope: "full", path: undefined };
    }
    return { scope, path: undefined };
  }

  const stripped = stripFocusPathPrefix(raw, focusPath);
  if (scope === "folder" && isSectionRootPath(stripped, focusPath)) {
    return { scope: "full", path: undefined };
  }

  return { scope, path: stripped || undefined };
}

function filePathMatchesTarget(filePath: string, target: string): boolean {
  const f = pathLower(filePath);
  const t = pathLower(target);
  if (!t) return false;
  if (f === t) return true;
  if (f.endsWith(`/${t}`)) return true;
  const base = f.split("/").pop() ?? "";
  const tBase = t.split("/").pop() ?? t;
  return base === tBase && (f.endsWith(`/${t}`) || f === tBase);
}

function roomPathMatchesTarget(roomPath: string, target: string): boolean {
  const rp = pathLower(roomPath);
  const t = pathLower(target);
  if (!t) return false;
  if (rp === t) return true;
  if (rp.endsWith(`/${t}`)) return true;
  if (rp.startsWith(`${t}/`)) return true;
  const rpBase = rp.split("/").pop() ?? rp;
  const tBase = t.split("/").pop() ?? t;
  if (rpBase === tBase) return true;
  return false;
}

export function roomMatchesScope(
  room: BlueprintRoom,
  scope: "file" | "folder" | "full",
  targetPath: string | undefined,
): boolean {
  if (scope === "full") return true;
  if (!targetPath) return false;

  const t = pathLower(targetPath);
  const rp = pathLower(room.path ?? "");

  const fnFileMatch = (room.functions ?? []).some((fn) =>
    filePathMatchesTarget(fn.file ?? "", targetPath),
  );

  if (scope === "file") {
    return roomPathMatchesTarget(room.path ?? "", targetPath) || fnFileMatch;
  }

  return (
    roomPathMatchesTarget(room.path ?? "", targetPath) ||
    fnFileMatch ||
    (rp.length > 0 && t.length > 0 && rp.includes(`/${t}`))
  );
}

export interface SliceResult {
  scope: "file" | "folder" | "full";
  path?: string;
  depth: number;
  totalRoomsInWorkspace: number;
  nodes: Array<{
    id: string;
    label: string;
    type?: string;
    path?: string;
    intent?: string;
    functionCount: number;
    functions: Array<{
      id: string;
      name: string;
      kind: string;
      file?: string;
      /** v12 Tier 6 #3: the ctags signature (`fn(a, b)`), free signal density. */
      signature?: string;
    }>;
  }>;
  edges: Array<{ from: string; to: string; label?: string; type?: string; inferred?: boolean }>;
  /** v12 Tier 6 #2: rooms dropped by the relevance/centrality cap (tail summary). */
  omittedRooms?: { count: number; labels: string[] };
}

export function buildSlice(
  blueprint: Blueprint,
  scope: "file" | "folder" | "full",
  targetPath: string | undefined,
  depth: number,
): SliceResult {
  const total = blueprint.rooms.length;
  const matched = blueprint.rooms.filter((r) => roomMatchesScope(r, scope, targetPath));
  const keepIds = new Set(matched.map((r) => r.id));

  const allEdges = blueprint.edges ?? [];
  for (let hop = 0; hop < Math.max(0, depth); hop++) {
    let grew = false;
    for (const e of allEdges) {
      if (keepIds.has(e.from) && !keepIds.has(e.to)) {
        keepIds.add(e.to);
        grew = true;
      } else if (keepIds.has(e.to) && !keepIds.has(e.from)) {
        keepIds.add(e.from);
        grew = true;
      }
    }
    if (!grew) break;
  }

  // v12 Tier 6 #2: rank kept rooms by centrality (edge-degree — high-fan-in
  // core modules first) so a capped slice keeps the most-connected structure
  // and the tail is summarized rather than truncated arbitrarily.
  const degree = new Map<string, number>();
  for (const e of allEdges) {
    if (keepIds.has(e.from) && keepIds.has(e.to)) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
  }
  const MAX_ROOMS_IN_SLICE = 40;
  const keptRooms = blueprint.rooms.filter((r) => keepIds.has(r.id));
  const matchedIds = new Set(matched.map((r) => r.id));
  const rankedRooms = [...keptRooms].sort((a, b) => {
    // Directly-matched rooms always outrank edge-expanded ones.
    const am = matchedIds.has(a.id) ? 1 : 0;
    const bm = matchedIds.has(b.id) ? 1 : 0;
    if (am !== bm) return bm - am;
    return (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0);
  });
  const slicedRooms = rankedRooms.slice(0, MAX_ROOMS_IN_SLICE);
  const omitted = rankedRooms.slice(MAX_ROOMS_IN_SLICE);
  // Re-narrow keepIds to the kept rooms so edges to dropped rooms are pruned.
  const finalKeep = new Set(slicedRooms.map((r) => r.id));

  const nodes = slicedRooms.map((r) => ({
    id: r.id,
    label: r.label,
    type: r.type,
    path: r.path,
    intent: r.intent,
    functionCount: r.functions?.length ?? 0,
    // v12 Tier 6 #2: rank functions within a room by signature-richness then
    // name, capped — a ranked top-50 instead of arbitrary first-50.
    functions: [...(r.functions ?? [])]
      .sort((a, b) => Number(!!b.simpleDescription) - Number(!!a.simpleDescription))
      .slice(0, 50)
      .map((fn) => ({
        id: fn.id,
        name: fn.name,
        kind: fn.kind,
        file: fn.file,
        // #3: emit the ctags signature (held in simpleDescription) when present.
        ...(fn.simpleDescription ? { signature: fn.simpleDescription } : {}),
      })),
  }));

  const edges = allEdges
    .filter((e) => finalKeep.has(e.from) && finalKeep.has(e.to))
    .map((e) => ({
      from: e.from,
      to: e.to,
      label: e.label,
      type: e.type,
      inferred: e.inferred,
    }));

  return {
    scope,
    path: targetPath,
    depth,
    totalRoomsInWorkspace: total,
    nodes,
    edges,
    ...(omitted.length > 0
      ? {
          omittedRooms: {
            count: omitted.length,
            labels: omitted.slice(0, 8).map((r) => r.label),
          },
        }
      : {}),
  };
}

export function countVisibleRooms(blueprint: Blueprint): number {
  return (blueprint.rooms ?? []).filter((r) => !r.hidden).length;
}

/**
 * Build slice with resolved params; auto-widen to full section when drill-down matches nothing.
 */
export function buildSliceWithResolve(
  blueprint: Blueprint,
  scope: "file" | "folder" | "full",
  path: string | undefined,
  focusPath: string,
  depth: number,
): { slice: SliceResult; sliceWidened: boolean; resolved: ResolvedSliceParams } {
  const resolved = resolveSliceParams(scope, path, focusPath);
  let slice = buildSlice(blueprint, resolved.scope, resolved.path, depth);
  let sliceWidened = false;

  const visible = countVisibleRooms(blueprint);
  if (visible > 0 && slice.nodes.length === 0 && resolved.scope !== "full") {
    slice = buildSlice(blueprint, "full", undefined, depth);
    sliceWidened = true;
  }

  return { slice, sliceWidened, resolved };
}
