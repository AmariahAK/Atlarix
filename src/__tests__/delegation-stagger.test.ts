import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  acquireDelegationSlot,
  releaseDelegationSlot,
} from "@/lib/agents/delegation-limiter";

/**
 * Sub-agents spawned in one response share a system prefix. Launched together,
 * each is a cache MISS that pays to write that prefix; launched a beat apart,
 * the first writes it and the rest read it.
 *
 * The stagger is env-tunable so these tests can run at a few tens of ms rather
 * than the 750ms production default.
 */
const STAGGER_MS = 40;
const MAX = 5;

let chatSeq = 1000;
/** Fresh (chatId, turnId) per test — slot state is keyed by the pair. */
function freshTurn(): { chatId: number; turnId: string } {
  chatSeq += 1;
  return { chatId: chatSeq, turnId: `turn-${chatSeq}` };
}

describe("delegation stagger", () => {
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.ATLARIX_DELEGATION_STAGGER_MS;
    process.env.ATLARIX_DELEGATION_STAGGER_MS = String(STAGGER_MS);
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.ATLARIX_DELEGATION_STAGGER_MS;
    else process.env.ATLARIX_DELEGATION_STAGGER_MS = prev;
  });

  it("does not delay the first delegation of a turn — it writes the prefix", async () => {
    const { chatId, turnId } = freshTurn();
    const t0 = Date.now();
    await acquireDelegationSlot(chatId, turnId, MAX);
    expect(Date.now() - t0).toBeLessThan(STAGGER_MS);
    releaseDelegationSlot(chatId, turnId, MAX);
  });

  it("spaces same-turn siblings so they don't all pay a cache write", async () => {
    const { chatId, turnId } = freshTurn();
    const starts: number[] = [];
    const t0 = Date.now();

    await Promise.all(
      Array.from({ length: 4 }, () =>
        acquireDelegationSlot(chatId, turnId, MAX).then(() => {
          starts.push(Date.now() - t0);
        }),
      ),
    );

    starts.sort((a, b) => a - b);
    expect(starts).toHaveLength(4);
    // First is immediate; each subsequent one is at least one stagger later.
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(
        STAGGER_MS * 0.7,
      );
    }
    for (let i = 0; i < 4; i++) releaseDelegationSlot(chatId, turnId, MAX);
  });

  it("does not make different turns wait on each other", async () => {
    const a = freshTurn();
    const b = freshTurn();
    await acquireDelegationSlot(a.chatId, a.turnId, MAX);

    const t0 = Date.now();
    await acquireDelegationSlot(b.chatId, b.turnId, MAX);
    // Different turn → different slot → first-of-turn, so no wait.
    expect(Date.now() - t0).toBeLessThan(STAGGER_MS);

    releaseDelegationSlot(a.chatId, a.turnId, MAX);
    releaseDelegationSlot(b.chatId, b.turnId, MAX);
  });

  it("is fully disabled at 0", async () => {
    process.env.ATLARIX_DELEGATION_STAGGER_MS = "0";
    const { chatId, turnId } = freshTurn();
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 4 }, () =>
        acquireDelegationSlot(chatId, turnId, MAX),
      ),
    );
    expect(Date.now() - t0).toBeLessThan(STAGGER_MS);
    for (let i = 0; i < 4; i++) releaseDelegationSlot(chatId, turnId, MAX);
  });

  it("still enforces the concurrency cap — a 6th waits for a release", async () => {
    process.env.ATLARIX_DELEGATION_STAGGER_MS = "0";
    const { chatId, turnId } = freshTurn();
    for (let i = 0; i < MAX; i++) {
      await acquireDelegationSlot(chatId, turnId, MAX);
    }

    let granted = false;
    let queuedCalled = false;
    const sixth = acquireDelegationSlot(chatId, turnId, MAX, () => {
      queuedCalled = true;
    }).then(() => {
      granted = true;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(queuedCalled).toBe(true);
    expect(granted).toBe(false);

    releaseDelegationSlot(chatId, turnId, MAX);
    await sixth;
    expect(granted).toBe(true);

    for (let i = 0; i < MAX; i++) releaseDelegationSlot(chatId, turnId, MAX);
  });

  it("staggers a delegation that was queued behind the cap", async () => {
    const { chatId, turnId } = freshTurn();
    for (let i = 0; i < MAX; i++) {
      await acquireDelegationSlot(chatId, turnId, MAX);
    }

    releaseDelegationSlot(chatId, turnId, MAX);
    const t0 = Date.now();
    await acquireDelegationSlot(chatId, turnId, MAX);
    // The freed slot's predecessor started moments ago, so this one spaces off it.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(STAGGER_MS * 0.7);

    for (let i = 0; i < MAX; i++) releaseDelegationSlot(chatId, turnId, MAX);
  });
});
