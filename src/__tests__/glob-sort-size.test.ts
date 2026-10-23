/**
 * "The largest files" in one read-only call (QA #51): an explore agent with no
 * shell spent 47 reads and 3.9M tokens guessing sizes with regex probes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/glob";

let ws: string;

beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-glob-size-"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  for (const [name, bytes] of [["small.ts", 10], ["big.ts", 5000], ["mid.ts", 900]] as const) {
    fs.writeFileSync(path.join(ws, "src", name), "x".repeat(bytes));
  }
});

afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));

const run = async (args: Record<string, unknown>): Promise<string> => {
  const raw = (await ToolRegistry.execute("glob", { pattern: "src/*.ts", workspace: ws, ...args })) as unknown;
  return typeof raw === "string" ? raw : String((raw as { result?: unknown }).result ?? JSON.stringify(raw));
};

describe("glob sorted by size", () => {
  it("lists largest first, each with its size", async () => {
    const out = await run({ sort: "size" });
    const lines = out.split("\n");
    expect(lines[0]).toBe("Found 3 file(s) (largest first):");
    // With "/" on every system: glob shows paths that way since 15.10.1.
    const p = (name: string) => `src/${name}`;
    expect(lines.slice(1)).toEqual([`${p("big.ts")}  4.9 KB (5000 bytes)`, `${p("mid.ts")}  900 B (900 bytes)`, `${p("small.ts")}  10 B (10 bytes)`]);
  });

  it("keeps newest-first, without sizes, by default", async () => {
    const out = await run({});
    expect(out).toMatch(/^Found 3 file\(s\) \(newest first\):/);
    expect(out).not.toContain("bytes");
  });
});
