/**
 * v12 S16 — find_file must never enumerate secret-path files (.env*, keys,
 * credentials): listing the names leaks that secrets exist and invites a
 * follow-up read. Same policy as read_file/list_files (env-secret-paths).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/file"; // side-effect: registers the file tools

let ws: string;

beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-findfile-"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".env"), "SECRET=1\n");
  fs.writeFileSync(path.join(ws, ".env.local"), "SECRET=2\n");
  fs.writeFileSync(path.join(ws, "src", "config.ts"), "export const c = 1;\n");
});

afterAll(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

async function findFile(pattern: string): Promise<string> {
  const raw = await ToolRegistry.execute("find_file", {
    pattern,
    workspace: ws,
  });
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

describe("find_file secret denylist (S16)", () => {
  it("does not enumerate .env* files even when the glob targets them", async () => {
    const out = await findFile(".env*");
    // The no-match guidance echoes the model's own pattern — fine. What must
    // never appear is an enumeration ("Found N file(s)" + names).
    expect(out).not.toContain("Found");
    expect(out).not.toContain(".env.local");
    expect(out).toContain("No files found");
  });

  it("filters secrets out of broader matches but keeps normal files", async () => {
    const out = await findFile("**/*");
    expect(out).toContain("config.ts");
    expect(out).not.toContain(".env");
  });
});
