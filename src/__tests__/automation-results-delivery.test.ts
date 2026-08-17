/**
 * A finished automation must actually REACH the model.
 *
 * Reported 2026-08-17: an automation with `notifyAgent=true` ran three times,
 * every run logged `finished: ok`, and the model was never told. The result was
 * recorded correctly — what was missing was anyone draining it.
 *
 * Automations deliberately do NOT wake a turn (background work must never
 * re-animate a turn the user stopped), so delivery depends entirely on the next
 * turn draining the queue. That turn is a NON-wake turn, and the non-wake path
 * had exactly two loaders — background commands and sub-agents. There was no
 * automation loader, so the queue only ever grew.
 *
 * The failure had no symptom of its own: the automation ran, the feed row
 * appeared, the notification fired. Only the model was silent. So the drain is
 * pinned here rather than left to be noticed again.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** `workspaceForChat` resolves through the stream transport — stub that seam. */
const appIdByChat = new Map<number, number>();
vi.mock("@/lib/chat/stream-transport", () => ({
  getStreamTransportAppId: (chatId: number) => appIdByChat.get(chatId),
}));

import {
  recordAutomationResult,
  takePendingAutomationResults,
  hasPendingAutomationResults,
  clearAutomationResultsForTests,
} from "@/lib/agent/automation-results";

const CHAT = -28;
const OTHER_CHAT = -29;
const WORKSPACE = 7;

function result(over: Partial<Parameters<typeof recordAutomationResult>[1]> = {}) {
  return {
    automationId: "a1",
    automationName: "Temporary automation test",
    status: "ok" as const,
    body: "Found 2 failing checks on main.",
    finishedAt: Date.now(),
    ...over,
  };
}

describe("automation results reach the next turn", () => {
  beforeEach(() => {
    clearAutomationResultsForTests();
    appIdByChat.clear();
    appIdByChat.set(CHAT, WORKSPACE);
  });

  it("delivers a recorded run to a chat in the same workspace", () => {
    recordAutomationResult(WORKSPACE, result());
    expect(hasPendingAutomationResults(CHAT)).toBe(true);

    const body = takePendingAutomationResults(CHAT);
    expect(body).toContain("Temporary automation test");
    expect(body).toContain("Found 2 failing checks on main.");
  });

  /**
   * KEYED BY WORKSPACE, not by chat — an automation fires on a timer with no
   * conversation in view, so the chat that will collect it may not exist yet.
   */
  it("delivers to whichever chat in that workspace takes the next turn", () => {
    recordAutomationResult(WORKSPACE, result());
    appIdByChat.set(OTHER_CHAT, WORKSPACE);
    expect(takePendingAutomationResults(OTHER_CHAT)).toContain("Temporary automation test");
  });

  /** Take-once: a second consumer must not re-deliver the same run. */
  it("drains exactly once", () => {
    recordAutomationResult(WORKSPACE, result());
    expect(takePendingAutomationResults(CHAT)).toBeTruthy();
    expect(takePendingAutomationResults(CHAT)).toBeNull();
    expect(hasPendingAutomationResults(CHAT)).toBe(false);
  });

  it("does not leak into a different workspace", () => {
    recordAutomationResult(WORKSPACE, result());
    appIdByChat.set(OTHER_CHAT, 99);
    expect(hasPendingAutomationResults(OTHER_CHAT)).toBe(false);
    expect(takePendingAutomationResults(OTHER_CHAT)).toBeNull();
  });

  it("batches several finished runs into one delivery", () => {
    recordAutomationResult(WORKSPACE, result({ automationName: "CI watch" }));
    recordAutomationResult(WORKSPACE, result({ automationName: "PR watch" }));
    const body = takePendingAutomationResults(CHAT);
    expect(body).toContain("CI watch");
    expect(body).toContain("PR watch");
  });

  it("carries an error run through as an error", () => {
    recordAutomationResult(
      WORKSPACE,
      result({ status: "error", body: "git fetch failed: host unreachable" }),
    );
    const body = takePendingAutomationResults(CHAT);
    expect(body).toContain("(error)");
    expect(body).toContain("host unreachable");
  });

  it("returns nothing when the chat's workspace cannot be resolved", () => {
    recordAutomationResult(WORKSPACE, result());
    expect(hasPendingAutomationResults(-999)).toBe(false);
    expect(takePendingAutomationResults(-999)).toBeNull();
  });
});
