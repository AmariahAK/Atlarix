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
  hasPendingBackgroundCommandResults,
  getFinishedBackgroundResult,
  setWakeCondition,
  killAllBackgroundJobs,
} from "@/lib/agent/background-commands";
import {
  recordSubagentStart,
  recordSubagentResult,
  takePendingSubagentResults,
} from "@/lib/agents/subagent-results";
import { computeWakePendingResults } from "@/lib/agent/collect-results";

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
    // imperative framing (open-weight robustness): a finished job must direct
    // the model to act, not read as ambient info.
    expect(block).toContain("never restart or re-run work");
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

  it("getFinishedBackgroundResult peeks non-destructively, then null after drain", () => {
    const chatId = 9004;
    recordBackgroundCommandStart(chatId, "op-peek", "npm test", Date.now());
    recordBackgroundCommandResult(chatId, "op-peek", {
      command: "npm test",
      exitCode: 1,
      output: "2 failed",
      durationMs: 3_000,
    });
    // Peek carries the op id + real status/output, and does NOT consume it.
    const peek = getFinishedBackgroundResult(chatId, "op-peek");
    expect(peek?.operationId).toBe("op-peek");
    expect(peek?.exitCode).toBe(1);
    expect(peek?.output).toBe("2 failed");
    expect(hasPendingBackgroundCommandResults(chatId)).toBe(true);
    // Unknown id → null; wrong chat → null.
    expect(getFinishedBackgroundResult(chatId, "nope")).toBeNull();
    expect(getFinishedBackgroundResult(9999, "op-peek")).toBeNull();
    // After the real consumer drains, the peek returns null (nothing queued).
    takePendingBackgroundCommandResults(chatId);
    expect(getFinishedBackgroundResult(chatId, "op-peek")).toBeNull();
    clearBackgroundCommandsForChat(chatId);
  });
});

describe("computeWakePendingResults (single-consumer wake decision)", () => {
  it("only true on a wake turn, reflects bg + sub-agent + advisory buffers, stays non-destructive", () => {
    const chatId = 9200;
    // Nothing pending → false regardless of wake flag.
    expect(computeWakePendingResults(chatId, true)).toBe(false);

    // A finished bg result: true only when isWake is true.
    recordBackgroundCommandStart(chatId, "op-w", "build", Date.now());
    recordBackgroundCommandResult(chatId, "op-w", {
      command: "build",
      exitCode: 0,
      output: "ok",
      durationMs: 1,
    });
    expect(computeWakePendingResults(chatId, false)).toBe(false); // non-wake turn
    expect(computeWakePendingResults(chatId, true)).toBe(true);
    // Strictly non-destructive: still pending after the check.
    expect(hasPendingBackgroundCommandResults(chatId)).toBe(true);
    takePendingBackgroundCommandResults(chatId);
    expect(computeWakePendingResults(chatId, true)).toBe(false);

    // A finished sub-agent result alone also flips it.
    recordSubagentStart(chatId, "task-w");
    recordSubagentResult(chatId, "task-w", {
      description: "sweep",
      state: "completed",
      body: "done",
      durationMs: 1,
    });
    expect(computeWakePendingResults(chatId, true)).toBe(true);
    takePendingSubagentResults(chatId);
    expect(computeWakePendingResults(chatId, true)).toBe(false);

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

    // 120s of silence — under the 180s threshold, no advisory yet.
    vi.advanceTimersByTime(120_000);
    expect(hasPendingStalledAdvisories(chatId)).toBe(false);

    // Cross 180s of silence (next 60s scan tick) — exactly one "stalled" advisory.
    vi.advanceTimersByTime(60_000);
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
    // imperative framing: must force a decision before ending the turn.
    expect(advisory).toContain("before ending your turn");
    // take-once
    expect(takePendingStalledAdvisories(chatId)).toBeNull();

    // It should NOT re-advise while still silent (one per quiet episode).
    vi.advanceTimersByTime(120_000);
    expect(statuses.filter((s) => s === "stalled")).toHaveLength(1);

    // Output resumes → re-armed; a SECOND silent stretch re-advises. Advance
    // past 180s of NEW silence AND across a 60s scan tick (the watchdog only
    // checks on its interval, so we land on a qualifying tick).
    updateBackgroundOutput(chatId, "op-idle", "some progress\n");
    vi.advanceTimersByTime(180_000);
    expect(statuses.filter((s) => s === "stalled")).toHaveLength(2);

    clearBackgroundCommandsForChat(chatId);
  });

  it("wake_on: fires a condition_met advisory once when output matches (idle-stall still backstops)", () => {
    vi.useFakeTimers();
    const chatId = 9300;
    const statuses: string[] = [];
    setBackgroundJobNotifier((cid, ev) => {
      if (cid === chatId) statuses.push(ev.status);
    });

    recordBackgroundCommandStart(chatId, "op-watch", "npm run dev", Date.now(), {
      pattern: "compiled successfully",
    });
    // Output arrives WITHOUT the pattern → no match yet on the next scan.
    updateBackgroundOutput(chatId, "op-watch", "starting dev server...\n");
    vi.advanceTimersByTime(60_000);
    expect(statuses.filter((s) => s === "condition_met")).toHaveLength(0);
    expect(hasPendingStalledAdvisories(chatId)).toBe(false);

    // Pattern appears → next scan fires exactly one condition_met.
    updateBackgroundOutput(chatId, "op-watch", "starting dev server...\ncompiled successfully in 1.2s\n");
    vi.advanceTimersByTime(60_000);
    expect(statuses.filter((s) => s === "condition_met")).toHaveLength(1);
    const advisory = takePendingStalledAdvisories(chatId)!;
    expect(advisory).toContain("matched your wake condition");
    expect(advisory).toContain("op-watch");

    // Fires only once — more matching output doesn't re-advise.
    updateBackgroundOutput(chatId, "op-watch", "compiled successfully again\n");
    vi.advanceTimersByTime(60_000);
    expect(statuses.filter((s) => s === "condition_met")).toHaveLength(1);

    // The job is still running (advisory is not a kill).
    expect(hasRunningBackgroundCommands(chatId)).toBe(true);
    clearBackgroundCommandsForChat(chatId);
  });

  it("setWakeCondition attaches a regex condition to an already-running job", () => {
    vi.useFakeTimers();
    const chatId = 9301;
    const statuses: string[] = [];
    setBackgroundJobNotifier((cid, ev) => {
      if (cid === chatId) statuses.push(ev.status);
    });
    recordBackgroundCommandStart(chatId, "op-late", "tail -f app.log", Date.now());
    expect(setWakeCondition(chatId, "op-late", { pattern: "ERROR|FATAL", regex: true })).toBe(true);
    expect(setWakeCondition(chatId, "nope", { pattern: "x" })).toBe(false);

    updateBackgroundOutput(chatId, "op-late", "info: ok\nFATAL: boom\n");
    vi.advanceTimersByTime(60_000);
    expect(statuses.filter((s) => s === "condition_met")).toHaveLength(1);
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
