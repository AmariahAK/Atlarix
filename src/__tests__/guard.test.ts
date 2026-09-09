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
  coerceParamTypes,
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
    expect(
      (result as { __permission_required?: boolean }).__permission_required,
    ).toBe(true);
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
      getMissingRequiredParams(
        { required: ["a", "b"] },
        { a: null, b: undefined },
      ),
    ).toEqual(["a", "b"]);
  });

  it("is a no-op when schema has no required[] array", () => {
    expect(
      getMissingRequiredParams({ type: "object" }, { whatever: 1 }),
    ).toEqual([]);
  });
});

/**
 * We target weak and local models, which emit `file_path: ["a.ts"]`,
 * `background: "true"` and `max_length: "500"` routinely. Every one of those has
 * a single sane reading, so the guard absorbs it — the same posture the alias
 * table already takes. What it must NOT absorb is a guess.
 */
describe("coerceParamTypes — absorbs the unambiguous", () => {
  const schema = {
    type: "object",
    properties: {
      path: { type: "string" },
      max_length: { type: "number" },
      lines: { type: "integer" },
      background: { type: "boolean" },
      globs: { type: "array", items: { type: "string" } },
      opts: { type: "object" },
    },
    required: ["path"],
  };

  it("unwraps a single-element array for a string parameter", () => {
    const { args, invalid } = coerceParamTypes(schema, { path: ["src/a.ts"] });
    expect(invalid).toEqual([]);
    expect((args as { path: string }).path).toBe("src/a.ts");
  });

  it("parses a numeric string, and a string boolean", () => {
    const { args, invalid } = coerceParamTypes(schema, {
      path: "a.ts",
      max_length: "500",
      background: "true",
    });
    expect(invalid).toEqual([]);
    expect((args as { max_length: number }).max_length).toBe(500);
    expect((args as { background: boolean }).background).toBe(true);
  });

  it("stringifies a number sent where a string was declared", () => {
    const { args } = coerceParamTypes(schema, { path: 42 });
    expect((args as { path: string }).path).toBe("42");
  });

  it("wraps a bare scalar into a one-element array", () => {
    const { args, invalid } = coerceParamTypes(schema, {
      path: "a",
      globs: "*.ts",
    });
    expect(invalid).toEqual([]);
    expect((args as { globs: string[] }).globs).toEqual(["*.ts"]);
  });

  it("unwraps then coerces in one pass", () => {
    const { args } = coerceParamTypes(schema, {
      path: "a",
      max_length: ["500"],
    });
    expect((args as { max_length: number }).max_length).toBe(500);
  });

  it("leaves already-correct args untouched, returning the same object", () => {
    const input = { path: "a.ts", max_length: 10 };
    const { args, invalid } = coerceParamTypes(schema, input);
    expect(invalid).toEqual([]);
    expect(args).toBe(input);
  });
});

describe("coerceParamTypes — refuses to guess", () => {
  const schema = {
    type: "object",
    properties: {
      path: { type: "string" },
      lines: { type: "integer" },
      opts: { type: "object" },
    },
  };

  /**
   * The case the whole check exists for: picking `[0]` here would silently edit
   * one file and drop the other, which is worse than the error.
   */
  it("rejects a MULTI-element array rather than picking one", () => {
    const { invalid } = coerceParamTypes(schema, { path: ["a.ts", "b.ts"] });
    expect(invalid).toHaveLength(1);
    expect(invalid[0].key).toBe("path");
    expect(invalid[0].expected).toBe("string");
    expect(invalid[0].received).toContain("array of 2");
  });

  it("rejects an object where a string was declared", () => {
    const { invalid } = coerceParamTypes(schema, { path: { a: 1 } });
    expect(invalid).toHaveLength(1);
    expect(invalid[0].received).toBe("an object");
  });

  it("rejects a non-numeric string for a number", () => {
    const { invalid } = coerceParamTypes(schema, { lines: "not-a-number" });
    expect(invalid).toHaveLength(1);
  });

  it("rejects a fractional value for an integer", () => {
    const { invalid } = coerceParamTypes(schema, { lines: 1.5 });
    expect(invalid).toHaveLength(1);
  });

  it("passes through undeclared params and unmodelled types untouched", () => {
    const input = { unknown_key: ["a", "b"], opts: { deep: true } };
    const { args, invalid } = coerceParamTypes(schema, input);
    expect(invalid).toEqual([]);
    expect(args).toBe(input);
  });

  it("leaves null/undefined to the required-field check", () => {
    const { invalid } = coerceParamTypes(schema, { path: null });
    expect(invalid).toEqual([]);
  });
});

describe("guardToolCall — type coercion end to end", () => {
  const schema = {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  };

  it("runs the tool with the coerced value", async () => {
    let seen: unknown;
    await guardToolCall({
      toolName: "read_file",
      args: { path: ["src/a.ts"] },
      parametersSchema: schema,
      runWith: async (a) => {
        seen = a;
        return { success: true };
      },
    });
    expect((seen as { path: string }).path).toBe("src/a.ts");
  });

  /** `file_path` must be aliased to `path` BEFORE the array is unwrapped. */
  it("aliases then coerces, so file_path:[...] still reaches the handler", async () => {
    let seen: unknown;
    await guardToolCall({
      toolName: "read_file",
      args: { file_path: "src/a.ts" },
      parametersSchema: schema,
      runWith: async (a) => {
        seen = a;
        return { success: true };
      },
    });
    expect((seen as { path: string }).path).toBe("src/a.ts");
  });

  it("returns a correctable INVALID_PARAMS without running the tool", async () => {
    let ran = false;
    const result = await guardToolCall({
      toolName: "read_file",
      args: { path: ["a.ts", "b.ts"] },
      parametersSchema: schema,
      runWith: async () => {
        ran = true;
        return { success: true };
      },
    });
    expect(ran).toBe(false);
    expect((result as { error?: string }).error).toBe("INVALID_PARAMS");
    const message = (result as { message: string }).message;
    expect(message).toContain("path");
    expect(message).toContain("string");
    expect(message).toContain("array of 2");
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
