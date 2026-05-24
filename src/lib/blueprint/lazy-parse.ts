/**
 * PASS6: Lazy Blueprint parsing — single-flight per workspace + focus_path section.
 */

import log from "electron-log";
import type { Blueprint } from "@/shared/blueprint-types";
import {
  blueprintCacheKey,
  BLUEPRINT_PARSE_TIMEOUT_MS,
  BLUEPRINT_PROGRESS_LOG_MS,
  normalizeBlueprintFocusPath,
  type BlueprintParseOptions,
} from "@/lib/blueprint/parse-scope";

const logger = log.scope("blueprint:lazy-parse");

const inflight = new Map<string, Promise<Blueprint>>();
const progressTimers = new Map<string, ReturnType<typeof setInterval>>();

function clearProgressTimer(key: string): void {
  const t = progressTimers.get(key);
  if (t) {
    clearInterval(t);
    progressTimers.delete(key);
  }
}

function startProgressTimer(key: string, workspaceId: number, focusPath: string): void {
  clearProgressTimer(key);
  const started = Date.now();
  const timer = setInterval(() => {
    logger.debug("ensureBlueprintParsed: still parsing", {
      workspaceId,
      focusPath,
      elapsedMs: Date.now() - started,
    });
  }, BLUEPRINT_PROGRESS_LOG_MS);
  progressTimers.set(key, timer);
}

/**
 * Lazily parse the Blueprint for a workspace section, deduplicating concurrent calls.
 */
export async function ensureBlueprintParsed(
  workspaceId: number,
  options: BlueprintParseOptions,
): Promise<Blueprint> {
  const focusPath = normalizeBlueprintFocusPath(options.focusPath);
  if (!focusPath && !options.allowWorkspaceRoot) {
    throw new Error("focus_path is required for blueprint parse");
  }
  const fp = focusPath || ".";
  const key = blueprintCacheKey(workspaceId, fp);

  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const { getBlueprintForWorkspace } = await import("@/ipc/handlers/blueprint_handlers");
    logger.debug("ensureBlueprintParsed: starting", { workspaceId, focusPath: fp });
    startProgressTimer(key, workspaceId, fp);
    const t0 = Date.now();

    const parsePromise = getBlueprintForWorkspace(workspaceId, {
      focusPath: fp,
      allowWorkspaceRoot: options.allowWorkspaceRoot === true,
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          new Error(
            `Blueprint parse timed out after ${BLUEPRINT_PARSE_TIMEOUT_MS}ms for section "${fp}"`,
          ),
        );
      }, BLUEPRINT_PARSE_TIMEOUT_MS);
    });

    try {
      const blueprint = await Promise.race([parsePromise, timeoutPromise]);
      const elapsedMs = Date.now() - t0;
      logger.debug("ensureBlueprintParsed: complete", {
        workspaceId,
        focusPath: fp,
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
            data: { workspaceId, focusPath: fp, elapsedMs, rooms: blueprint.rooms.length },
          });
        })
        .catch(() => {});
      return blueprint;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timed out")) {
        void import("@/lib/blueprint/rte/ast-grep/worker-pool")
          .then((m) => m.shutdownAstGrepPool())
          .catch(() => {});
      }
      throw err;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      clearProgressTimer(key);
    }
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, promise);
  return promise;
}

/** Clear single-flight cache for a workspace (all sections) or one section. */
export function clearBlueprintParseInflight(
  workspaceId?: number,
  focusPath?: string,
): void {
  if (workspaceId == null) {
    inflight.clear();
    for (const key of progressTimers.keys()) clearProgressTimer(key);
    return;
  }
  if (focusPath != null) {
    const key = blueprintCacheKey(workspaceId, focusPath);
    inflight.delete(key);
    clearProgressTimer(key);
    return;
  }
  const prefix = `${workspaceId}:`;
  for (const key of [...inflight.keys()]) {
    if (key.startsWith(prefix)) {
      inflight.delete(key);
      clearProgressTimer(key);
    }
  }
}
