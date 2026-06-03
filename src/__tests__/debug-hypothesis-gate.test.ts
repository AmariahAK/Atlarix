import { describe, expect, it, beforeEach } from "vitest";
import {
  clearDebugHypothesis,
  setDebugHypothesis,
  isDebugWriteTool,
} from "../lib/debug/debug-hypothesis-session";
import { debugWriteGateResult } from "../lib/debug/debug-hypothesis-gate";
import { MODE_SYSTEM_TOOL_LISTS } from "../lib/tools/mode-tool-registry";

describe("debug hypothesis gate", () => {
  const chatId = 42;

  beforeEach(() => {
    clearDebugHypothesis(chatId);
  });

  it("debug allowlist includes build write tools and record_debug_hypothesis", () => {
    expect(MODE_SYSTEM_TOOL_LISTS.debug).toContain("write_multiple_files");
    expect(MODE_SYSTEM_TOOL_LISTS.debug).toContain("delete_file");
    expect(MODE_SYSTEM_TOOL_LISTS.debug).toContain("record_debug_hypothesis");
  });

  it("blocks write_file in debug without hypothesis", () => {
    expect(isDebugWriteTool("write_file")).toBe(true);
    const blocked = debugWriteGateResult(chatId, "write_file", "debug", {});
    expect(blocked).toContain("record_debug_hypothesis");
  });

  it("allows write_file after record_debug_hypothesis", () => {
    setDebugHypothesis(chatId, {
      hypothesis: "Null ref in handler when input is empty",
      likelyFiles: ["src/handler.ts"],
    });
    expect(debugWriteGateResult(chatId, "write_file", "debug", {})).toBeNull();
  });

  it("allows inline hypothesis on write args", () => {
    const ok = debugWriteGateResult(chatId, "edit_file", "debug", {
      hypothesis: "Off-by-one in loop bound",
    });
    expect(ok).toBeNull();
  });

  it("does not gate writes in build mode", () => {
    expect(debugWriteGateResult(chatId, "write_file", "build", {})).toBeNull();
  });
});
