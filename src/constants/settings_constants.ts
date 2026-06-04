/** Default chat turns (user+assistant pairs) sent to AI. Raised from 3 for better context (Phase 5). */
export const MAX_CHAT_TURNS_IN_CONTEXT = 10;

/**
 * Wall-clock cap for long-running multi-round workspace tool streams.
 * Applies regardless of chat tier (ask/build/agent), work mode (ask/plan/build/debug/review),
 * or agent mode (direct/guided/autonomous).
 */
export const STREAM_TOOL_LOOP_DURATION_CAP_MS = 30 * 60 * 1000;

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
 * Check if the process is under memory pressure.
 * Returns true if heap usage exceeds WORKSPACE_MEMORY_SAFE_BYTES.
 */
export function isUnderMemoryPressure(): boolean {
  const mem = process.memoryUsage();
  return mem.heapUsed > WORKSPACE_MEMORY_SAFE_BYTES;
}

