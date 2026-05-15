/**
 * File watcher for incremental Blueprint updates.
 * When a source file changes, re-parse that file and update the blueprint cache.
 */

import * as fs from "fs";
import * as path from "path";
import { loadBlueprintCache, saveBlueprintCache } from "@/lib/cache/blueprint-cache";
import { generateBlueprint, PARSERS } from "@/lib/blueprint/rte/parsers";
import type { BlueprintNode } from "./rte/parsers/types";
const CODE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".java",
  ".kt",
  ".kts",
  ".go",
  ".rs",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".ex",
  ".exs",
]);
const DEBOUNCE_MS = 500;

let watcher: fs.FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastProjectPath: string | null = null;
let lastWorkspaceId: number | null = null;

function getLanguageFromExt(
  ext: string
): "typescript" | "python" | "java" | "kotlin" | "go" | "rust" | "csharp" | "ruby" | "php" | "swift" | "elixir" | null {
  if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) return "typescript";
  if (ext === ".py") return "python";
  if (ext === ".java") return "java";
  if (ext === ".kt" || ext === ".kts") return "kotlin";
  if (ext === ".go") return "go";
  if (ext === ".rs") return "rust";
  if (ext === ".cs") return "csharp";
  if (ext === ".rb") return "ruby";
  if (ext === ".php") return "php";
  if (ext === ".swift") return "swift";
  if (ext === ".ex" || ext === ".exs") return "elixir";
  return null;
}

/**
 * Update cached blueprint by re-parsing a single file and replacing its nodes.
 */
export async function updateBlueprintCacheForFile(
  projectPath: string,
  relativeFilePath: string
): Promise<boolean> {
  const ext = path.extname(relativeFilePath).toLowerCase();
  if (!CODE_EXT.has(ext)) return false;

  const cached = await loadBlueprintCache(projectPath);
  if (!cached || !cached.nodes.length) return false;

  const lang = getLanguageFromExt(ext);
  const parser = lang ? PARSERS[lang] : null;
  if (!parser) return false;

  const absolutePath = path.join(projectPath, relativeFilePath);
  const newNodes = await parser.parse([absolutePath]);
  const otherNodes = cached.nodes.filter((n) => n.file !== relativeFilePath);
  const updatedNodes = [...otherNodes, ...newNodes];
  const nodeIds = new Set(updatedNodes.map((n) => n.id));
  const updatedEdges = cached.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));

  await saveBlueprintCache(projectPath, {
    manifest: {
      projectPath: cached.manifest.projectPath,
      framework: cached.manifest.framework,
      language: cached.manifest.language,
    },
    nodes: updatedNodes as BlueprintNode[],
    edges: updatedEdges,
  });
  return true;
}

/**
 * Register a file watcher for projectPath. On change, updates blueprint cache and calls onUpdated.
 * Only one workspace can be watched at a time; call with projectPath: null to stop.
 */
export function registerBlueprintFileWatcher(
  projectPath: string | null,
  workspaceId: number | null,
  onUpdated?: (
    projectPath: string,
    relativePath: string,
    workspaceId: number
  ) => void | Promise<void>
): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  lastProjectPath = projectPath;
  lastWorkspaceId = workspaceId;

  if (!projectPath) return;

  const pending = new Set<string>();

  watcher = fs.watch(
    projectPath,
    { recursive: true },
    (eventType, filename) => {
      if (!filename || typeof filename !== "string") return;
      const normalized = filename.replace(/\\/g, "/");
      if (!CODE_EXT.has(path.extname(normalized).toLowerCase())) return;
      pending.add(normalized);
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        debounceTimer = null;
        const files = Array.from(pending);
        pending.clear();
        if (lastProjectPath !== projectPath) return;
        for (const f of files) {
          try {
            const ok = await updateBlueprintCacheForFile(projectPath, f);
            if (ok && lastWorkspaceId != null) {
              await onUpdated?.(projectPath, f, lastWorkspaceId);
            }
          } catch {
            // ignore
          }
        }
      }, DEBOUNCE_MS);
    }
  );
}
