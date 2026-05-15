/**
 * Workforce Feature 2 — `.atlarix/blueprint.json` snapshot serializer.
 *
 * `atlarix blueprint commit` writes a dual-format JSON file into the
 * workspace root:
 *
 *   - flat `nodes` / `edges` arrays for readable git diffs
 *   - `raw.rooms` / `raw.edges` / `raw.envRefs` for lossless rehydration into
 *     the internal Blueprint cache when teammates open the repo
 *
 * The Workforce gate is enforced at the IPC layer in `blueprint_handlers.ts`;
 * this module is gate-agnostic so a future "share-only" Pro tier can re-use it.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import log from "electron-log";

import type { Blueprint } from "@/shared/blueprint-types";
import { blueprintToMarkdown } from "./blueprint-markdown";

const logger = log.scope("blueprint-snapshot");

/** Workspace-relative path of the snapshot file. */
export const BLUEPRINT_SNAPSHOT_PATH = path.join(".atlarix", "blueprint.json");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BlueprintSnapshotFlatNode {
  id: string;
  type: string;
  label: string;
  path?: string;
  language?: string;
}

export interface BlueprintSnapshotFlatEdge {
  source: string;
  target: string;
  type: string;
}

export interface BlueprintSnapshotSummary {
  languages: string[];
  entryPoints: string[];
  topLevelModules: string[];
  lastCommitHash?: string;
}

export interface BlueprintSnapshot {
  version: "1";
  generatedAt: string;
  generatedBy: string;
  workspaceName: string;
  nodeCount: number;
  edgeCount: number;
  nodes: BlueprintSnapshotFlatNode[];
  edges: BlueprintSnapshotFlatEdge[];
  summary: BlueprintSnapshotSummary;
  /**
   * Pass 7: Markdown tree of the workspace. Identical to what
   * `get_blueprint` returns to the AI and what the Mind Elixir canvas
   * renders. Adding it to the file makes `.atlarix/blueprint.json` diff
   * cleanly in git review tools.
   */
  markdown?: string;
  raw: {
    rooms: Blueprint["rooms"];
    edges: Blueprint["edges"];
    envRefs?: string[];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function inferLanguageFromPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
    case ".ts": return "typescript";
    case ".tsx": return "typescript";
    case ".js": return "javascript";
    case ".jsx": return "javascript";
    case ".py": return "python";
    case ".go": return "go";
    case ".rs": return "rust";
    case ".java": return "java";
    case ".cpp": case ".cc": case ".cxx": return "cpp";
    case ".c": case ".h": return "c";
    case ".cs": return "csharp";
    case ".rb": return "ruby";
    case ".php": return "php";
    case ".swift": return "swift";
    case ".kt": return "kotlin";
    case ".m": case ".mm": return "objc";
    default: return undefined;
  }
}

const ENTRY_POINT_PATH_RE = /(?:^|[\\/])(index|main|app)\.(ts|tsx|js|jsx|py|go|rs)$/i;

function isEntryPoint(room: { intent?: string; path?: string }): boolean {
  const intent = (room.intent ?? "").toLowerCase();
  if (
    intent.includes("entry") ||
    intent.includes("main") ||
    intent.includes("index")
  ) {
    return true;
  }
  if (room.path && ENTRY_POINT_PATH_RE.test(room.path)) return true;
  return false;
}

function flattenBlueprint(blueprint: Blueprint): {
  nodes: BlueprintSnapshotFlatNode[];
  edges: BlueprintSnapshotFlatEdge[];
  summary: Omit<BlueprintSnapshotSummary, "lastCommitHash">;
} {
  const nodes: BlueprintSnapshotFlatNode[] = [];

  for (const room of blueprint.rooms ?? []) {
    if (room.hidden) continue;
    const language = inferLanguageFromPath(room.path);
    nodes.push({
      id: room.id,
      type: room.type ?? "room",
      label: room.label,
      ...(room.path ? { path: room.path } : {}),
      ...(language ? { language } : {}),
    });

    for (const fn of room.functions ?? []) {
      const fnPath = fn.file ?? room.path;
      const fnLanguage = inferLanguageFromPath(fnPath);
      nodes.push({
        id: `${room.id}#${fn.id}`,
        type: "function",
        label: fn.name,
        ...(fnPath ? { path: fnPath } : {}),
        ...(fnLanguage ? { language: fnLanguage } : {}),
      });
    }
  }

  const edges: BlueprintSnapshotFlatEdge[] = (blueprint.edges ?? []).map((e) => ({
    source: e.from,
    target: e.to,
    type: e.inferred ? "inferred" : e.type ?? "imports",
  }));

  const languages = Array.from(
    new Set(nodes.map((n) => n.language).filter((l): l is string => !!l)),
  ).sort();

  const entryPoints = (blueprint.rooms ?? [])
    .filter((r) => !r.hidden && isEntryPoint(r))
    .map((r) => r.id);

  const topLevelModules = (blueprint.rooms ?? [])
    .filter((r) => !r.hidden && !r.parentId)
    .map((r) => r.id);

  return {
    nodes,
    edges,
    summary: { languages, entryPoints, topLevelModules },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// File I/O
// ─────────────────────────────────────────────────────────────────────────────

function snapshotFilePath(workspacePath: string): string {
  return path.join(workspacePath, BLUEPRINT_SNAPSHOT_PATH);
}

export async function blueprintSnapshotExists(workspacePath: string): Promise<boolean> {
  try {
    await fs.access(snapshotFilePath(workspacePath));
    return true;
  } catch {
    return false;
  }
}

export async function loadBlueprintSnapshot(workspacePath: string): Promise<BlueprintSnapshot | null> {
  const file = snapshotFilePath(workspacePath);
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as BlueprintSnapshot;
    if (!parsed || parsed.version !== "1" || !parsed.raw) return null;
    if (!Array.isArray(parsed.raw.rooms) || !Array.isArray(parsed.raw.edges)) return null;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    logger.warn(`[blueprint-snapshot] Failed to read ${file}:`, err);
    return null;
  }
}

/** Returns mtime epoch (ms) of the snapshot file, or null if missing. */
export async function getBlueprintSnapshotMtime(workspacePath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(snapshotFilePath(workspacePath));
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

export interface SnapshotBlueprintOptions {
  workspacePath: string;
  blueprint: Blueprint;
  workspaceName: string;
  atlarixVersion: string;
  lastCommitHash?: string;
}

export interface SnapshotBlueprintResult {
  success: boolean;
  nodeCount: number;
  edgeCount: number;
  path: string;
  firstCommit: boolean;
}

/** Snapshot the current Blueprint to `.atlarix/blueprint.json`. */
export async function snapshotBlueprintToRepo(
  opts: SnapshotBlueprintOptions,
): Promise<SnapshotBlueprintResult> {
  const { workspacePath, blueprint, workspaceName, atlarixVersion, lastCommitHash } = opts;

  const { nodes, edges, summary } = flattenBlueprint(blueprint);
  const existed = await blueprintSnapshotExists(workspacePath);

  const markdown = blueprintToMarkdown(blueprint, {
    maxLines: 500,
    includeImports: true,
    includeExports: true,
    workspaceName,
  });

  const snapshot: BlueprintSnapshot = {
    version: "1",
    generatedAt: new Date().toISOString(),
    generatedBy: `Atlarix ${atlarixVersion}`,
    workspaceName,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges,
    summary: {
      ...summary,
      ...(lastCommitHash ? { lastCommitHash } : {}),
    },
    markdown,
    raw: {
      rooms: blueprint.rooms ?? [],
      edges: blueprint.edges ?? [],
      ...(blueprint.envRefs ? { envRefs: blueprint.envRefs } : {}),
    },
  };

  const file = snapshotFilePath(workspacePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(snapshot, null, 2), "utf8");

  logger.info(
    `[blueprint-snapshot] Committed ${nodes.length} nodes, ${edges.length} edges to ${BLUEPRINT_SNAPSHOT_PATH}${existed ? " (overwrite)" : " (first commit)"}`,
  );

  return {
    success: true,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    path: BLUEPRINT_SNAPSHOT_PATH,
    firstCommit: !existed,
  };
}

/**
 * Convert a snapshot back into the in-memory `Blueprint` shape. The caller is
 * responsible for persisting it via `setBlueprintForWorkspace` so the cache,
 * disk, and renderer stay consistent.
 */
export function snapshotToBlueprint(snapshot: BlueprintSnapshot): Blueprint {
  return {
    rooms: snapshot.raw.rooms ?? [],
    edges: snapshot.raw.edges ?? [],
    envRefs: snapshot.raw.envRefs ?? [],
  };
}

/** Log a one-line summary when a snapshot is loaded from disk. */
export function logSnapshotLoaded(snapshot: BlueprintSnapshot): void {
  logger.info(
    `[blueprint-snapshot] Loaded team Blueprint: ${snapshot.nodeCount} nodes, ${snapshot.edgeCount} edges (generated ${snapshot.generatedAt})`,
  );
}
