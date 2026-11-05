/**
 * Idle compaction (token saving, owner 2026-11-05; Claude Code does this).
 *
 * The main conversation's prompt cache lives for an hour on Anthropic-format
 * routes (anthropic-cache-breakpoints.ts). A long conversation left idle past
 * that is written to the cache again, all of it, by the next message. A little
 * before the hour runs out, it is compacted instead, so that next message
 * carries a summary and the recent turns. Nothing is lost for good: the model
 * can re-read the full transcript with `session_search`.
 *
 * Atlarix's own version of Claude Code's (200K+ idle ~54 min): the same timing,
 * with a smaller floor because Atlarix already compacts at its 256K working
 * window's 75% point. Never while a turn runs or after a newer turn started;
 * a turn that starts while it runs waits for it.
 */
import log from "electron-log";

const logger = log.scope("compaction");

/** A little under the 1h cache lifetime, as Claude Code does. */
export const IDLE_COMPACT_AFTER_MS = 54 * 60 * 1000;
/** Below this the next message re-writing the history costs little; above it, a summary is cheaper. */
export const IDLE_COMPACT_MIN_TOKENS = 100_000;

export interface IdleRoute {
  /** The turn ran on a route with the 1h prompt cache. */
  oneHourCache: boolean;
  providerId?: string;
  model?: { provider: string; name: string };
}

const routes = new Map<number, IdleRoute>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const running = new Map<number, Promise<void>>();
/** Bumped by every turn that starts: a timer armed before it is stale. */
const generation = new Map<number, number>();

function disabled(): boolean {
  return process.env.ATLARIX_IDLE_COMPACTION === "off";
}

/** What the turn ran on (simple-stream-text). */
export function noteIdleRoute(chatId: number, route: IdleRoute): void {
  routes.set(chatId, route);
}

/** A turn is starting: no idle compaction now, and one already running finishes first. */
export async function settleIdleCompaction(chatId: number): Promise<void> {
  generation.set(chatId, (generation.get(chatId) ?? 0) + 1);
  const t = timers.get(chatId);
  if (t) clearTimeout(t);
  timers.delete(chatId);
  await running.get(chatId)?.catch(() => {});
}

export interface IdleCompactionDeps {
  /** Is a turn live for this chat? */
  isLive: (chatId: number) => boolean;
  /** The history's size now, in tokens. */
  historyTokens: (chatId: number) => Promise<number>;
  /** Compact the chat as /compact does. */
  compact: (chatId: number, route: IdleRoute, workspaceSessionId: string | null) => Promise<{ ok: boolean }>;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

/** A turn ended: arm the timer when the route has the 1h cache. */
export function scheduleIdleCompaction(
  chatId: number,
  workspaceSessionId: string | null,
  deps: IdleCompactionDeps,
): void {
  const route = routes.get(chatId);
  const prev = timers.get(chatId);
  if (prev) clearTimeout(prev);
  timers.delete(chatId);
  if (disabled() || !route?.oneHourCache) return;
  const set = deps.setTimer ?? setTimeout;
  const armedAt = generation.get(chatId) ?? 0;
  const timer = set(() => {
    timers.delete(chatId);
    // The user came back (a newer turn started) or a turn is running: not now.
    if (deps.isLive(chatId) || (generation.get(chatId) ?? 0) !== armedAt) return;
    const job = (async () => {
      const tokens = await deps.historyTokens(chatId);
      if (tokens < IDLE_COMPACT_MIN_TOKENS) return;
      const done = await deps.compact(chatId, route, workspaceSessionId);
      logger.log(`[compaction] idle compaction of chat ${chatId} (${tokens} tokens, ~${IDLE_COMPACT_AFTER_MS / 60_000} min idle): ${done.ok ? "done" : "nothing compacted"}`);
    })().finally(() => running.delete(chatId));
    running.set(chatId, job);
  }, IDLE_COMPACT_AFTER_MS);
  (timer as { unref?: () => void }).unref?.();
  timers.set(chatId, timer);
}

/** Test seam. */
export function __resetIdleCompaction(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  routes.clear();
  running.clear();
  generation.clear();
}
