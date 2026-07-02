import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "@/lib/tools";

/**
 * v14.8.7 §B — edit_file repairs model over-escaping end-to-end (the live-observed
 * bug: 3 Qwens + DeepSeek wrote literal `\n` and couldn't self-recover).
 *
 * The tool returns a __permission_required proposal whose preview.content is the
 * exact bytes that will hit disk — so asserting on preview.content is asserting
 * on the on-disk result.
 */

let ws: string;

beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-escape-"));
  fs.writeFileSync(path.join(ws, "existing.ts"), "export const a = 1;\n");
});

afterAll(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

describe("edit_file over-escape repair (write)", () => {
  it("converts an over-escaped file body to real newlines", async () => {
    const result: any = await ToolRegistry.execute("edit_file", {
      path: "collapsed.ts",
      operation: "write",
      // Whole file collapsed to one physical line with literal backslash-n.
      content:
        'import a from "b";\\nimport c from "d";\\n\\nfunction f() {\\n  return 1;\\n}\\n',
      workspace: ws,
      chatMode: "build",
    });
    expect(result.__permission_required).toBe(true);
    expect(result.preview.content).toContain("\n");
    expect(result.preview.content).not.toContain("\\n");
    expect(result.preview.notice).toContain("over-escaped");
    expect(result.preview.content.split("\n").length).toBeGreaterThan(3);
  });

  it("writes a legit one-line \\n string literal verbatim (no false repair)", async () => {
    const result: any = await ToolRegistry.execute("edit_file", {
      path: "legit.ts",
      operation: "write",
      content: 'export const sep = "a\\nb";',
      workspace: ws,
      chatMode: "build",
    });
    expect(result.__permission_required).toBe(true);
    expect(result.preview.content).toBe('export const sep = "a\\nb";');
    expect(result.preview.notice).toBeUndefined();
  });

  it("hard-blocks ambiguous partial over-escaping with actionable guidance", async () => {
    const result: any = await ToolRegistry.execute("edit_file", {
      path: "mixed.ts",
      operation: "write",
      content: "function f() {\n  const x = 1;\\n  return x;\\n}\n",
      workspace: ws,
      chatMode: "build",
    });
    expect(result.__permission_required).toBeUndefined();
    // edit_file errors ride as { error, operation } → execute wraps them under
    // result.result (they carry no success:false today; C4 unifies this).
    const err = result.result?.error ?? result.error;
    expect(err).toContain("over-escaped");
    expect(String(err).toLowerCase()).toContain("real newline");
  });
});

describe("edit_file removed ops are gone", () => {
  it("rejects operation=insert (op removed in v14.8.7)", async () => {
    const result: any = await ToolRegistry.execute("edit_file", {
      path: "existing.ts",
      operation: "insert",
      line: 1,
      new_content: "// x",
      workspace: ws,
      chatMode: "build",
    });
    expect(result.__permission_required).toBeUndefined();
    const err = result.result?.error ?? result.error;
    expect(err).toContain("Unknown operation");
    expect(err).toContain("write | replace");
  });
});
