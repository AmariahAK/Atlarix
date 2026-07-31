/**
 * Typed destination folders (clone dialog "Save to" field).
 *
 * The field exists because the native directory picker is not always usable — when it
 * fails to open there must still be a way to name a destination, so typed input needs
 * real validation with messages a user can act on.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateParentDir } from "@/ipc/handlers/atlarix_handlers";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-dest-"));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("validateParentDir", () => {
  it("accepts an existing writable directory", async () => {
    const result = await validateParentDir(tmpRoot);
    expect(result).toMatchObject({ ok: true, path: tmpRoot, willCreate: false });
  });

  it("accepts a not-yet-existing folder under a writable parent", async () => {
    const target = path.join(tmpRoot, "nested", "deeper");
    const result = await validateParentDir(target);
    expect(result).toMatchObject({ ok: true, path: target, willCreate: true });
  });

  it("expands a leading ~", async () => {
    const result = await validateParentDir("~");
    expect(result).toMatchObject({ ok: true, path: os.homedir() });
  });

  it("rejects empty input with an actionable message", async () => {
    const result = await validateParentDir("   ");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Choose where to save/i);
  });

  it("rejects a relative path", async () => {
    const result = await validateParentDir("code/projects");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/full path/i);
  });

  it("rejects a path whose target is a file, not a folder", async () => {
    const filePath = path.join(tmpRoot, "not-a-dir.txt");
    fs.writeFileSync(filePath, "x");
    const result = await validateParentDir(filePath);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Not a folder/i);
  });

  it("trims surrounding whitespace from a pasted path", async () => {
    const result = await validateParentDir(`  ${tmpRoot}  `);
    expect(result).toMatchObject({ ok: true, path: tmpRoot });
  });
});
