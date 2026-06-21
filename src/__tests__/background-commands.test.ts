import { describe, expect, it } from "vitest";
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
