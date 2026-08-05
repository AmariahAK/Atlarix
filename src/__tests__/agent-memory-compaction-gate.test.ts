/**
 * Where the compaction directive actually reaches the agent: `edit_file`.
 *
 * All three operations (write / replace / merge) converge on one permission envelope
 * whose `preview.content` is the exact bytes that will land, so one place covers them
 * all — including a sub-agent proposal, which reaches disk through this same tool.
 *
 * The contract under test is that nothing is ever REFUSED for size. Memory compacts like
 * context: the write lands, and the agent is told which notes to rewrite. And it must be
 * inert for every non-memory path — a compaction rule for project memory must never
 * touch ordinary editing.
 *
 * (The other half of the forcing function lives in the prompt: `loadMemoryMdSection`
 * carries the same directive every turn, so it also lands on turns where the agent isn't
 * writing a note at all.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { realpathSync } from "node:fs";

// These tests cross the REAL 25 MB threshold, so each one writes ~26 MB to disk. The
// `node` vitest project sets no explicit timeout, so it inherits vitest's 5 s default —
// ample here on a local SSD (whole file: ~0.5 s) but not a margin worth trusting on a
// Windows runner, where a fresh 26 MB write is scanned as it lands. That exact gap
// produced a Windows-ONLY failure in v14.23.0 (`await import()` charging native load +
// migrations inside a test body). Raise it rather than rediscover it in CI.
vi.setConfig({ testTimeout: 30_000 });
import { ToolRegistry } from "@/lib/tools/registry";
import {
  MEMORY_COMPACT_BYTES,
  memoryDirFor,
  setAgentMemoryRootOverride,
} from "@/lib/agent-memory";
import "@/lib/tools/edit";

const MB = 1024 * 1024;

let ws = "";
let memDir = "";

beforeEach(() => {
  const base = realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-compact-gate-")),
  );
  ws = path.join(base, "workspace");
  fs.mkdirSync(ws, { recursive: true });
  setAgentMemoryRootOverride(path.join(base, "atlarix-home"));
  memDir = memoryDirFor(ws);
  fs.mkdirSync(memDir, { recursive: true });
});

afterEach(() => {
  setAgentMemoryRootOverride(null);
  fs.rmSync(path.dirname(ws), { recursive: true, force: true });
});

/** Fill the memory directory to `bytes` using one filler note. */
function fillMemory(bytes: number): void {
  fs.writeFileSync(path.join(memDir, "filler.md"), "x".repeat(bytes));
}

async function writeNote(name: string, content: string) {
  return (await ToolRegistry.execute("edit_file", {
    workspace: ws,
    path: path.join(memDir, name),
    operation: "write",
    content,
    description: "note",
  })) as {
    __permission_required?: boolean;
    error?: string;
    preview?: { content?: string; notice?: string };
  };
}

describe("edit_file agent-memory compaction directive", () => {
  it("lets an ordinary note through with no directive", async () => {
    const res = await writeNote("note.md", "a small fact\n");
    expect(res.error).toBeUndefined();
    expect(res.__permission_required).toBe(true);
    expect(res.preview?.notice).toBeUndefined();
  });

  it("NEVER refuses a note for size — the write still lands", async () => {
    fillMemory(MEMORY_COMPACT_BYTES + MB); // already past the threshold
    const res = await writeNote("another.md", "y".repeat(2 * MB));
    expect(res.error).toBeUndefined();
    expect(res.__permission_required).toBe(true);
    expect(res.preview?.content).toContain("y");
  });

  it("attaches a one-line compaction flag past the threshold", async () => {
    fillMemory(MEMORY_COMPACT_BYTES + MB);
    const res = await writeNote("note.md", "another fact\n");
    expect(res.preview?.notice).toMatch(/compact/i);
    // Names the biggest note, which is the filler.
    expect(res.preview?.notice).toContain("filler.md");
    // A flag, not a lesson — the agent is already in the store; the convention is one
    // `guides/memory` read away and repeating it here is pure per-call cost.
    expect(res.preview?.notice?.split("\n")).toHaveLength(1);
    expect(res.preview?.notice?.length).toBeLessThan(140);
  });

  it("nudges rather than requires between 80% and the threshold", async () => {
    fillMemory(21 * MB); // 84% of 25 MB
    const res = await writeNote("note.md", "another fact\n");
    expect(res.__permission_required).toBe(true);
    expect(res.preview?.notice).toMatch(/when next open/i);
  });

  it("stops asking as soon as the pending write brings the store back down", async () => {
    // A 24 MB note rewritten to a paragraph is progress on THIS call. Still nagging here
    // would tell the agent to compact the thing it just compacted.
    fs.writeFileSync(path.join(memDir, "huge.md"), "x".repeat(24 * MB));
    const res = await writeNote("huge.md", "the consolidated facts\n");
    expect(res.error).toBeUndefined();
    expect(res.preview?.notice).toBeUndefined();
  });

  it("is inert for a workspace file, however large memory is", async () => {
    fillMemory(MEMORY_COMPACT_BYTES + MB);
    const res = (await ToolRegistry.execute("edit_file", {
      workspace: ws,
      path: "src/app.ts",
      operation: "write",
      content: "export const a = 1;\n",
      description: "ordinary edit",
    })) as {
      error?: string;
      __permission_required?: boolean;
      preview?: { notice?: string };
    };
    expect(res.error).toBeUndefined();
    expect(res.__permission_required).toBe(true);
    expect(res.preview?.notice).toBeUndefined();
  });

  it("is inert for ANOTHER project's memory directory", async () => {
    // Compaction is per project — this workspace's pressure must not drive a different
    // project's note, in either direction.
    const otherDir = memoryDirFor(path.join(path.dirname(ws), "other-workspace"));
    fs.mkdirSync(otherDir, { recursive: true });
    fillMemory(MEMORY_COMPACT_BYTES + MB);
    const res = (await ToolRegistry.execute("edit_file", {
      workspace: ws,
      path: path.join(otherDir, "note.md"),
      operation: "write",
      content: "z".repeat(1024),
      description: "note",
    })) as { error?: string; preview?: { notice?: string } };
    expect(res.preview?.notice ?? "").not.toMatch(/compact/i);
  });

  it("respects ATLARIX_MEMORY=off", async () => {
    fillMemory(MEMORY_COMPACT_BYTES + MB);
    const prev = process.env.ATLARIX_MEMORY;
    process.env.ATLARIX_MEMORY = "off";
    try {
      const res = await writeNote("note.md", "y".repeat(2 * MB));
      expect(res.error).toBeUndefined();
      expect(res.preview?.notice).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.ATLARIX_MEMORY;
      else process.env.ATLARIX_MEMORY = prev;
    }
  });
});
