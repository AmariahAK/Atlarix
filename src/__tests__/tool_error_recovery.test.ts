/**
 * v10: every tool failure the model sees must be actionable — bare errors gain
 * a per-tool recovery hint via ToolRegistry.execute; tools with their own
 * guidance keep it untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ToolRegistry } from "@/lib/tools/registry";
import {
  TOOL_RECOVERY_HINTS,
  hasActionableGuidance,
  resolveRecoverySuggestion,
} from "@/lib/tools/tool-error-patterns";

// Real core tools that must always carry a recovery hint.
const TEST_TOOLS = [
  "read_file",
  "edit_file",
  "glob",
  "grep",
  "run_command",
  "plan",
  "mcp_call",
] as const;

// Throwaway tool name for exercising the execute() envelope without clobbering a
// real registered tool; its hint is injected/removed per test (see beforeEach).
const FAKE_TOOL = "__recovery_test_tool";

const registered: string[] = [];

function registerThrowing(name: string, message: string) {
  ToolRegistry.register({
    name,
    description: "test tool",
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
    parameters: { type: "object", properties: {}, required: [] },
    handler: async () => fail,
  } as any);
  registered.push(name);
}

beforeEach(() => {
  registered.length = 0;
  TOOL_RECOVERY_HINTS[FAKE_TOOL] = "Try a broader pattern to fix it.";
});

afterEach(() => {
  for (const name of registered) {
    (ToolRegistry as any).tools?.delete?.(name);
  }
  delete TOOL_RECOVERY_HINTS[FAKE_TOOL];
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
      resolveRecoverySuggestion({ toolName: FAKE_TOOL, message: "boom" }),
    ).toBe(TOOL_RECOVERY_HINTS[FAKE_TOOL]);
  });
  it("skips hint when message already guides", () => {
    expect(
      resolveRecoverySuggestion({
        toolName: FAKE_TOOL,
        message: "Use grep instead.",
      }),
    ).toBeUndefined();
  });
});

describe("ToolRegistry.execute recovery envelope", () => {
  it("thrown bare errors gain the per-tool hint", async () => {
    registerThrowing(FAKE_TOOL, "Failed to scan project: EACCES");
    const res = await ToolRegistry.execute(FAKE_TOOL, {});
    expect(res.success).toBe(false);
    expect(res.suggestion).toBe(TOOL_RECOVERY_HINTS[FAKE_TOOL]);
  });

  it("structured bare failures gain the per-tool hint", async () => {
    registerStructuredFail(FAKE_TOOL, {
      success: false,
      error: "something went wrong",
    });
    const res = await ToolRegistry.execute(FAKE_TOOL, {});
    expect(res.success).toBe(false);
    expect(res.suggestion).toBe(TOOL_RECOVERY_HINTS[FAKE_TOOL]);
  });

  it("v14.8.7 §F: a bare { error } (no success flag) is normalized to a failure + hint", async () => {
    // The legacy edit_file/plan convention returns { error, operation } with no
    // success flag — it must now surface as success:false with a recovery hint,
    // not slip through as a success whose result nests the error.
    registerStructuredFail(FAKE_TOOL, {
      error: "operation failed",
      operation: "x",
    });
    const res = await ToolRegistry.execute(FAKE_TOOL, {});
    expect(res.success).toBe(false);
    expect(res.result).toBeUndefined();
    expect(res.suggestion).toBe(TOOL_RECOVERY_HINTS[FAKE_TOOL]);
  });

  it("v14.8.7 §F: a bare { error } whose message already guides keeps no redundant hint but is still a failure", async () => {
    registerStructuredFail(FAKE_TOOL, {
      error:
        "Content not found. Re-read the file and retry with exact content.",
      operation: "x",
    });
    const res = await ToolRegistry.execute(FAKE_TOOL, {});
    expect(res.success).toBe(false);
    expect(res.suggestion).toBeUndefined();
  });

  it("structured failures with their own suggestion keep it", async () => {
    registerStructuredFail(FAKE_TOOL, {
      success: false,
      error: "nope",
      suggestion: "custom guidance",
    });
    const res = await ToolRegistry.execute(FAKE_TOOL, {});
    expect(res.suggestion).toBe("custom guidance");
  });

  it("already-actionable messages do not get a redundant hint", async () => {
    registerStructuredFail(FAKE_TOOL, {
      success: false,
      message: "No match. Use grep to find it by content.",
    });
    const res = await ToolRegistry.execute(FAKE_TOOL, {});
    expect(res.suggestion).toBeUndefined();
  });

  it("every-mode + core tools all have hints for their common failures", () => {
    for (const name of TEST_TOOLS) {
      expect(TOOL_RECOVERY_HINTS[name]).toBeTruthy();
    }
  });
});
