import { describe, it, expect, vi } from "vitest";

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    }),
  },
}));

import {
  enrichReadFileStructuredError,
  readFileStructuredError,
} from "../lib/tools/file-read-errors";
import { ENV_SECRET_BLOCK_MESSAGE, PATH_ESCAPE_BLOCK_MESSAGE } from "../lib/security/env-secret-paths";

describe("readFileStructuredError", () => {
  it("maps ENOENT to file_not_found", () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const result = readFileStructuredError(err, "package.json");
    expect(result).toEqual({
      success: false,
      error: "file_not_found",
      path: "package.json",
      message: expect.stringContaining("package.json"),
    });
  });

  it("maps EISDIR to not_a_file", () => {
    const err = Object.assign(new Error("EISDIR"), { code: "EISDIR" });
    const result = readFileStructuredError(err, ".");
    expect(result?.error).toBe("not_a_file");
    expect(result?.path).toBe(".");
  });

  it("maps path escape to path_not_allowed", () => {
    const result = readFileStructuredError(
      new Error(PATH_ESCAPE_BLOCK_MESSAGE),
      "../secret",
    );
    expect(result?.error).toBe("path_not_allowed");
  });

  it("maps secret block to path_not_allowed", () => {
    const result = readFileStructuredError(new Error(ENV_SECRET_BLOCK_MESSAGE), ".env");
    expect(result?.error).toBe("path_not_allowed");
  });

  it("maps invalid relative path to path_not_allowed", () => {
    const result = readFileStructuredError(
      new Error(
        'Invalid path: "Users/..." looks like an absolute system path pasted as relative.',
      ),
      "Users/amariah/foo",
    );
    expect(result?.error).toBe("path_not_allowed");
  });


  it("enrichReadFileStructuredError appends inventory", () => {
    const base = readFileStructuredError(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      "package.json",
    )!;
    const enriched = enrichReadFileStructuredError(
      base,
      'This workspace has only 2 tracked file(s): "a.md", "b.txt".',
    );
    expect(enriched.message).toContain("package.json");
    expect(enriched.message).toContain("2 tracked file");
  });
  it("returns null for unknown errors", () => {
    expect(readFileStructuredError(new Error("disk on fire"), "x.ts")).toBeNull();
  });
});
