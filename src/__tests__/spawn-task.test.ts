import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agents/run-subagent", () => ({
  runSubagent: vi.fn(async () => ({
    success: true,
    summary: "Mapped packages/api — 3 modules, entry at index.ts",
    stepsUsed: 2,
  })),
}));

describe("task tool", () => {
  it("registers task and returns a completed envelope from runSubagent", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const tool = ToolRegistry.get("task");
    expect(tool?.name).toBe("task");
    const out = await tool!.handler({
      description: "map api",
      prompt: "Map packages/api",
    });
    expect(String(out)).toContain('<task id="');
    expect(String(out)).toContain('state="completed"');
    expect(String(out)).toContain("Mapped packages/api");
  });

  it("background=true returns a running envelope immediately", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const tool = ToolRegistry.get("task");
    const out = await tool!.handler({
      description: "map api",
      prompt: "Map packages/api in the background",
      background: true,
    });
    expect(String(out)).toContain('state="running"');
    expect(String(out)).toContain("Background sub-agent started");
  });

  it("background task records its result into the per-chat store on completion", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const store = await import("@/lib/agents/subagent-results");
    const chatId = 7777;
    const tool = ToolRegistry.get("task");
    await tool!.handler({
      description: "map api",
      prompt: "Map packages/api in the background",
      background: true,
      chatId,
    });
    // The mocked runSubagent resolves immediately; let the async finalize run.
    await new Promise((r) => setTimeout(r, 20));
    expect(store.hasPendingSubagentResults(chatId)).toBe(true);
    const block = store.takePendingSubagentResults(chatId);
    expect(block).toContain("[Background sub-agent results]");
    expect(block).toContain("Mapped packages/api");
    expect(store.hasRunningSubagents(chatId)).toBe(false);
    store.clearSubagentsForChat(chatId);
  });

  it("unknown task_id resumes to an error envelope", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const tool = ToolRegistry.get("task");
    const out = await tool!.handler({
      description: "resume",
      prompt: "n/a",
      task_id: "nope",
    });
    expect(String(out)).toContain('state="error"');
    expect(String(out)).toContain("Unknown task_id");
  });
});
