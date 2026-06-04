/**
 * v10: every tool failure the model sees must be actionable — bare errors gain
 * a per-tool recovery hint via ToolRegistry.execute; tools with their own
 * guidance keep it untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ToolRegistry, ToolCategory } from "@/lib/tools/registry";
import {
  TOOL_RECOVERY_HINTS,
  hasActionableGuidance,
  resolveRecoverySuggestion,
} from "@/lib/tools/tool-error-patterns";

const TEST_TOOLS = [
  "list_files",
  "find_file",
  "delegate_to_agent",
  "write_implementation_plan",
] as const;

const registered: string[] = [];

function registerThrowing(name: string, message: string) {
  ToolRegistry.register({
    name,
    description: "test tool",
    category: ToolCategory.FILE,
    cost: 1,
    parameters: { type: "object", properties: {}, required: [] },
    handler: async () => {
      throw new Error(message);
    },
  } as any);
  registered.push(name);
}

function registerStructuredFail(name: string, fail: Record<string, unknown>) {
  ToolRegistry.register({
    name,
    description: "test tool",
    category: ToolCategory.FILE,
    cost: 1,
    parameters: { type: "object", properties: {}, required: [] },
    handler: async () => fail,
  } as any);
  registered.push(name);
}

beforeEach(() => {
  registered.length = 0;
});

afterEach(() => {
  for (const name of registered) {
    (ToolRegistry as any).tools?.delete?.(name);
  }
});

describe("hasActionableGuidance", () => {
  it("detects action verbs", () => {
    expect(hasActionableGuidance("Use list_files to locate it.")).toBe(true);
    expect(hasActionableGuidance("Try a broader pattern")).toBe(true);
    expect(hasActionableGuidance("File not found")).toBe(false);
    expect(hasActionableGuidance("Unknown agent: foo")).toBe(false);
    expect(hasActionableGuidance(undefined)).toBe(false);
  });
});

describe("resolveRecoverySuggestion", () => {
  it("keeps an existing suggestion", () => {
    expect(
      resolveRecoverySuggestion({
        toolName: "list_files",
        message: "boom",
        existingSuggestion: "do X",
      }),
    ).toBe("do X");
  });
  it("returns hint for bare messages", () => {
    expect(
      resolveRecoverySuggestion({ toolName: "list_files", message: "boom" }),
    ).toBe(TOOL_RECOVERY_HINTS.list_files);
  });
  it("skips hint when message already guides", () => {
    expect(
      resolveRecoverySuggestion({
        toolName: "list_files",
        message: "Use explore_folder instead.",
      }),
    ).toBeUndefined();
  });
});

describe("ToolRegistry.execute recovery envelope", () => {
  it("thrown bare errors gain the per-tool hint", async () => {
    registerThrowing("list_files", "Failed to scan project: EACCES");
    const res = await ToolRegistry.execute("list_files", {});
    expect(res.success).toBe(false);
    expect(res.suggestion).toBe(TOOL_RECOVERY_HINTS.list_files);
  });

  it("structured bare failures gain the per-tool hint", async () => {
    registerStructuredFail("delegate_to_agent", {
      success: false,
      error: "Unknown agent: bogus",
    });
    const res = await ToolRegistry.execute("delegate_to_agent", {});
    expect(res.success).toBe(false);
    expect(res.suggestion).toBe(TOOL_RECOVERY_HINTS.delegate_to_agent);
    expect(res.suggestion).toContain("research");
  });

  it("structured failures with their own suggestion keep it", async () => {
    registerStructuredFail("find_file", {
      success: false,
      error: "nope",
      suggestion: "custom guidance",
    });
    const res = await ToolRegistry.execute("find_file", {});
    expect(res.suggestion).toBe("custom guidance");
  });

  it("already-actionable messages do not get a redundant hint", async () => {
    registerStructuredFail("write_implementation_plan", {
      success: false,
      message: "No plan yet. Use write_implementation_plan to create one.",
    });
    const res = await ToolRegistry.execute("write_implementation_plan", {});
    expect(res.suggestion).toBeUndefined();
  });

  it("every-mode + core tools all have hints for their common failures", () => {
    for (const name of TEST_TOOLS) {
      expect(TOOL_RECOVERY_HINTS[name]).toBeTruthy();
    }
  });
});
