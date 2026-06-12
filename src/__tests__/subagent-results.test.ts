import { describe, expect, it } from "vitest";
import {
  recordSubagentStart,
  recordSubagentResult,
  takePendingSubagentResults,
  hasRunningSubagents,
  hasPendingSubagentResults,
  runningSubagentCount,
  clearSubagentsForChat,
} from "@/lib/agents/subagent-results";

describe("subagent-results (background sub-agent orchestration)", () => {
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
});
