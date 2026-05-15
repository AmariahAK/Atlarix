/**
 * PASS6: Lazy Blueprint parsing — single-flight per workspace.
 *
 * Workspace open does NOT trigger any Blueprint parse. Parsing only happens
 * when:
 *   1. The model calls the `get_blueprint` tool (or `include_panel_graph`).
 *   2. The model calls `search` with `mode: "structural"` or `mode: "semantic-graph"` (BM25 path).
 *   3. IPC such as `blueprint:refresh-from-code` or snapshot handlers (user-initiated).
 *
 * `ensureBlueprintParsed` deduplicates concurrent callers so we never pay
 * the parse cost twice. The first caller drives the parse, all others await
 * the same promise.
 */

import log from "electron-log";
import type { Blueprint } from "@/shared/blueprint-types";

const logger = log.scope("blueprint:lazy-parse");

// Per-workspace single-flight promise map. Entries are cleared after the
// promise settles so subsequent invalidate-and-refresh calls still trigger
// a fresh parse.
const inflight = new Map<number, Promise<Blueprint>>();

/**
 * Lazily parse the Blueprint for a workspace, deduplicating concurrent calls.
 * Returns the resulting (or cached) Blueprint.
 */
export async function ensureBlueprintParsed(workspaceId: number): Promise<Blueprint> {
  const existing = inflight.get(workspaceId);
  if (existing) return existing;

  // Defer the import so this module can be loaded from contexts where
  // pulling in the full Blueprint handler tree would be wasteful (renderer
  // type checks, unit tests, etc.). At runtime in the main process it's a
  // cheap cycle-broken require.
  const promise = (async () => {
    const { getBlueprintForWorkspace } = await import(
      "@/ipc/handlers/blueprint_handlers"
    );
    logger.debug("ensureBlueprintParsed: starting", { workspaceId });
    const t0 = Date.now();
    const blueprint = await getBlueprintForWorkspace(workspaceId);
    const elapsedMs = Date.now() - t0;
    logger.info("ensureBlueprintParsed: complete", {
      workspaceId,
      elapsedMs,
      rooms: blueprint.rooms.length,
      edges: blueprint.edges?.length ?? 0,
    });
    void import("@sentry/electron/main")
      .then((Sentry) => {
        Sentry.addBreadcrumb({
          category: "blueprint",
          message: "parse_complete",
          level: "info",
          data: { workspaceId, elapsedMs, rooms: blueprint.rooms.length },
        });
      })
      .catch(() => {});
    return blueprint;
  })().finally(() => {
    inflight.delete(workspaceId);
  });

  inflight.set(workspaceId, promise);
  return promise;
}

/**
 * Clear the single-flight cache for a workspace. Useful after an invalidate
 * (e.g. blueprint:refresh-from-code) so the next caller forces a fresh parse.
 */
export function clearBlueprintParseInflight(workspaceId?: number): void {
  if (workspaceId == null) {
    inflight.clear();
    return;
  }
  inflight.delete(workspaceId);
}
