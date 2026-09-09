/**
 * Telling the model when its history was reduced.
 *
 * THE BUG (confirmed from production logs): a Core session on a 1,000,000-token
 * window went
 *
 *   15:22:21  Total tokens used: 124,907
 *   15:22:46  Limiting chat history from 23 to 21 messages (max 11 turns)
 *   15:23:45  Total tokens used:  57,832
 *
 * Half the conversation deleted at 8.9% context fill, because it crossed ELEVEN
 * TURNS. Not compaction — outright deletion, with no card for the user and no
 * signal to the MODEL, which kept answering as though it still remembered.
 *
 * The count cap is now GONE (see dropped-history-notice.ts for why it could not
 * simply be gated), so the only remaining way history shrinks is the token budget.
 * What is tested here is the half that must survive: a reduction is never silent.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetDroppedHistoryNoticesForTests,
  droppedHistoryNotice,
  queueDroppedHistoryNotice,
  takePendingDroppedHistoryNotice,
} from "@/lib/context/dropped-history-notice";

describe("droppedHistoryNotice", () => {
  it("states the loss and points at a way to RECOVER it, not at the user", () => {
    const notice = droppedHistoryNotice(12);
    expect(notice).toContain("12 earlier messages");
    expect(notice).toContain("removed to fit the context window");
    // The instruction not to trust recall is the point of the notice.
    expect(notice).toMatch(/do not assume you still have that detail/i);
    // v14.39: it used to say "re-read the relevant files or ask the user", which
    // was the harness conceding it had no recall path and charging the cost to
    // whoever was waiting. The transcript was always on disk; it just had no tool.
    expect(notice).toContain("session_search");
    expect(notice).not.toMatch(/ask the user to repeat/i);
  });

  it("uses singular wording for a single message", () => {
    const notice = droppedHistoryNotice(1);
    expect(notice).toContain(
      "1 earlier message in this conversation was removed",
    );
    expect(notice).not.toContain("messages");
  });
});

describe("dropped-history notice queue", () => {
  beforeEach(__resetDroppedHistoryNoticesForTests);

  it("delivers the notice to the chat that lost history", () => {
    queueDroppedHistoryNotice(1, 12);
    expect(takePendingDroppedHistoryNotice(1)).toContain("12 earlier messages");
  });

  it("is take-once, so the warning cannot repeat on every step", () => {
    queueDroppedHistoryNotice(1, 4);
    expect(takePendingDroppedHistoryNotice(1)).not.toBeNull();
    expect(takePendingDroppedHistoryNotice(1)).toBeNull();
  });

  it("accumulates when the budget trims more than once before a dispatch", () => {
    // The model should hear one honest total, not two partial claims.
    queueDroppedHistoryNotice(1, 3);
    queueDroppedHistoryNotice(1, 5);
    expect(takePendingDroppedHistoryNotice(1)).toContain("8 earlier messages");
  });

  it("is scoped per chat", () => {
    queueDroppedHistoryNotice(1, 2);
    expect(takePendingDroppedHistoryNotice(2)).toBeNull();
    expect(takePendingDroppedHistoryNotice(1)).not.toBeNull();
  });

  it("queues nothing when nothing was dropped", () => {
    queueDroppedHistoryNotice(1, 0);
    expect(takePendingDroppedHistoryNotice(1)).toBeNull();
  });
});
