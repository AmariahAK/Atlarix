/**
 * Cancelling sub-agents.
 *
 * This file used to test that a user cancel killed a writer sub-agent's git
 * worktree children — the CPU-spike source in v14.8.7. v14.21.0 deleted the
 * worktree, so that subject is gone, but cancellation itself very much isn't:
 * a stopped turn must stop token spend, and it must not leave the proposal
 * sets of in-flight writers sitting in main-process memory.
 *
 * The per-task cancel path (`task({task_id, cancel:true})`) is covered in
 * spawn-task.test.ts. What's covered HERE is the stop-the-turn path, which has
 * no tool call behind it and so is otherwise untested.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agents/run-subagent", () => ({
  runSubagent: vi.fn(),
}));

describe("stopping a turn cancels every sub-agent in it", () => {
  it("aborts running sub-agents and reports how many it stopped", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const { runSubagent } = await import("@/lib/agents/run-subagent");
    const { cancelAllSubagentTasksForChat } = await import("@/lib/tools/spawn-task");
    const { clearSubagentsForChat, hasPendingSubagentResults } = await import(
      "@/lib/agents/subagent-results"
    );
    const chatId = 9101;

    const aborted: string[] = [];
    const runsUntilAborted = (name: string) => () =>
      new Promise((_resolve, reject) => {
        // Captured from the args the tool passes through.
        lastSignal?.addEventListener("abort", () => {
          aborted.push(name);
          reject(new Error("aborted"));
        });
      });
    let lastSignal: AbortSignal | undefined;
    vi.mocked(runSubagent).mockImplementation((a: { abortSignal?: AbortSignal }) => {
      lastSignal = a.abortSignal;
      return runsUntilAborted(`run${aborted.length}`)() as never;
    });

    const tool = ToolRegistry.get("task");
    for (const description of ["scout one", "scout two"]) {
      await tool!.handler({
        description,
        prompt: "Look at something slow",
        background: true,
        chatId,
      });
    }

    expect(cancelAllSubagentTasksForChat(chatId)).toBe(2);
    await new Promise((r) => setTimeout(r, 20));

    // A user-cancelled sub-agent must NOT fold a result back into the turn —
    // the turn it belonged to is over.
    expect(hasPendingSubagentResults(chatId)).toBe(false);
    const listed = (await ToolRegistry.execute("subagents", {
      operation: "list",
      _chatSessionId: chatId,
    })) as { result?: { count?: number } };
    expect(listed.result?.count).toBe(0);
    clearSubagentsForChat(chatId);
  });

  it("drops any proposal sets the cancelled turn was holding", async () => {
    const proposals = await import("@/lib/agents/subagent-proposals");
    const { cancelAllSubagentTasksForChat } = await import("@/lib/tools/spawn-task");
    const chatId = 9102;

    // A writer that finished earlier in the turn, whose proposals the main
    // agent never got to review.
    const setId = proposals.createProposalSet({
      chatId,
      taskId: "t-abandoned",
      agentName: "abandoned writer",
      workspace: "/tmp/ws",
    });
    proposals.recordEditProposal(setId, {
      __permission_required: true,
      operation: "edit_file",
      preview: { path: "a.ts", content: "next\n", oldContent: "prev\n", type: "update" },
    });
    expect(proposals.listProposalSetsForChat(chatId)).toHaveLength(1);

    cancelAllSubagentTasksForChat(chatId);

    expect(proposals.listProposalSetsForChat(chatId)).toHaveLength(0);
    expect(proposals.getProposalSet(setId)).toBeNull();
  });

  it("leaves another chat's proposals alone", async () => {
    const proposals = await import("@/lib/agents/subagent-proposals");
    const { cancelAllSubagentTasksForChat } = await import("@/lib/tools/spawn-task");

    const mine = proposals.createProposalSet({
      chatId: 9103,
      taskId: "t-mine",
      agentName: "mine",
      workspace: "/tmp/ws",
    });
    const theirs = proposals.createProposalSet({
      chatId: 9104,
      taskId: "t-theirs",
      agentName: "theirs",
      workspace: "/tmp/ws",
    });

    cancelAllSubagentTasksForChat(9103);

    expect(proposals.getProposalSet(mine)).toBeNull();
    expect(proposals.getProposalSet(theirs)).not.toBeNull();
    proposals.deleteProposalSet(theirs);
  });
});
