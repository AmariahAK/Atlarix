import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/tools/agent", () => ({
  runDelegation: vi.fn(async () => ({
    success: true,
    summary: JSON.stringify({ agentRole: "explore", success: true, summary: "done" }),
  })),
}));

describe("task tool", () => {
  it("registers task tool and returns completed envelope", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const tool = ToolRegistry.get("task");
    expect(tool?.name).toBe("task");
    const out = await tool!.handler({
      description: "map api",
      prompt: "Map packages/api",
      subagent_type: "explore",
    });
    expect(String(out)).toContain('<task id="');
    expect(String(out)).toContain('state="completed"');
  });
});
