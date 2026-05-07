/** Default chat turns (user+assistant pairs) sent to AI. Raised from 3 for better context (Phase 5). */
export const MAX_CHAT_TURNS_IN_CONTEXT = 10;

/**
 * Wall-clock cap for long-running multi-round workspace tool streams.
 * Applies regardless of chat tier (ask/build/agent), work mode (ask/plan/build/debug/review),
 * or agent mode (direct/guided/autonomous).
 */
export const STREAM_TOOL_LOOP_DURATION_CAP_MS = 30 * 60 * 1000;

/** Hard wall-clock cap for multi-model counsel (participants + synthesis). */
export const COUNSEL_TIMEOUT_MS = 7 * 60 * 1000;

/**
 * Memory pressure threshold for large operations (1.5GB).
 * Operations exceeding this heap usage should be deferred or skipped.
 */
export const WORKSPACE_MEMORY_SAFE_BYTES = 1_500_000_000;

/**
 * Threshold for large workspace detection (number of source files).
 * Workspaces exceeding this should use on-demand search instead of eager analysis.
 */
export const WORKSPACE_LARGE_FILE_THRESHOLD = 500;

/**
 * Number of .git folders that indicates a multi-repo workspace.
 * When detected, show picker for user to select which project to analyze.
 */
export const WORKSPACE_MULTI_REPO_GIT_COUNT = 2;

/**
 * Check if the process is under memory pressure.
 * Returns true if heap usage exceeds WORKSPACE_MEMORY_SAFE_BYTES.
 */
export function isUnderMemoryPressure(): boolean {
  const mem = process.memoryUsage();
  return mem.heapUsed > WORKSPACE_MEMORY_SAFE_BYTES;
}

/**
 * Threshold for eager Blueprint build on workspace open.
 * Under this file count: build Blueprint eagerly (fast, unnoticeable).
 * Over this file count: build Blueprint on-demand via tools.
 * 
 * v8.0: Blueprint is now on-demand by default. The model uses
 * get_blueprint, get_blueprint_slice tools to build Blueprint
 * when needed. Eager build only for very small workspaces (<100 files).
 */
export const BLUEPRINT_EAGER_BUILD_THRESHOLD = 100;

/**
 * Get current memory usage info for debugging/logging.
 */
export function getMemoryUsageMB(): { heapUsed: number; heapTotal: number; external: number } {
  const mem = process.memoryUsage();
  return {
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    external: Math.round(mem.external / 1024 / 1024),
  };
}
