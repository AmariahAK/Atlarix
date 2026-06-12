/**
 * v12 3.7: registry for fire-and-forget promises that MUTATE STATE (session
 * persistence, self-correction dispatch, usage recording). Untracked `void`
 * promises were lost on quit — a write racing shutdown silently never landed.
 * Track them here; main.ts drains the set in its before-quit pipeline.
 */
import log from "electron-log";

const logger = log.scope("pending-work");

const pending = new Set<Promise<unknown>>();

/**
 * Track a state-mutating background promise. Errors are logged (never thrown
 * back to the caller) and the entry self-removes on settle.
 */
export function trackPendingWork(
  promise: Promise<unknown>,
  label: string,
): void {
  pending.add(promise);
  promise
    .catch((e) =>
      logger.warn(`[${label}] background work failed: ${String(e)}`),
    )
    .finally(() => pending.delete(promise));
}

/**
 * Await all in-flight tracked work, bounded by `timeoutMs` (shutdown must not
 * hang on a stuck promise). Returns the number of promises still pending at
 * the deadline.
 */
export async function drainPendingWork(timeoutMs = 5_000): Promise<number> {
  if (pending.size === 0) return 0;
  logger.info(`draining ${pending.size} pending background task(s)`);
  const all = Promise.allSettled(pending);
  await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
  if (pending.size > 0) {
    logger.warn(
      `${pending.size} background task(s) still pending at shutdown deadline`,
    );
  }
  return pending.size;
}
