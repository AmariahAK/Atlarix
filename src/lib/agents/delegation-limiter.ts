/**
 * Limits concurrent specialist delegations per parent turn to reduce peak load,
 * and staggers same-turn siblings so they share a provider prompt-cache prefix
 * instead of each paying to write it.
 */

const DEFAULT_MAX_CONCURRENT = 5;

/**
 * Minimum spacing between two delegation starts in the same turn.
 *
 * Sub-agents spawned in one response share a system prefix. Launched together,
 * every one of them is a cache MISS that pays to write that prefix; launched a
 * beat apart, the first writes it and the rest read it. On Atlarix Core — a
 * prepaid wallet metered at +80% — that difference is the user's money.
 *
 * Deliberately NOT gated on `resolveCacheMarkerPlacement`: that only reports
 * whether we place EXPLICIT markers (Claude family). DeepSeek, Z.AI and OpenAI
 * cache prefixes automatically with no marker at all, and those are precisely
 * the Core providers where the saving lands. Gating on markers would skip them.
 *
 * Set ATLARIX_DELEGATION_STAGGER_MS=0 to disable.
 */
const DEFAULT_STAGGER_MS = 750;

function staggerMs(): number {
  const raw = process.env.ATLARIX_DELEGATION_STAGGER_MS;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_STAGGER_MS;
}

type TurnSlot = {
  active: number;
  queue: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }>;
  /**
   * Earliest timestamp the NEXT delegation of this turn may start. Undefined
   * until the first one is granted — that one never waits, since it is the
   * request whose prefix the others will read.
   */
  nextGrantEarliestAt?: number;
};

const slotsByKey = new Map<string, TurnSlot>();

function slotKey(chatId: number, turnId: string): string {
  return `${chatId}:${turnId}`;
}

function getSlot(chatId: number, turnId: string): TurnSlot {
  const key = slotKey(chatId, turnId);
  let slot = slotsByKey.get(key);
  if (!slot) {
    slot = { active: 0, queue: [] };
    slotsByKey.set(key, slot);
  }
  return slot;
}

function drainQueue(slot: TurnSlot, maxConcurrent: number): void {
  while (slot.active < maxConcurrent && slot.queue.length > 0) {
    const next = slot.queue.shift();
    if (!next) break;
    slot.active += 1;
    next.resolve();
  }
}

/**
 * Fail every delegation parked in this CHAT's queues. Returns the count rejected.
 *
 * WHY THIS IS NEEDED AT ALL. Cancelling the running sub-agents does not touch this
 * queue: a parked delegation is a pending promise, and the moment a cancelled sibling
 * releases its slot, `drainQueue` resolves the next one and it opens a fresh call
 * against the same empty wallet. With concurrency 5 and a per-turn cap of 5, that is
 * every remaining sibling. `reject` was declared on the queue entry from the start and
 * never called from anywhere — this is the path it was always for.
 *
 * SCOPED BY CHAT, NOT TURN, deliberately. It has to line up with
 * `cancelAllSubagentTasksForChat`, and the caller that matters most — the parent
 * turn's own 402 handler — holds no turn id at all. A chat runs one stream at a
 * time (`activeStreams` is keyed by chat), so the chat's queues are this turn's
 * queues.
 *
 * Each slot is deleted rather than left empty so a late `releaseDelegationSlot`
 * cannot resurrect it and drain a queue we have just emptied.
 */
export function failQueuedDelegationsForChat(
  chatId: number,
  error: Error,
): number {
  const prefix = `${chatId}:`;
  let rejected = 0;
  for (const [key, slot] of [...slotsByKey.entries()]) {
    if (!key.startsWith(prefix)) continue;
    const queued = slot.queue.splice(0, slot.queue.length);
    for (const entry of queued) entry.reject(error);
    slotsByKey.delete(key);
    rejected += queued.length;
  }
  return rejected;
}

export function releaseDelegationSlot(
  chatId: number,
  turnId: string,
  maxConcurrent: number,
): void {
  const slot = slotsByKey.get(slotKey(chatId, turnId));
  if (!slot) return;
  slot.active = Math.max(0, slot.active - 1);
  drainQueue(slot, maxConcurrent);
  if (slot.active === 0 && slot.queue.length === 0) {
    slotsByKey.delete(slotKey(chatId, turnId));
  }
}

/**
 * Hold this delegation back until it is at least `staggerMs()` after the
 * previous start in the same turn. Called only once a slot is already held, so
 * `active` is non-zero and `releaseDelegationSlot` cannot delete the slot from
 * under the wait.
 */
async function applyStagger(slot: TurnSlot): Promise<void> {
  const ms = staggerMs();
  if (ms <= 0) return;
  const now = Date.now();
  if (slot.nextGrantEarliestAt == null) {
    // First of the turn: it writes the prefix, so it must not be delayed.
    slot.nextGrantEarliestAt = now + ms;
    return;
  }
  const waitFor = slot.nextGrantEarliestAt - now;
  // Reserve this delegation's place before awaiting, so concurrent callers
  // space out against each other rather than all reading the same deadline.
  slot.nextGrantEarliestAt = Math.max(now, slot.nextGrantEarliestAt) + ms;
  if (waitFor > 0) {
    await new Promise((r) => setTimeout(r, waitFor));
  }
}

/** Wait until this delegation may start; call `releaseDelegationSlot` in finally. */
export async function acquireDelegationSlot(
  chatId: number,
  turnId: string,
  maxConcurrent: number = DEFAULT_MAX_CONCURRENT,
  onQueued?: () => void,
): Promise<void> {
  const slot = getSlot(chatId, turnId);
  if (slot.active < maxConcurrent) {
    slot.active += 1;
    await applyStagger(slot);
    return;
  }
  onQueued?.();
  await new Promise<void>((resolve, reject) => {
    slot.queue.push({ resolve, reject });
  });
  // A queued delegation waited for capacity, but the one that freed the slot may
  // have started moments ago — space this one off that start too.
  await applyStagger(slot);
}
