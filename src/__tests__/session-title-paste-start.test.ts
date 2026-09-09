/**
 * A session that starts with a paste still gets a name.
 *
 * THE BUG, observed in the shipped app and confirmed against the live database:
 * two sessions — one 10 messages long, one 20 — were still called "Untitled".
 * Every other recent session was named. Both had the identical opening shape:
 * the first user message was nothing but
 *
 *   <atlarix-text-attachment filename="Pasted text · 33 lines" />
 *
 * which `stripContentForTitleSource` reduces to "". Two independent faults had to
 * line up, and each alone would have been survivable:
 *
 * 1. MAIN bailed with material in hand. `sessions:generate-title` correctly looks
 *    PAST an attachment-only user message — but when it is the only user message
 *    there is nothing to look past to, and the gate was
 *    `!firstUser || !firstAssistant`. It returned "Untitled" with a 289 KB
 *    assistant reply sitting unread, and its own `generateSimpleChatName` last
 *    resort — written to fall back to exactly that reply — was unreachable.
 *
 * 2. THE RENDERER burned its only attempt. `markTitleGenerated` was called BEFORE
 *    generating, so a first turn with nothing nameable in it closed the door for
 *    the life of the session. By turn two there was ample material; nothing ever
 *    asked again.
 *
 * These tests cover the second fault plus the naming rule the first depends on.
 * The retry is bounded: a session that truly cannot be named must stop asking
 * rather than spend a title call every turn forever.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  allowRetitleAfterFirstPromptEdit,
  markTitleGenerated,
  needsGeneratedTitle,
  noteTitleAttemptFailed,
} from "@/lib/workspace-session-title";

const CHAT = -201;

describe("a starved title attempt does not close the door", () => {
  beforeEach(() => {
    allowRetitleAfterFirstPromptEdit(CHAT);
  });

  it("asks again on the next turn when the first produced nothing", () => {
    expect(needsGeneratedTitle(CHAT)).toBe(true);
    noteTitleAttemptFailed(CHAT); // turn 1: first message was a bare attachment
    expect(needsGeneratedTitle(CHAT)).toBe(true);
  });

  it("stops once a real title lands", () => {
    noteTitleAttemptFailed(CHAT);
    markTitleGenerated(CHAT);
    expect(needsGeneratedTitle(CHAT)).toBe(false);
  });

  it("gives up after three fruitless attempts rather than asking forever", () => {
    // Unbounded retry would cost a title generation on every single turn of a
    // session that cannot be named — the opposite failure, and a paid one.
    noteTitleAttemptFailed(CHAT);
    noteTitleAttemptFailed(CHAT);
    expect(needsGeneratedTitle(CHAT)).toBe(true);
    noteTitleAttemptFailed(CHAT);
    expect(needsGeneratedTitle(CHAT)).toBe(false);
  });

  it("editing the first prompt reopens it, spent attempts and all", () => {
    noteTitleAttemptFailed(CHAT);
    noteTitleAttemptFailed(CHAT);
    noteTitleAttemptFailed(CHAT);
    expect(needsGeneratedTitle(CHAT)).toBe(false);
    allowRetitleAfterFirstPromptEdit(CHAT);
    expect(needsGeneratedTitle(CHAT)).toBe(true);
  });
});

describe("the attachment-only opening message", () => {
  it("strips to nothing, which is why the assistant side has to carry it", async () => {
    const { stripContentForTitleSource } = await import("@/utils/chat_naming");
    // Verbatim from the live database — both failing sessions opened with this.
    const pasted =
      '<atlarix-text-attachment filename="Pasted text · 33 lines" />';
    expect(stripContentForTitleSource(pasted, "user").trim()).toBe("");
  });

  it("still yields a usable name from the assistant reply alone", async () => {
    const { stripContentForTitleSource, generateSimpleChatName } = await import(
      "@/utils/chat_naming"
    );
    // The reply the handler had in hand and threw away.
    const reply =
      "<think>plan</think>I explored the workers-sdk repo and mapped the wrangler " +
      "packages before looking at the reported issue.";
    const visible = stripContentForTitleSource(reply, "assistant").trim();
    expect(visible).not.toBe("");
    const name = generateSimpleChatName(visible);
    expect(name.trim()).not.toBe("");
    expect(name).not.toBe("Untitled");
  });
});
