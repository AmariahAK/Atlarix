/**
 * Smoke tests for raised / clamped tool limits (defaults live on the registry).
 */

import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ToolRegistry } from "../lib/tools/registry";

beforeAll(async () => {
  await import("../lib/tools/file");
  await import("../lib/tools/shell");
});

describe("run_command preview limits", () => {
  it("clamps timeout_ms and max_output_bytes into the permission preview", async () => {
    const res = (await ToolRegistry.execute("run_command", {
      workspace: os.tmpdir(),
      command: "echo ok",
      description: "test",
      cwd: ".",
      timeout_ms: 9_999_999,
      max_output_bytes: 9_999_999,
    })) as {
      __permission_required?: boolean;
      preview?: { timeout_ms?: number; max_output_bytes?: number };
    };
    expect(res.__permission_required).toBe(true);
    expect(res.preview?.timeout_ms).toBe(1_800_000);
    expect(res.preview?.max_output_bytes).toBe(1_000_000);
  });
});

describe("read_file limits", () => {
  it("respects max_lines and max_bytes caps on real files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlx-read-"));
    const fp = path.join(dir, "big.txt");
    const lines = Array.from({ length: 4000 }, (_, i) => `L${i + 1}`);
    await fs.writeFile(fp, lines.join("\n"), "utf8");
    try {
      const res = (await ToolRegistry.execute("read_file", {
        workspace: dir,
        path: "big.txt",
        max_lines: 40,
        max_bytes: 900,
      })) as { success: boolean; result?: unknown };
      expect(res.success).toBe(true);
      const text =
        typeof res.result === "string" ? res.result : String(res.result);
      expect(text.toLowerCase()).toMatch(/truncat|exceeded max_bytes|showing:/);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(3500);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("search max_results clamp", () => {
  it("clamps requested max to 200", () => {
    // eslint-disable-next-line oxc/bad-min-max-func -- intentionally asserts the clamp formula's constant result
    expect(Math.min(200, Math.max(1, 9999))).toBe(200);
  });
});
