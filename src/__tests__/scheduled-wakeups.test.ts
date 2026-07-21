import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  scheduleWakeup,
  clampWakeupDelayMs,
  takePendingScheduledWakeupNudges,
  hasPendingScheduledWakeupNudges,
  clearScheduledWakeupsForChat,
  setScheduledWakeupNotifier,
} from "@/lib/agent/scheduled-wakeups";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("scheduled-wakeups (R1)", () => {
  it("clamps the delay to [60s, 14400s] (up to 4h)", () => {
    expect(clampWakeupDelayMs(1_000)).toBe(60_000); // below floor
    expect(clampWakeupDelayMs(99_000_000)).toBe(14_400_000); // above the 4h ceiling
    expect(clampWakeupDelayMs(9_000_000)).toBe(9_000_000); // 2.5h now in range (was clamped to 1h)
    expect(clampWakeupDelayMs(120_000)).toBe(120_000); // in range
    expect(clampWakeupDelayMs(Number.NaN)).toBe(60_000); // junk → floor
  });

  it("fires after the delay → notifies (source-agnostic) and queues a take-once nudge", () => {
    const chatId = 7001;
    clearScheduledWakeupsForChat(chatId);
    const statuses: string[] = [];
    setScheduledWakeupNotifier((cid, ev) => {
      if (cid === chatId) statuses.push(ev.status);
    });

    const res = scheduleWakeup(chatId, 90_000, "check the deploy");
    expect("id" in res && res.firesInMs).toBe(90_000);
    expect(hasPendingScheduledWakeupNudges(chatId)).toBe(false);

    // Before it fires: nothing.
    vi.advanceTimersByTime(60_000);
    expect(statuses).toHaveLength(0);

    // After it fires: a "scheduled" notify + a queued nudge carrying the note.
    vi.advanceTimersByTime(40_000);
    expect(statuses).toEqual(["scheduled"]);
    expect(hasPendingScheduledWakeupNudges(chatId)).toBe(true);

    const nudge = takePendingScheduledWakeupNudges(chatId)!;
    expect(nudge).toContain("[Scheduled re-check]");
    expect(nudge).toContain("check the deploy");
    // take-once
    expect(takePendingScheduledWakeupNudges(chatId)).toBeNull();

    clearScheduledWakeupsForChat(chatId);
  });

  it("caps outstanding wake-ups per chat", () => {
    const chatId = 7002;
    clearScheduledWakeupsForChat(chatId);
    for (let i = 0; i < 8; i++) {
      expect("id" in scheduleWakeup(chatId, 120_000, `n${i}`)).toBe(true);
    }
    const overflow = scheduleWakeup(chatId, 120_000, "too many");
    expect("error" in overflow).toBe(true);
    clearScheduledWakeupsForChat(chatId);
  });

  it("clear cancels pending timers (no fire after clear)", () => {
    const chatId = 7003;
    clearScheduledWakeupsForChat(chatId);
    const fired: string[] = [];
    setScheduledWakeupNotifier((cid, ev) => {
      if (cid === chatId) fired.push(ev.operationId);
    });
    scheduleWakeup(chatId, 120_000, "noop");
    clearScheduledWakeupsForChat(chatId);
    vi.advanceTimersByTime(600_000);
    expect(fired).toHaveLength(0);
    expect(hasPendingScheduledWakeupNudges(chatId)).toBe(false);
  });

  it("schedule_wakeup tool is registered, clamps, and needs chat context", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const tool = ToolRegistry.get("schedule_wakeup");
    expect(tool?.name).toBe("schedule_wakeup");
    // 5s requested → clamped up to the 60s floor.
    const ok = await tool!.handler({ delay_seconds: 5, _chatSessionId: 7004 });
    expect(ok).toMatchObject({ success: true, fires_in_seconds: 60 });
    // No chat context → graceful error, no throw.
    const noChat = await tool!.handler({ delay_seconds: 120 });
    expect(noChat).toMatchObject({ success: false });
    clearScheduledWakeupsForChat(7004);
  });
});
