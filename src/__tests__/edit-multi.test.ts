import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/edit"; // side-effect: registers edit_file

let ws: string;
const FILE = "src/app.ts";
const BODY = ["const a = 1;", "const b = 2;", "const c = 3;", ""].join("\n");

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-edit-multi-"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, FILE), BODY);
});
afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

async function edit(args: Record<string, unknown>) {
  return (await ToolRegistry.execute("edit_file", {
    path: FILE,
    workspace: ws,
    ...args,
  })) as {
    preview?: { content: string };
    error?: string;
    __permission_required?: boolean;
  };
}

describe("edit_file multi-edit (operation=replace + edits[])", () => {
  it("applies several edits in one call, top to bottom", async () => {
    const res = await edit({
      operation: "replace",
      edits: [
        { old_content: "const a = 1;", new_content: "const a = 10;" },
        { old_content: "const c = 3;", new_content: "const c = 30;" },
      ],
    });
    expect(res.__permission_required).toBe(true);
    expect(res.preview?.content).toContain("const a = 10;");
    expect(res.preview?.content).toContain("const b = 2;"); // untouched
    expect(res.preview?.content).toContain("const c = 30;");
  });

  it("is ATOMIC — a failing edit applies NONE and reports which one", async () => {
    const res = await edit({
      operation: "replace",
      edits: [
        { old_content: "const a = 1;", new_content: "const a = 10;" },
        { old_content: "const NOPE = 9;", new_content: "x" }, // won't match
      ],
    });
    expect(res.__permission_required).toBeUndefined();
    expect(res.preview).toBeUndefined();
    expect(res.error).toMatch(/Edit 2 of 2/);
  });

  it("still supports the single old/new form", async () => {
    const res = await edit({
      operation: "replace",
      old_content: "const b = 2;",
      new_content: "const b = 22;",
    });
    expect(res.preview?.content).toContain("const b = 22;");
  });

  // QA (app) #10: the approval card's summary said "Surgical replace", an
  // internal name, for one edit and "2 edits" for two.
  it("summarises one edit as '1 edit', like '2 edits'", async () => {
    const one = (await edit({
      operation: "replace",
      old_content: "const b = 2;",
      new_content: "const b = 22;",
    })) as { preview?: { description?: string } };
    expect(one.preview?.description).toBe("1 edit");
  });
});
