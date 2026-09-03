/**
 * A system wake must never interrupt a live turn, or resurrect a stopped chat.
 *
 * The incident this exists for (2026-08-17, packaged v14.32.0): two windows on
 * DIFFERENT projects, and the `vite` turn restarted 84 times in six minutes with
 * 80 `superseded_stream` aborts, beachballing the app. The interval grew each
 * round — 0.75s → 2.1s → 6.5s — because every discarded turn lengthened the
 * history and made the next context assembly heavier.
 *
 * Cause: the renderer's background-job listener keys on the chat id in the EVENT,
 * not the chat its window is showing, while its three guards all read per-window
 * state (a jotai store and two hook refs). The second window looked up a chat it
 * had never seen, found nothing, concluded "not streaming", and woke a chat the
 * first window was mid-turn on. Each superseded end then fired the other window's
 * race-closer.
 *
 * So the decision moved to main, which is the only side that can answer it. These
 * tests cover the decision itself; the cross-window property is what they encode,
 * because no amount of renderer-side guarding could have produced it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", isPackaged: false },
  powerSaveBlocker: { start: () => 1, stop: () => undefined, isStarted: () => false },
}));
vi.mock("electron-log", () => {
  const scope = () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  });
  return { default: { scope, ...scope() } };
});
vi.mock("@/main/settings", () => ({ readSettings: () => ({}) }));

import {
  shouldDropSystemWake,
  isChatStreamLive,
  isChatUserStopped,
  markChatUserStopped,
  clearChatUserStopped,
  shouldClearUserStopLatch,
  activeStreams,
  activeStreamRuns,
} from "@/ipc/handlers/chat_stream/stream-state";

const CHAT = -28;

describe("shouldDropSystemWake", () => {
  it("drops a wake at a chat that is already streaming", () => {
    expect(
      shouldDropSystemWake(
        { systemWake: true },
        { isStreaming: true, userStopped: false },
      ),
    ).toBe("already-streaming");
  });

  it("drops a wake at a chat the user stopped", () => {
    expect(
      shouldDropSystemWake(
        { systemWake: true },
        { isStreaming: false, userStopped: true },
      ),
    ).toBe("user-stopped");
  });

  it("allows a wake at an idle chat — that is the whole point of a wake", () => {
    expect(
      shouldDropSystemWake(
        { systemWake: true },
        { isStreaming: false, userStopped: false },
      ),
    ).toBeNull();
  });

  /**
   * The regression that would matter most: a user message must still supersede a
   * running turn. That is the user redirecting the agent, and breaking it would
   * be far worse than the bug being fixed.
   */
  it("NEVER drops a user turn, whatever the chat is doing", () => {
    for (const state of [
      { isStreaming: true, userStopped: false },
      { isStreaming: false, userStopped: true },
      { isStreaming: true, userStopped: true },
      { isStreaming: false, userStopped: false },
    ]) {
      expect(shouldDropSystemWake({}, state)).toBeNull();
      expect(shouldDropSystemWake({ systemWake: false }, state)).toBeNull();
    }
  });

  it("reports streaming ahead of stopped when both are true", () => {
    expect(
      shouldDropSystemWake(
        { systemWake: true },
        { isStreaming: true, userStopped: true },
      ),
    ).toBe("already-streaming");
  });
});

describe("isChatStreamLive", () => {
  beforeEach(() => {
    activeStreams.delete(CHAT);
    activeStreamRuns.delete(CHAT);
  });

  it("is false for a chat with nothing running", () => {
    expect(isChatStreamLive(CHAT)).toBe(false);
  });

  it("is true while a controller is registered", () => {
    activeStreams.set(CHAT, new AbortController());
    expect(isChatStreamLive(CHAT)).toBe(true);
    activeStreams.delete(CHAT);
  });

  /**
   * Both maps matter. `activeStreams` is cleared on abort while the run promise
   * is still settling, and it is exactly that window — a turn aborted but not yet
   * finished — where a wake used to slip in.
   */
  it("is true while only the run promise is outstanding", () => {
    activeStreamRuns.set(CHAT, Promise.resolve());
    expect(isChatStreamLive(CHAT)).toBe(true);
    activeStreamRuns.delete(CHAT);
  });
});

describe("the user-stopped latch", () => {
  beforeEach(() => clearChatUserStopped(CHAT));

  it("holds until the user sends something, not for a fixed interval", () => {
    expect(isChatUserStopped(CHAT)).toBe(false);
    markChatUserStopped(CHAT);
    expect(isChatUserStopped(CHAT)).toBe(true);
    // Still latched after any number of wake attempts.
    expect(
      shouldDropSystemWake(
        { systemWake: true },
        { isStreaming: false, userStopped: isChatUserStopped(CHAT) },
      ),
    ).toBe("user-stopped");
    clearChatUserStopped(CHAT);
    expect(isChatUserStopped(CHAT)).toBe(false);
  });

  it("is per chat — stopping one does not silence another", () => {
    markChatUserStopped(CHAT);
    expect(isChatUserStopped(-29)).toBe(false);
    clearChatUserStopped(CHAT);
  });
});

/**
 * The two-window scenario, expressed against main's state rather than a
 * renderer's. Window B's per-window view is irrelevant here — and that is the
 * fix: the answer no longer depends on which window is asking.
 */
describe("the two-window incident", () => {
  beforeEach(() => {
    activeStreams.delete(CHAT);
    activeStreamRuns.delete(CHAT);
    clearChatUserStopped(CHAT);
  });

  it("a second window's wake cannot interrupt the first window's live turn", () => {
    activeStreams.set(CHAT, new AbortController());
    // Window B knows nothing about chat -28; it asks anyway. Main answers.
    const verdict = shouldDropSystemWake(
      { systemWake: true },
      { isStreaming: isChatStreamLive(CHAT), userStopped: isChatUserStopped(CHAT) },
    );
    expect(verdict).toBe("already-streaming");
    activeStreams.delete(CHAT);
  });

  it("a Stop in one window silences wakes dispatched from another", () => {
    // `chat:cancel` sends its end event to `event.sender` alone, so the OTHER
    // window kept a "not stopped" view and would restart the agent.
    markChatUserStopped(CHAT);
    expect(
      shouldDropSystemWake(
        { systemWake: true },
        { isStreaming: isChatStreamLive(CHAT), userStopped: isChatUserStopped(CHAT) },
      ),
    ).toBe("user-stopped");
  });

  it("once the turn finishes and the user is back, a wake proceeds", () => {
    expect(
      shouldDropSystemWake(
        { systemWake: true },
        { isStreaming: isChatStreamLive(CHAT), userStopped: isChatUserStopped(CHAT) },
      ),
    ).toBeNull();
  });
});

/**
 * Releasing the latch — the other half of the same decision, and the half that
 * was wrong.
 *
 * OBSERVED 2026-09-03 (packaged v14.41.0): a chat that went through ONE
 * `ask_user` round was latched `user-stopped` for the rest of its life. Closing
 * the question flow aborts the stream, which latches the stop; the answer turn
 * arrives as `{ prompt: "", continueAfterQuestions: true }` because the answers
 * are persisted as their own user message — so the old
 * `prompt.trim().length > 0` rule could not clear it.
 *
 * Five sub-agents then finished over five minutes and every single wake was
 * refused: `[wake] dropped system wake for chat -42: user-stopped` ×5. Their
 * results survived (they queue, and drain on the next turn) but arrived only
 * when the user TYPED. Background commands, automations and scheduled
 * self-wakes all lose eager delivery through the same latch.
 */
describe("shouldClearUserStopLatch", () => {
  it("clears on a typed message", () => {
    expect(shouldClearUserStopLatch({})).toBe(true);
  });

  it("clears when the user ANSWERS questions — an empty prompt, but user-driven", () => {
    // `InlineUserQuestions.tsx` sends `{ prompt: "", continueAfterQuestions: true }`;
    // the answers are their own persisted message. This is the case that was
    // broken, and it is why the rule cannot key on prompt content.
    expect(shouldClearUserStopLatch({ systemWake: undefined })).toBe(true);
  });

  it("NEVER clears for a system wake — a wake must not lift its own suppression", () => {
    // The property the old rule was protecting, kept by the correct discriminator.
    expect(shouldClearUserStopLatch({ systemWake: true })).toBe(false);
  });

  it("a wake cannot clear the latch and then be admitted", () => {
    // End to end over the two pure guards: a background job reporting in must
    // not resurrect a chat the user stopped, no matter the order of checks.
    markChatUserStopped(CHAT);
    const wake = { systemWake: true };
    expect(shouldClearUserStopLatch(wake)).toBe(false);
    expect(
      shouldDropSystemWake(wake, {
        isStreaming: false,
        userStopped: isChatUserStopped(CHAT),
      }),
    ).toBe("user-stopped");
    clearChatUserStopped(CHAT);
  });

  it("a user action clears the latch, so the NEXT wake is admitted", () => {
    // The regression this fixes: after one ask_user round the chat could never
    // be woken again by anything.
    markChatUserStopped(CHAT);
    expect(isChatUserStopped(CHAT)).toBe(true);
    if (shouldClearUserStopLatch({ systemWake: undefined })) {
      clearChatUserStopped(CHAT);
    }
    expect(isChatUserStopped(CHAT)).toBe(false);
    expect(
      shouldDropSystemWake(
        { systemWake: true },
        { isStreaming: false, userStopped: isChatUserStopped(CHAT) },
      ),
    ).toBeNull();
  });
});
