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
