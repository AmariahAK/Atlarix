import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  scheduleWakeup,
  clampWakeupDelayMs,
  takePendingScheduledWakeupNudges,
  hasPendingScheduledWakeupNudges,
  clearScheduledWakeupsForChat,
  setScheduledWakeupNotifier,
  setJobWakeup,
  adjustJobWakeup,
  getJobWakeupRemainingMs,
  cancelJobWakeups,
} from "@/lib/agent/scheduled-wakeups";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("scheduled-wakeups (R1)", () => {
  it("clamps the delay to at least 60s (no arbitrary upper cap)", () => {
    expect(clampWakeupDelayMs(1_000)).toBe(60_000); // below floor
    expect(clampWakeupDelayMs(99_000_000)).toBe(99_000_000); // no 4h ceiling
    expect(clampWakeupDelayMs(9_000_000)).toBe(9_000_000); // 2.5h
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

  describe("job-tied wake timers (Part 2)", () => {
    it("setJobWakeup dedupes: a second set replaces the first (one timer per job)", () => {
      const chatId = 7101;
      const jobId = "job-a";
      clearScheduledWakeupsForChat(chatId);

      const first = setJobWakeup(chatId, jobId, 120_000, "check A");
      expect("firesInMs" in first && first.firesInMs).toBe(120_000);
      expect(getJobWakeupRemainingMs(chatId, jobId)).toBe(120_000);

      // Advance a bit, then replace — remaining resets to the NEW delay, not additive.
      vi.advanceTimersByTime(30_000);
      const second = setJobWakeup(chatId, jobId, 90_000, "check A again");
      expect("firesInMs" in second && second.firesInMs).toBe(90_000);
      expect(getJobWakeupRemainingMs(chatId, jobId)).toBe(90_000);

      clearScheduledWakeupsForChat(chatId);
    });

    it("getJobWakeupRemainingMs counts down and returns null when absent", () => {
      const chatId = 7102;
      clearScheduledWakeupsForChat(chatId);
      expect(getJobWakeupRemainingMs(chatId, "nope")).toBeNull();

      setJobWakeup(chatId, "job-b", 100_000, "b");
      vi.advanceTimersByTime(40_000);
      expect(getJobWakeupRemainingMs(chatId, "job-b")).toBe(60_000);

      clearScheduledWakeupsForChat(chatId);
    });

    it("adjustJobWakeup moves firesAt off the remaining time and clamps", () => {
      const chatId = 7103;
      const jobId = "job-c";
      clearScheduledWakeupsForChat(chatId);
      expect(adjustJobWakeup(chatId, jobId, 30_000)).toBeNull(); // no timer yet

      setJobWakeup(chatId, jobId, 120_000, "c");
      vi.advanceTimersByTime(20_000); // 100_000 remaining
      const later = adjustJobWakeup(chatId, jobId, 30_000);
      expect(later && later.firesInMs).toBe(130_000);

      // Subtracting below the 60s floor clamps up to 60_000.
      const sooner = adjustJobWakeup(chatId, jobId, -999_000);
      expect(sooner && sooner.firesInMs).toBe(60_000);

      clearScheduledWakeupsForChat(chatId);
    });

    it("cancelJobWakeups clears the job's timer(s) and stops the fire", () => {
      const chatId = 7104;
      const jobId = "job-d";
      clearScheduledWakeupsForChat(chatId);
      setJobWakeup(chatId, jobId, 120_000, "d");
      expect(cancelJobWakeups(chatId, jobId)).toBe(1);
      expect(getJobWakeupRemainingMs(chatId, jobId)).toBeNull();

      vi.advanceTimersByTime(600_000);
      expect(hasPendingScheduledWakeupNudges(chatId)).toBe(false);
      clearScheduledWakeupsForChat(chatId);
    });

    it("a job finishing AFTER its timer fired purges the queued nudge", () => {
      // The reported bug: the countdown elapses, queueing a re-check nudge; the
      // job then delivers its result; the nudge is still drained on the next turn
      // and the model re-checks a job that is already done.
      //
      // The timer removes itself from the registry when it fires, so cancelling
      // "the job's timers" found nothing to cancel — the queued nudge has to be
      // purged too.
      const chatId = 7106;
      const jobId = "npm-test";
      clearScheduledWakeupsForChat(chatId);

      setJobWakeup(chatId, jobId, 90_000, "did the suite pass?");
      vi.advanceTimersByTime(90_000);
      expect(hasPendingScheduledWakeupNudges(chatId)).toBe(true);

      // Job finishes — this is what recordBackgroundCommandResult calls.
      expect(cancelJobWakeups(chatId, jobId)).toBe(1);

      expect(hasPendingScheduledWakeupNudges(chatId)).toBe(false);
      expect(takePendingScheduledWakeupNudges(chatId)).toBeNull();
      clearScheduledWakeupsForChat(chatId);
    });

    it("purging one job's nudge leaves other jobs' and free-standing nudges alone", () => {
      const chatId = 7107;
      clearScheduledWakeupsForChat(chatId);

      setJobWakeup(chatId, "job-x", 90_000, "check x");
      setJobWakeup(chatId, "job-y", 90_000, "check y");
      scheduleWakeup(chatId, 90_000, "unrelated self-wake");
      vi.advanceTimersByTime(90_000);

      // Only job-x finished.
      expect(cancelJobWakeups(chatId, "job-x")).toBe(1);

      const nudge = takePendingScheduledWakeupNudges(chatId)!;
      expect(nudge).not.toContain("check x");
      expect(nudge).toContain("check y");
      expect(nudge).toContain("unrelated self-wake");
      clearScheduledWakeupsForChat(chatId);
    });

    it("a fired job-tied wake-up names the job in its nudge", () => {
      const chatId = 7105;
      const jobId = "npm-run-dev";
      clearScheduledWakeupsForChat(chatId);
      setJobWakeup(chatId, jobId, 90_000, "is it listening yet?");
      vi.advanceTimersByTime(90_000);
      const nudge = takePendingScheduledWakeupNudges(chatId)!;
      expect(nudge).toContain(`job "${jobId}"`);
      expect(nudge).toContain("is it listening yet?");
      clearScheduledWakeupsForChat(chatId);
    });
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
