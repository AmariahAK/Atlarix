/**
 * v14.12: glob no longer hides secret-path files. Like opencode / Claude Code,
 * in-workspace files (incl. `.env*`) are enumerable — the agent works over the
 * whole project; the only read-side gate is the workspace boundary.
 *
 * glob is ripgrep-backed (matches by PATTERN), so we assert with reliable,
 * constrained patterns (not a bare recursive listing, whose ripgrep enumeration
 * varies across environments).
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

describe("glob enumerates in-workspace files (incl. .env)", () => {
  it("finds .env* files when the glob targets them", async () => {
    const out = await findFile(".env*");
    expect(out).toContain(".env");
    expect(out).toContain(".env.local");
  });

  it("finds normal source files by pattern", async () => {
    const out = await findFile("**/*.ts");
    expect(out).toContain("config.ts");
  });
});
