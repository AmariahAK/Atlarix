import { describe, expect, it } from "vitest";
import { collectPendingBackgroundResultsBody } from "@/lib/agent/collect-results";
import {
  recordBackgroundCommandResult,
  recordBackgroundCommandStart,
  clearBackgroundCommandsForChat,
} from "@/lib/agent/background-commands";
import {
  recordSubagentStart,
  recordSubagentResult,
  clearSubagentsForChat,
} from "@/lib/agents/subagent-results";

describe("collectPendingBackgroundResultsBody (R2)", () => {
  it("drains finished bg-command + sub-agent results into one imperative block (take-once)", () => {
    const chatId = 91234;
    clearBackgroundCommandsForChat(chatId);
    clearSubagentsForChat(chatId);

    recordBackgroundCommandStart(chatId, "op-1", "npm run build", Date.now());
    recordBackgroundCommandResult(chatId, "op-1", {
      command: "npm run build",
      exitCode: 0,
      output: "build-ok-marker",
      durationMs: 1234,
    });
    recordSubagentStart(chatId, "task-1");
    recordSubagentResult(chatId, "task-1", {
      description: "scout api",
      state: "completed",
      body: "scout-done-marker",
      durationMs: 2345,
    });

    const body = collectPendingBackgroundResultsBody(chatId);
    // Both result kinds present...
    expect(body).toContain("build-ok-marker");
    expect(body).toContain("scout-done-marker");
    // ...with the imperative framing the model must act on.
    expect(body).toContain("never restart or re-run work");
    expect(body).toContain("continue the user's task");

    // Take-once: a second collect finds nothing pending.
    expect(collectPendingBackgroundResultsBody(chatId)).toBe(
      "No pending background results.",
    );

    clearBackgroundCommandsForChat(chatId);
    clearSubagentsForChat(chatId);
  });

  it("returns a neutral message when nothing is pending", () => {
    expect(collectPendingBackgroundResultsBody(99999)).toBe(
      "No pending background results.",
    );
  });
});
