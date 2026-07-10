/**
 * v12 S16 (v13: find_file → glob) — glob must never enumerate secret-path files
 * (.env*, keys, credentials): listing the names leaks that secrets exist and
 * invites a follow-up read. Same policy as read_file (env-secret-paths).
 *
 * glob is ripgrep-backed now (matches by PATTERN), so we assert the two
 * observable contracts that matter with reliable, constrained patterns (not a
 * bare recursive listing, whose ripgrep file-enumeration varies across
 * environments): (1) a glob that targets secrets never enumerates them, and
 * (2) a normal pattern finds real files without ever surfacing a secret.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/glob"; // side-effect: registers the glob tool

let ws: string;

beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-glob-"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".env"), "SECRET=1\n");
  fs.writeFileSync(path.join(ws, ".env.local"), "SECRET=2\n");
  fs.writeFileSync(path.join(ws, "src", "config.ts"), "export const c = 1;\n");
});

afterAll(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

async function findFile(pattern: string): Promise<string> {
  const raw = await ToolRegistry.execute("glob", {
    pattern,
    workspace: ws,
  });
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

describe("glob secret denylist (S16)", () => {
  it("never enumerates .env* files, even when the glob targets them", async () => {
    const out = await findFile(".env*");
    // The no-match guidance may echo the model's own pattern — fine. What must
    // never appear is an enumeration ("Found N file(s)" + the secret names).
    expect(out).not.toContain("Found");
    expect(out).not.toContain(".env.local");
    expect(out).toContain("No files found");
  });

  it("finds normal files by pattern without ever surfacing a secret", async () => {
    const out = await findFile("**/*.ts");
    expect(out).toContain("config.ts");
    expect(out).not.toContain(".env");
  });
});
