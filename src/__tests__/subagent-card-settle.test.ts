/**
 * A backgrounded sub-agent must not be DISPLAYED as finished.
 *
 * `task` returns immediately when a run is backgrounded (or auto-promoted at
 * 30s), and the delegation wrapper used to emit its "completed" activity right
 * after that return. So the round card read "Sub-agents · 1 completed" with a
 * green tick while the sub-agent was still working — directly contradicting the
 * main agent's own narration one line below it.
 *
 * v14.21 auto-promotion made this the common case rather than a rarity, which
 * is what surfaced it.
 */

import { describe, expect, it, vi } from "vitest";
import { extractDelegationDisplaySummary } from "@/lib/agents/register-delegation-tools";

vi.mock("@/lib/agents/run-subagent", () => ({
  runSubagent: vi.fn(),
}));

describe("the still-running envelope is recognised", () => {
  it("flags a background start as running, not complete", () => {
    const envelope =
      '<task id="t1" state="running">\n<summary>Background task started</summary>\n' +
      "<task_result>\nBackground sub-agent started.\n</task_result>\n</task>";
    const r = extractDelegationDisplaySummary(envelope, envelope);
    expect(r.isRunning).toBe(true);
    expect(r.isError).toBe(false);
  });

  it("flags an auto-promoted task as running too", () => {
    const envelope =
      '<task id="t1" state="running">\n<summary>slow scout</summary>\n' +
      "<task_result>\nStill running after 30s — moved to the background (task_id: t1).\n" +
      "</task_result>\n</task>";
    expect(extractDelegationDisplaySummary(envelope, envelope).isRunning).toBe(true);
  });

  it("does NOT flag a genuinely finished task", () => {
    const envelope =
      '<task id="t1" state="completed"><summary>map api</summary>' +
      "<task_result>Mapped 3 modules.</task_result></task>";
    const r = extractDelegationDisplaySummary(envelope, envelope);
    expect(r.isRunning).toBe(false);
    expect(r.summary).toBe("Mapped 3 modules.");
  });

  it("still detects an error envelope", () => {
    const envelope =
      '<task id="t1" state="error"><task_error>boom</task_error></task>';
    const r = extractDelegationDisplaySummary(envelope, envelope);
    expect(r.isError).toBe(true);
    expect(r.isRunning).toBe(false);
  });
});

describe("the card settles when the run really ends", () => {
  it("calls onBackgroundSettled with the real summary, long after task returned", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const { runSubagent } = await import("@/lib/agents/run-subagent");
    const chatId = 9300;

    let release: (() => void) | undefined;
    vi.mocked(runSubagent).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ success: true, summary: "the real answer", stepsUsed: 2 });
        }),
    );

    const settled: Array<{ summary: string; isError: boolean }> = [];
    const started = String(
      await ToolRegistry.get("task")!.handler({
        description: "slow one",
        prompt: "take your time",
        background: true,
        chatId,
        onBackgroundSettled: (s: { summary: string; isError: boolean }) =>
          settled.push(s),
      }),
    );

    // The tool has returned, but nothing has settled — this is the whole point.
    expect(started).toContain('state="running"');
    expect(settled).toHaveLength(0);

    release?.();
    await new Promise((r) => setTimeout(r, 30));

    expect(settled).toHaveLength(1);
    expect(settled[0].isError).toBe(false);
    expect(settled[0].summary).toContain("the real answer");

    const store = await import("@/lib/agents/subagent-results");
    store.clearSubagentsForChat(chatId);
  });

  it("settles a cancelled run as an error rather than leaving it spinning", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const { runSubagent } = await import("@/lib/agents/run-subagent");
    const chatId = 9301;

    vi.mocked(runSubagent).mockImplementationOnce(
      (a: Parameters<typeof runSubagent>[0]) =>
        new Promise((_res, rej) => {
          a.abortSignal?.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );

    const settled: Array<{ isError: boolean }> = [];
    await ToolRegistry.get("task")!.handler({
      description: "doomed",
      prompt: "x",
      background: true,
      chatId,
      onBackgroundSettled: (s: { isError: boolean }) => settled.push(s),
    });

    await ToolRegistry.execute("subagents", {
      operation: "cancel",
      agent: "doomed",
      _chatSessionId: chatId,
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(settled).toHaveLength(1);
    expect(settled[0].isError).toBe(true);

    const store = await import("@/lib/agents/subagent-results");
    store.clearSubagentsForChat(chatId);
  });
});

describe("sub-agent narration is readable, not raw JSON", () => {
  it("buffers the formatted label instead of the serialized tool result", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const { runSubagent } = await import("@/lib/agents/run-subagent");
    const chatId = 9302;

    vi.mocked(runSubagent).mockImplementationOnce(
      (a: Parameters<typeof runSubagent>[0]) =>
        new Promise((_res, rej) => {
          // Exactly what run-subagent emits: a pretty `label` and a raw `detail`.
          a.emit?.({
            type: "tool_use",
            id: "n1",
            toolName: "grep",
            status: "done",
            label: "5 matches in 1 file",
            detail:
              '{"success":true,"result":{"success":true,"result":"5 match(es) for \\"ParseQuery\\"..."}}',
          });
          a.abortSignal?.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );

    await ToolRegistry.get("task")!.handler({
      description: "narration test",
      prompt: "x",
      background: true,
      chatId,
    });
    await new Promise((r) => setTimeout(r, 20));

    const out = (await ToolRegistry.execute("subagents", {
      operation: "output",
      agent: "narration test",
      mode: "tail",
      _chatSessionId: chatId,
    })) as { result?: { output?: string } };

    const text = out.result?.output ?? "";
    expect(text).toContain("[done grep: 5 matches in 1 file]");
    // The raw envelope must not reach the model or the card.
    expect(text).not.toContain('"success":true');
    expect(text).not.toContain('\\"');

    await ToolRegistry.execute("subagents", {
      operation: "cancel",
      agent: "narration test",
      _chatSessionId: chatId,
    });
    const store = await import("@/lib/agents/subagent-results");
    store.clearSubagentsForChat(chatId);
  });
});
