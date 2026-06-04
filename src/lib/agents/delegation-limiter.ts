/**
 * Limits concurrent specialist delegations per parent turn to reduce peak load.
 */

const DEFAULT_MAX_CONCURRENT = 5;

type TurnSlot = {
  active: number;
  queue: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }>;
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

export function releaseDelegationSlot(chatId: number, turnId: string, maxConcurrent: number): void {
  const slot = slotsByKey.get(slotKey(chatId, turnId));
  if (!slot) return;
  slot.active = Math.max(0, slot.active - 1);
  drainQueue(slot, maxConcurrent);
  if (slot.active === 0 && slot.queue.length === 0) {
    slotsByKey.delete(slotKey(chatId, turnId));
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
    return;
  }
  onQueued?.();
  await new Promise<void>((resolve, reject) => {
    slot.queue.push({ resolve, reject });
  });
}

