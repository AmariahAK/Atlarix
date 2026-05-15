import { describe, it, expect, vi } from "vitest";

vi.mock("electron-log", () => ({
  default: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
  },
}));

import {
  guardToolCall,
  getMissingRequiredParams,
} from "../lib/tools/guard";

describe("guardToolCall — permission bypass invariant", () => {
  it("passes a __permission_required result through unchanged", async () => {
    const result = await guardToolCall({
      toolName: "write_file",
      args: { path: "/etc/hosts", contents: "..." },
      runner: async () => ({
        __permission_required: true,
        operation: "write",
        path: "/etc/hosts",
      }),
    });
    expect((result as { __permission_required?: boolean }).__permission_required).toBe(true);
    expect((result as { operation?: string }).operation).toBe("write");
    expect((result as { path?: string }).path).toBe("/etc/hosts");
  });
});

describe("guardToolCall — param validation", () => {
  it("returns INVALID_PARAMS without running the tool when required field is missing", async () => {
    let ran = false;
    const result = await guardToolCall({
      toolName: "read_file",
      args: {},
      parametersSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      runner: async () => {
        ran = true;
        return { success: true };
      },
    });
    expect((result as { error?: string }).error).toBe("INVALID_PARAMS");
    expect((result as { received?: string[] }).received).toEqual([]);
    expect(ran).toBe(false);
  });

  it("ignores required[] when args provides all keys", () => {
    expect(
      getMissingRequiredParams({ required: ["a", "b"] }, { a: 1, b: 2 }),
    ).toEqual([]);
  });

  it("treats explicit null/undefined as missing", () => {
    expect(
      getMissingRequiredParams({ required: ["a", "b"] }, { a: null, b: undefined }),
    ).toEqual(["a", "b"]);
  });

  it("is a no-op when schema has no required[] array", () => {
    expect(
      getMissingRequiredParams({ type: "object" }, { whatever: 1 }),
    ).toEqual([]);
  });
});

describe("guardToolCall — TOOL_ERROR trap", () => {
  it("wraps thrown handler errors without bubbling", async () => {
    const result = await guardToolCall({
      toolName: "broken",
      args: {},
      runner: async () => {
        throw new Error("boom");
      },
    });
    expect((result as { error?: string }).error).toBe("TOOL_ERROR");
    expect((result as { message?: string }).message).toContain("boom");
  });
});
