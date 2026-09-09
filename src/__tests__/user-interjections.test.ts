/**
 * The mid-turn user-message queue.
 *
 * Mirrors `subagent-results.test.ts`, and pins the same invariant every sibling
 * store depends on: `takePending…` is destructive and `hasPending…` is not.
 * Conflating the two is how a single-consumer channel grows a second consumer
 * and starts losing payloads — here the payload is the user's own words, which
 * is the worst thing in the app to lose.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  recordUserInterjection,
  takePendingUserInterjections,
  takeUserInterjectionsAsPrompt,
  hasPendingUserInterjections,
  listPendingUserInterjections,
  cancelUserInterjection,
  clearUserInterjections,
  setUserInterjectionNotifier,
} from "@/lib/agent/user-interjections";

const A = -101;
const B = -202;

describe("user-interjections", () => {
  beforeEach(() => {
    setUserInterjectionNotifier(() => {});
    clearUserInterjections(A);
    clearUserInterjections(B);
  });

  it("records and drains oldest-first", () => {
    recordUserInterjection(A, { id: "1", text: "do the thing" });
    recordUserInterjection(A, { id: "2", text: "actually, skip step 3" });
    const taken = takePendingUserInterjections(A);
    // ORDER IS THE POINT: a correction that followed a request must still read
    // after it, or the model acts on the correction with no idea what it edits.
    expect(taken?.map((m) => m.text)).toEqual([
      "do the thing",
      "actually, skip step 3",
    ]);
  });

  it("takes once — a second drain finds nothing", () => {
    recordUserInterjection(A, { id: "1", text: "hi" });
    expect(takePendingUserInterjections(A)).not.toBeNull();
    expect(takePendingUserInterjections(A)).toBeNull();
  });

  it("hasPending does NOT drain", () => {
    recordUserInterjection(A, { id: "1", text: "hi" });
    expect(hasPendingUserInterjections(A)).toBe(true);
    expect(hasPendingUserInterjections(A)).toBe(true);
    // Still deliverable after two peeks — the whole reason the split exists.
    expect(takePendingUserInterjections(A)?.length).toBe(1);
  });

  it("listPending does NOT drain either (it feeds the composer chip)", () => {
    recordUserInterjection(A, { id: "1", text: "hi" });
    expect(listPendingUserInterjections(A)).toHaveLength(1);
    expect(listPendingUserInterjections(A)).toHaveLength(1);
    expect(takePendingUserInterjections(A)).not.toBeNull();
  });

  it("isolates chats", () => {
    recordUserInterjection(A, { id: "1", text: "for A" });
    recordUserInterjection(B, { id: "2", text: "for B" });
    expect(takePendingUserInterjections(A)?.map((m) => m.text)).toEqual([
      "for A",
    ]);
    expect(takePendingUserInterjections(B)?.map((m) => m.text)).toEqual([
      "for B",
    ]);
  });

  it("is idempotent on id, so a renderer retry cannot double-deliver", () => {
    recordUserInterjection(A, { id: "same", text: "once" });
    recordUserInterjection(A, { id: "same", text: "once" });
    expect(takePendingUserInterjections(A)).toHaveLength(1);
  });

  it("ignores empty and whitespace-only text", () => {
    expect(recordUserInterjection(A, { id: "1", text: "   " })).toBeNull();
    expect(hasPendingUserInterjections(A)).toBe(false);
  });

  it("cancels one and leaves the rest", () => {
    recordUserInterjection(A, { id: "1", text: "keep" });
    recordUserInterjection(A, { id: "2", text: "drop" });
    expect(cancelUserInterjection(A, "2")).toBe(true);
    expect(takePendingUserInterjections(A)?.map((m) => m.text)).toEqual([
      "keep",
    ]);
  });

  it("reports false when cancelling something already delivered", () => {
    recordUserInterjection(A, { id: "1", text: "gone" });
    takePendingUserInterjections(A);
    // Not an error — just too late. The UI treats it as "already sent".
    expect(cancelUserInterjection(A, "1")).toBe(false);
  });

  it("the prompt drain shares the take-once counter with the mid-turn drain", () => {
    recordUserInterjection(A, { id: "1", text: "one" });
    recordUserInterjection(A, { id: "2", text: "two" });
    // This is the property that makes "delivered mid-turn OR opens the next
    // turn, never both" true: the stream-end flush and the step drain are the
    // same take.
    expect(takeUserInterjectionsAsPrompt(A)).toBe("one\n\ntwo");
    expect(takePendingUserInterjections(A)).toBeNull();
    expect(takeUserInterjectionsAsPrompt(A)).toBeNull();
  });

  it("notifies on every mutation, with the current queue", () => {
    const seen: number[] = [];
    setUserInterjectionNotifier((chatId, pending) => {
      if (chatId === A) seen.push(pending.length);
    });
    recordUserInterjection(A, { id: "1", text: "a" });
    recordUserInterjection(A, { id: "2", text: "b" });
    cancelUserInterjection(A, "1");
    takePendingUserInterjections(A);
    expect(seen).toEqual([1, 2, 1, 0]);
  });

  it("caps the queue rather than growing without bound", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 45; i++) {
      recordUserInterjection(A, { id: `m${i}`, text: `m${i}` });
    }
    const taken = takePendingUserInterjections(A);
    expect(taken).toHaveLength(40);
    // The OLDEST go, and it is logged — a silent drop of the user's words is
    // the thing this must never do quietly.
    expect(taken?.[0]?.text).toBe("m5");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
