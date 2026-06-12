import { describe, expect, it } from "vitest";
import {
  recordBackgroundCommandStart,
  recordBackgroundCommandResult,
  takePendingBackgroundCommandResults,
  hasRunningBackgroundCommands,
  clearBackgroundCommandsForChat,
} from "@/lib/agent/background-commands";

describe("background-commands (v13 7A)", () => {
  it("records, drains take-once, and tracks running state", () => {
    const chatId = 9001;
    recordBackgroundCommandStart(chatId, "op-1");
    expect(hasRunningBackgroundCommands(chatId)).toBe(true);

    recordBackgroundCommandResult(chatId, "op-1", {
      command: "npm run build",
      exitCode: 0,
      output: "built in 42s",
      durationMs: 42_000,
    });
    expect(hasRunningBackgroundCommands(chatId)).toBe(false);

    const block = takePendingBackgroundCommandResults(chatId);
    expect(block).toContain("[Background command results]");
    expect(block).toContain("npm run build");
    expect(block).toContain("succeeded");
    // take-once
    expect(takePendingBackgroundCommandResults(chatId)).toBeNull();
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
