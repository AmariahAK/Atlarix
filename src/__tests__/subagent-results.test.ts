import { afterEach, describe, expect, it } from "vitest";
import {
  recordSubagentStart,
  recordSubagentResult,
  takePendingSubagentResults,
  hasRunningSubagents,
  hasPendingSubagentResults,
  runningSubagentCount,
  clearSubagentsForChat,
  setSubagentNotifier,
} from "@/lib/agents/subagent-results";

describe("subagent-results (background sub-agent orchestration)", () => {
  afterEach(() => {
    setSubagentNotifier(() => {});
  });

  it("records, drains take-once, and tracks running state", () => {
    const chatId = 7101;
    recordSubagentStart(chatId, "task-1");
    recordSubagentStart(chatId, "task-2");
    expect(hasRunningSubagents(chatId)).toBe(true);
    expect(runningSubagentCount(chatId)).toBe(2);
    expect(hasPendingSubagentResults(chatId)).toBe(false);

    recordSubagentResult(chatId, "task-1", {
      description: "research auth",
      state: "completed",
      body: "auth uses Supabase JWT",
      durationMs: 3_000,
    });
    // one still running, one result pending
    expect(runningSubagentCount(chatId)).toBe(1);
    expect(hasPendingSubagentResults(chatId)).toBe(true);

    const block = takePendingSubagentResults(chatId);
    expect(block).toContain("[Background sub-agent results]");
    expect(block).toContain("research auth");
    expect(block).toContain("auth uses Supabase JWT");
    expect(block).toContain('task_id="task-1"');
    // imperative framing (open-weight robustness): the woken result must tell
    // the model to act, not just describe the outcome.
    expect(block).toContain("continue the user's task");
    // take-once
    expect(takePendingSubagentResults(chatId)).toBeNull();
    // second sub-agent still running keeps the turn alive
    expect(hasRunningSubagents(chatId)).toBe(true);
    clearSubagentsForChat(chatId);
    expect(hasRunningSubagents(chatId)).toBe(false);
  });

  it("caps body tails and surfaces errors as task_error", () => {
    const chatId = 7102;
    recordSubagentResult(chatId, "task-x", {
      description: "huge",
      state: "error",
      body: "y".repeat(40_000),
      durationMs: 1000,
    });
    const block = takePendingSubagentResults(chatId)!;
    expect(block).toContain("failed");
    expect(block).toContain("task_error");
    expect(block.length).toBeLessThan(14_000);
    clearSubagentsForChat(chatId);
  });

  it("fires the notifier 'running' on start and 'finished' on result (mirrors background-commands)", () => {
    const chatId = 7103;
    const events: Array<{ taskId: string; status: string; running: number }> =
      [];
    setSubagentNotifier((cid, ev) => {
      if (cid === chatId) events.push(ev);
    });

    recordSubagentStart(chatId, "task-a");
    recordSubagentStart(chatId, "task-b");
    expect(events).toEqual([
      { taskId: "task-a", status: "running", running: 1 },
      { taskId: "task-b", status: "running", running: 2 },
    ]);

    recordSubagentResult(chatId, "task-a", {
      description: "scout",
      state: "completed",
      body: "ok",
      durationMs: 100,
    });
    // running count drops to 1 (task-b still going); "finished" regardless of state
    expect(events.at(-1)).toEqual({
      taskId: "task-a",
      status: "finished",
      running: 1,
    });

    recordSubagentResult(chatId, "task-b", {
      description: "scout2",
      state: "error",
      body: "boom",
      durationMs: 100,
    });
    // an ERROR result also fires "finished" so it can auto-wake a parked turn
    expect(events.at(-1)).toEqual({
      taskId: "task-b",
      status: "finished",
      running: 0,
    });

    clearSubagentsForChat(chatId);
  });

  it("does not throw when no notifier is registered", () => {
    setSubagentNotifier(undefined as unknown as () => void);
    const chatId = 7104;
    expect(() => recordSubagentStart(chatId, "task-z")).not.toThrow();
    expect(() =>
      recordSubagentResult(chatId, "task-z", {
        description: "x",
        state: "completed",
        body: "y",
        durationMs: 1,
      }),
    ).not.toThrow();
    clearSubagentsForChat(chatId);
  });
});
