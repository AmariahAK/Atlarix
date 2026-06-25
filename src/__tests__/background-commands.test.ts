import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordBackgroundCommandStart,
  recordBackgroundCommandResult,
  takePendingBackgroundCommandResults,
  hasRunningBackgroundCommands,
  clearBackgroundCommandsForChat,
  listBackgroundJobs,
  killBackgroundJob,
  readBackgroundOutput,
  updateBackgroundOutput,
  setBackgroundJobNotifier,
  takePendingStalledAdvisories,
  hasPendingStalledAdvisories,
  killAllBackgroundJobs,
} from "@/lib/agent/background-commands";

describe("background-commands (v13 7A / v14 jobs)", () => {
  it("records, drains take-once, and tracks running state", () => {
    const chatId = 9001;
    recordBackgroundCommandStart(chatId, "op-1", "npm run build", Date.now());
    expect(hasRunningBackgroundCommands(chatId)).toBe(true);
    expect(listBackgroundJobs(chatId).map((j) => j.operationId)).toEqual(["op-1"]);

    recordBackgroundCommandResult(chatId, "op-1", {
      command: "npm run build",
      exitCode: 0,
      output: "built in 42s",
      durationMs: 42_000,
    });
    expect(hasRunningBackgroundCommands(chatId)).toBe(false);
    expect(listBackgroundJobs(chatId)).toHaveLength(0);

    const block = takePendingBackgroundCommandResults(chatId);
    expect(block).toContain("[Background command results]");
    expect(block).toContain("npm run build");
    expect(block).toContain("succeeded");
    // take-once
    expect(takePendingBackgroundCommandResults(chatId)).toBeNull();
  });

  it("list/output/cancel: incremental output cursor + cancelled result", () => {
    const chatId = 9003;
    recordBackgroundCommandStart(chatId, "op-3", "sleep 30", Date.now());
    updateBackgroundOutput(chatId, "op-3", "line1\n");
    const first = readBackgroundOutput(chatId, "op-3");
    expect(first.found).toBe(true);
    expect(first.newOutput).toBe("line1\n");
    // cursor advanced — no new output yet
    expect(readBackgroundOutput(chatId, "op-3").newOutput).toBe("");
    updateBackgroundOutput(chatId, "op-3", "line1\nline2\n");
    expect(readBackgroundOutput(chatId, "op-3").newOutput).toBe("line2\n");

    // cancel marks it; the natural exit records a cancelled result
    expect(killBackgroundJob(chatId, "op-3")).toBe(true);
    recordBackgroundCommandResult(chatId, "op-3", {
      command: "sleep 30",
      exitCode: 143,
      output: "",
      durationMs: 5_000,
    });
    const block = takePendingBackgroundCommandResults(chatId)!;
    expect(block).toContain("was cancelled");
    expect(killBackgroundJob(chatId, "op-3")).toBe(false); // already gone
  });

  it("caps output tails and reports failures with exit code", () => {
    const chatId = 9002;
    recordBackgroundCommandResult(chatId, "op-2", {
      command: "make",
      exitCode: 2,
      output: "x".repeat(20_000),
      durationMs: 1000,
    });
    const block = takePendingBackgroundCommandResults(chatId)!;
    expect(block).toContain("failed (exit 2)");
    expect(block.length).toBeLessThan(10_000);
    clearBackgroundCommandsForChat(chatId);
  });
});

describe("background-commands output-idle watchdog (A4)", () => {
  // Reset the module singletons (watchdog interval + stall state) so a real
  // timer left by an earlier describe can't suppress the fake-timer watchdog.
  beforeEach(() => {
    killAllBackgroundJobs();
  });
  afterEach(() => {
    killAllBackgroundJobs();
    setBackgroundJobNotifier(() => {});
    vi.useRealTimers();
  });

  it("flags a silent running job as stalled once, re-arms after output, never kills it", () => {
    vi.useFakeTimers();
    const chatId = 9100;
    const statuses: string[] = [];
    setBackgroundJobNotifier((cid, ev) => {
      if (cid === chatId) statuses.push(ev.status);
    });

    recordBackgroundCommandStart(chatId, "op-idle", "ssh prod tail -f log", Date.now());
    expect(statuses).toEqual(["running"]);

    // 60s of silence — under the 120s threshold, no advisory yet.
    vi.advanceTimersByTime(60_000);
    expect(hasPendingStalledAdvisories(chatId)).toBe(false);

    // Cross 120s of silence — exactly one "stalled" advisory.
    vi.advanceTimersByTime(70_000);
    expect(statuses.filter((s) => s === "stalled")).toHaveLength(1);
    expect(hasPendingStalledAdvisories(chatId)).toBe(true);
    // Advisory is NOT a kill: the job is still running and listed.
    expect(hasRunningBackgroundCommands(chatId)).toBe(true);
    expect(listBackgroundJobs(chatId)).toHaveLength(1);

    // Advisory text names the job, says still running, and offers the choices.
    const advisory = takePendingStalledAdvisories(chatId)!;
    expect(advisory).toContain("[Background job advisory]");
    expect(advisory).toContain("op-idle");
    expect(advisory).toContain("STILL RUNNING");
    expect(advisory).toContain("cancel");
    // take-once
    expect(takePendingStalledAdvisories(chatId)).toBeNull();

    // It should NOT re-advise while still silent (one per quiet episode).
    vi.advanceTimersByTime(120_000);
    expect(statuses.filter((s) => s === "stalled")).toHaveLength(1);

    // Output resumes → re-armed; a SECOND silent stretch re-advises. Advance
    // past 120s of NEW silence AND across a 30s scan tick (the watchdog only
    // checks on its interval, so we overshoot to land on a qualifying tick).
    updateBackgroundOutput(chatId, "op-idle", "some progress\n");
    vi.advanceTimersByTime(160_000);
    expect(statuses.filter((s) => s === "stalled")).toHaveLength(2);

    clearBackgroundCommandsForChat(chatId);
  });

  it("a finished job stops being watched (no stalled advisory after completion)", () => {
    vi.useFakeTimers();
    const chatId = 9101;
    const statuses: string[] = [];
    setBackgroundJobNotifier((cid, ev) => {
      if (cid === chatId) statuses.push(ev.status);
    });

    recordBackgroundCommandStart(chatId, "op-fast", "echo hi", Date.now());
    recordBackgroundCommandResult(chatId, "op-fast", {
      command: "echo hi",
      exitCode: 0,
      output: "hi",
      durationMs: 10,
    });
    // Long after it finished — no stalled advisory (it's gone from the registry).
    vi.advanceTimersByTime(300_000);
    expect(statuses.filter((s) => s === "stalled")).toHaveLength(0);
    expect(hasPendingStalledAdvisories(chatId)).toBe(false);
    clearBackgroundCommandsForChat(chatId);
  });
});
