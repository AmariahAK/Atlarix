/**
 * Credit exhaustion has to stop the WHOLE round, not just the child that hit it.
 *
 * THE GAP THIS FILE EXISTS TO CLOSE: nothing anywhere exercised a 402 through a
 * sub-agent, which is how a fan-out came to keep running after the wallet had
 * already refused it. With no clamp, each Astra call holds its full worst-case
 * reserve and concurrency is 5, so children refusing partway is the NORMAL path on a
 * modest balance rather than an edge case.
 *
 * Three mechanisms, tested where each one actually lives:
 *  - the limiter's queue, which cancellation never touched;
 *  - the per-chat latch, without which the model can simply spawn again;
 *  - the ordering between them, which is the part a naive implementation gets wrong.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireDelegationSlot,
  failQueuedDelegationsForChat,
  releaseDelegationSlot,
} from "@/lib/agents/delegation-limiter";
import {
  __resetCreditHaltsForTests,
  clearCreditHalt,
  creditHaltReason,
  markCreditExhausted,
} from "@/lib/agents/credit-halt";

const MAX = 5;

let chatSeq = 7000;
function freshTurn(): { chatId: number; turnId: string } {
  chatSeq += 1;
  return { chatId: chatSeq, turnId: `turn-${chatSeq}` };
}

/** Let queued promises settle without depending on real stagger timing. */
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("the delegation queue is drained, not left to start anyway", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.ATLARIX_DELEGATION_STAGGER_MS;
    // The stagger is irrelevant here and would only make the test slow.
    process.env.ATLARIX_DELEGATION_STAGGER_MS = "0";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ATLARIX_DELEGATION_STAGGER_MS;
    else process.env.ATLARIX_DELEGATION_STAGGER_MS = prev;
  });

  it("rejects a sibling parked behind the concurrency limit", async () => {
    const { chatId, turnId } = freshTurn();
    for (let i = 0; i < MAX; i++) await acquireDelegationSlot(chatId, turnId, MAX);

    let settled: "granted" | "rejected" | "pending" = "pending";
    const sixth = acquireDelegationSlot(chatId, turnId, MAX).then(
      () => {
        settled = "granted";
      },
      () => {
        settled = "rejected";
      },
    );
    await tick();
    expect(settled).toBe("pending");

    expect(failQueuedDelegationsForChat(chatId, new Error("wallet empty"))).toBe(1);
    await sixth;
    expect(settled).toBe("rejected");
  });

  it("does not grant the rejected sibling when a slot is later released", async () => {
    // `releaseDelegationSlot` drains the queue, so the parked sibling must be GONE
    // from it — not merely rejected — or a cancelled sibling freeing its slot would
    // hand it straight over and it would open its own 402-bound call against the
    // same empty wallet. Emptying the queue is what buys this; the slot deletion
    // below is a separate property with its own test.
    const { chatId, turnId } = freshTurn();
    for (let i = 0; i < MAX; i++) await acquireDelegationSlot(chatId, turnId, MAX);

    let granted = 0;
    const parked = acquireDelegationSlot(chatId, turnId, MAX).then(
      () => {
        granted += 1;
      },
      () => {},
    );
    await tick();

    failQueuedDelegationsForChat(chatId, new Error("wallet empty"));
    await parked;
    // Every running sibling now finishes and releases.
    for (let i = 0; i < MAX; i++) releaseDelegationSlot(chatId, turnId, MAX);
    await tick();

    expect(granted).toBe(0);
  });

  it("does not leave a later delegation waiting on a slot nobody will free", async () => {
    /**
     * WHAT THE SLOT DELETION IS ACTUALLY FOR — established by breaking the code and
     * watching this fail, because the test above passes with or without it.
     *
     * Rejecting the queue empties it but leaves the record holding `active: 5`. If
     * the record survives, the next delegation on that turn sees a full slot, parks
     * itself in the queue it just emptied, and waits forever: the five that were
     * counted are gone, so nothing will ever call `releaseDelegationSlot` for them.
     * A hung tool call is worse than a refused one — it has no message and no end.
     */
    const { chatId, turnId } = freshTurn();
    for (let i = 0; i < MAX; i++) await acquireDelegationSlot(chatId, turnId, MAX);
    const parked = acquireDelegationSlot(chatId, turnId, MAX).catch(() => {});
    await tick();
    failQueuedDelegationsForChat(chatId, new Error("wallet empty"));
    await parked;

    const outcome = await Promise.race([
      acquireDelegationSlot(chatId, turnId, MAX).then(
        () => "settled",
        () => "settled",
      ),
      new Promise((r) => setTimeout(() => r("hung"), 60)),
    ]);
    expect(outcome).toBe("settled");
  });

  it("leaves another chat's queue alone", async () => {
    const mine = freshTurn();
    const theirs = freshTurn();
    for (let i = 0; i < MAX; i++) {
      await acquireDelegationSlot(mine.chatId, mine.turnId, MAX);
      await acquireDelegationSlot(theirs.chatId, theirs.turnId, MAX);
    }
    const mineParked = acquireDelegationSlot(mine.chatId, mine.turnId, MAX).catch(
      () => "rejected",
    );
    let theirsSettled = false;
    const theirsParked = acquireDelegationSlot(
      theirs.chatId,
      theirs.turnId,
      MAX,
    ).then(
      () => {
        theirsSettled = true;
      },
      () => {
        theirsSettled = true;
      },
    );
    await tick();

    expect(failQueuedDelegationsForChat(mine.chatId, new Error("empty"))).toBe(1);
    expect(await mineParked).toBe("rejected");
    expect(theirsSettled).toBe(false);

    // Clean up the other chat so it does not leak into another test's slot map.
    failQueuedDelegationsForChat(theirs.chatId, new Error("teardown"));
    await theirsParked;
  });

  it("reports zero for a chat that never queued anything", () => {
    const { chatId } = freshTurn();
    expect(failQueuedDelegationsForChat(chatId, new Error("empty"))).toBe(0);
  });
});

describe("the per-chat credit latch", () => {
  afterEach(() => __resetCreditHaltsForTests());

  it("records the refusal and reports it back", () => {
    markCreditExhausted(41, "Your balance is used up. This turn needs at least $9.24.");
    expect(creditHaltReason(41)).toContain("balance is used up");
  });

  it("keeps the FIRST refusal — concurrent siblings must not reword it", () => {
    // Five children fail within a few hundred ms of each other. The first refusal
    // is the one that described the state the round actually stopped in, and it is
    // the one carrying the required amount; a later bare message must not replace it.
    markCreditExhausted(42, "first, with the figure");
    markCreditExhausted(42, "second, without one");
    expect(creditHaltReason(42)).toBe("first, with the figure");
  });

  it("is scoped per chat", () => {
    markCreditExhausted(43, "halted");
    expect(creditHaltReason(44)).toBeNull();
  });

  it("clears, so the next turn gets one real attempt after a top-up", () => {
    // The app cannot know whether the user topped up between turns, so a latch that
    // outlived its turn would strand a chat that has since been paid for.
    markCreditExhausted(45, "halted");
    clearCreditHalt(45);
    expect(creditHaltReason(45)).toBeNull();
  });

  it("treats a missing chat id as a no-op rather than throwing", () => {
    expect(() => markCreditExhausted(undefined, "halted")).not.toThrow();
    expect(creditHaltReason(undefined)).toBeNull();
    expect(() => clearCreditHalt(undefined)).not.toThrow();
  });
});
