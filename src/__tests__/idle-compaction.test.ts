/**
 * Idle compaction (owner 2026-11-05; Claude Code compacts a long conversation
 * idle ~54 min, just before its 1h prompt cache expires).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDLE_COMPACT_AFTER_MS,
  IDLE_COMPACT_MIN_TOKENS,
  __resetIdleCompaction,
  noteIdleRoute,
  scheduleIdleCompaction,
  settleIdleCompaction,
} from "@/lib/context/idle-compaction";

const CHAT = -9;
let live = false;
let tokens = IDLE_COMPACT_MIN_TOKENS + 1;
const compact = vi.fn(async () => ({ ok: true }));
const deps = {
  isLive: () => live,
  historyTokens: async () => tokens,
  compact,
};

beforeEach(() => {
  vi.useFakeTimers();
  __resetIdleCompaction();
  compact.mockClear();
  live = false;
  tokens = IDLE_COMPACT_MIN_TOKENS + 1;
  delete process.env.ATLARIX_IDLE_COMPACTION;
});
afterEach(() => vi.useRealTimers());

const route1h = { oneHourCache: true, providerId: "anthropic", model: { provider: "anthropic", name: "claude-sonnet-5-5" } };

describe("idle compaction", () => {
  it("a long conversation on a 1h-cache route is compacted ~54 min after its last turn, as /compact does", async () => {
    noteIdleRoute(CHAT, route1h);
    scheduleIdleCompaction(CHAT, "sess-1", deps);
    await vi.advanceTimersByTimeAsync(IDLE_COMPACT_AFTER_MS - 1_000);
    expect(compact).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(compact).toHaveBeenCalledWith(CHAT, route1h, "sess-1");
    expect(IDLE_COMPACT_AFTER_MS).toBeLessThan(60 * 60 * 1000);
  });

  it("not on a route without the 1h cache, nor for a short conversation", async () => {
    noteIdleRoute(CHAT, { oneHourCache: false });
    scheduleIdleCompaction(CHAT, null, deps);
    await vi.advanceTimersByTimeAsync(IDLE_COMPACT_AFTER_MS);
    noteIdleRoute(CHAT, route1h);
    tokens = IDLE_COMPACT_MIN_TOKENS - 1;
    scheduleIdleCompaction(CHAT, null, deps);
    await vi.advanceTimersByTimeAsync(IDLE_COMPACT_AFTER_MS);
    expect(compact).not.toHaveBeenCalled();
  });

  it("never once the user came back (a newer turn started) or while a turn runs", async () => {
    noteIdleRoute(CHAT, route1h);
    scheduleIdleCompaction(CHAT, null, deps);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await settleIdleCompaction(CHAT); // the user sent a message
    await vi.advanceTimersByTimeAsync(IDLE_COMPACT_AFTER_MS);
    scheduleIdleCompaction(CHAT, null, deps);
    live = true;
    await vi.advanceTimersByTimeAsync(IDLE_COMPACT_AFTER_MS);
    expect(compact).not.toHaveBeenCalled();
  });

  it("a turn that starts while it runs waits for it to finish", async () => {
    let finish!: () => void;
    compact.mockImplementationOnce(() => new Promise((r) => (finish = () => r({ ok: true }))));
    noteIdleRoute(CHAT, route1h);
    scheduleIdleCompaction(CHAT, null, deps);
    await vi.advanceTimersByTimeAsync(IDLE_COMPACT_AFTER_MS);
    expect(compact).toHaveBeenCalledTimes(1);
    let settled = false;
    const turn = settleIdleCompaction(CHAT).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    finish();
    await turn;
    expect(settled).toBe(true);
  });

  it("ATLARIX_IDLE_COMPACTION=off turns it off", async () => {
    process.env.ATLARIX_IDLE_COMPACTION = "off";
    noteIdleRoute(CHAT, route1h);
    scheduleIdleCompaction(CHAT, null, deps);
    await vi.advanceTimersByTimeAsync(IDLE_COMPACT_AFTER_MS);
    expect(compact).not.toHaveBeenCalled();
  });
});
