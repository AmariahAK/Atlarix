/**
 * edit_file on an EXPLICIT absolute path outside the workspace: allowed, but
 * still routed through the approval + diff gate (__permission_required) — never a
 * silent write. Relative paths stay confined. This is what lets cross-repo edits
 * use edit_file (with a diff) instead of sed/python shell workarounds.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { realpathSync } from "node:fs";
import { ToolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/edit"; // side-effect: registers edit_file

let ws = "";
let outsideFile = "";

beforeEach(() => {
  const base = realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-edit-out-")));
  ws = path.join(base, "workspace");
  const other = path.join(base, "other-repo");
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  outsideFile = path.join(other, "loader.go");
  fs.writeFileSync(outsideFile, "package loader\n\nconst Version = \"1\"\n");
});
afterEach(() => {
  fs.rmSync(path.dirname(ws), { recursive: true, force: true });
});

async function edit(args: Record<string, unknown>) {
  return (await ToolRegistry.execute("edit_file", { workspace: ws, ...args })) as {
    preview?: { path: string; content: string };
    error?: string;
    denied?: boolean;
    __permission_required?: boolean;
  };
}

describe("edit_file outside the workspace (gated, not silent)", () => {
  it("absolute outside path → permission gate fires with the absolute path + diff", async () => {
    const res = await edit({
      path: outsideFile,
      operation: "replace",
      old_content: 'const Version = "1"',
      new_content: 'const Version = "2"',
    });
    expect(res.__permission_required).toBe(true);
    expect(res.preview?.path).toBe(outsideFile);
    expect(res.preview?.content).toContain('const Version = "2"');
    // Nothing written until approval — the file on disk is untouched.
    expect(fs.readFileSync(outsideFile, "utf-8")).toContain('const Version = "1"');
  });

  it("plan mode still refuses an outside edit (only .atlarix docs allowed)", async () => {
    const res = await edit({
      path: outsideFile,
      operation: "replace",
      chatMode: "plan",
      old_content: 'const Version = "1"',
      new_content: 'const Version = "2"',
    });
    expect(res.denied).toBe(true);
  });
});
