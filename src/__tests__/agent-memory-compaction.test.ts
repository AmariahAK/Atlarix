/**
 * Agent memory COMPACTS; it is never capped.
 *
 * Notes are written indefinitely and nothing ever pruned them. Prompt cost is already
 * bounded (only the one-line index is injected), so the failure mode isn't token spend —
 * it is an index whose entries increasingly point at bloated, redundant notes nobody
 * rewrote.
 *
 * So memory is treated exactly like context: past a threshold the harness tells the
 * agent to rewrite specific notes more accurately, and keeps telling it until the store
 * is smaller. Nothing is refused and nothing is deleted to make room. A hard ceiling
 * would fail the one write that mattered — often the consolidating one — and would make
 * the agent's first signal a failure.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MEMORY_COMPACT_BYTES,
  MEMORY_COMPACT_NUDGE_RATIO,
  isAgentMemoryPath,
  listMemoryNoteSizes,
  memoryDirBytes,
  memoryDirFor,
  planMemoryCompaction,
  setAgentMemoryRootOverride,
} from "@/lib/agent-memory";

const MB = 1024 * 1024;

/** Notes summing to `total`, spread over `count` files, largest first. */
function notes(total: number, count = 3) {
  const each = Math.floor(total / count);
  return Array.from({ length: count }, (_, i) => ({
    name: `note-${i}.md`,
    bytes: i === 0 ? total - each * (count - 1) : each,
  }));
}

describe("planMemoryCompaction", () => {
  it("says nothing for a small store", () => {
    expect(planMemoryCompaction({ notes: notes(2 * MB) })).toBeNull();
  });

  it("raises a nudge past 80% without requiring a pass", () => {
    const plan = planMemoryCompaction({
      notes: notes(MEMORY_COMPACT_BYTES * MEMORY_COMPACT_NUDGE_RATIO + MB),
    });
    expect(plan).not.toBeNull();
    expect(plan?.required).toBe(false);
    expect(plan?.flag).toMatch(/when next open/);
  });

  it("requires compaction past the threshold", () => {
    const plan = planMemoryCompaction({
      notes: notes(MEMORY_COMPACT_BYTES + MB),
    });
    expect(plan?.required).toBe(true);
    expect(plan?.flag).toMatch(/compact/i);
    expect(plan?.flag).not.toMatch(/when next open/);
  });

  it("names the LARGEST notes, largest first", () => {
    const plan = planMemoryCompaction({
      notes: [
        { name: "small.md", bytes: 1024 },
        { name: "biggest.md", bytes: 20 * MB },
        { name: "middle.md", bytes: 6 * MB },
      ],
    });
    expect(plan?.targets.map((t) => t.name)).toEqual([
      "biggest.md",
      "middle.md",
      "small.md",
    ]);
    expect(plan?.flag.indexOf("biggest.md")).toBeLessThan(
      plan!.flag.indexOf("middle.md"),
    );
  });

  /**
   * The signal is a FLAG, not a lesson.
   *
   * It rides the memory index reminder and every memory write's notice. The first
   * version of this cost a measured 147 tokens a turn, which is exactly the
   * payload-instead-of-index mistake v14.25.0 existed to undo. The current flag is 24.
   *
   * This test is the guard against it creeping back: the HOW belongs in the system
   * header's "Project memory" rules, which are always there.
   */
  it("stays a flag — short, and no re-teaching of the convention", () => {
    const plan = planMemoryCompaction({
      notes: notes(MEMORY_COMPACT_BYTES + MB),
    });
    expect(plan!.flag.length).toBeLessThan(120);
    expect(plan!.flag.split("\n")).toHaveLength(1);
    // Instruction prose that belongs in the guide, not in every dispatch.
    expect(plan!.flag).not.toMatch(/non-obvious/i);
    expect(plan!.flag).not.toMatch(/git history/i);
    expect(plan!.flag).not.toMatch(/do not delete/i);
  });

  it("points at no guide — the removed guides/memory must not be named", () => {
    const plan = planMemoryCompaction({
      notes: notes(MEMORY_COMPACT_BYTES + MB),
    });
    expect(plan?.flag).not.toContain("guides/memory");
    expect(plan?.flag).toMatch(/compact .* now$/);
  });

  it("never names the index file as a compaction target", () => {
    // MEMORY.md is one line per note by construction — compacting it would mean
    // dropping pointers, which loses notes rather than tightening them.
    const plan = planMemoryCompaction({
      notes: [
        { name: "MEMORY.md", bytes: 24 * MB },
        { name: "real-note.md", bytes: 2 * MB },
      ],
    });
    expect(plan?.targets.map((t) => t.name)).toEqual(["real-note.md"]);
  });

  it("counts a pending write in place of the note it replaces", () => {
    // A 24 MB note being rewritten to 1 KB is progress on THIS call, not one write
    // later — otherwise the agent is told to compact the very thing it just compacted.
    const plan = planMemoryCompaction({
      notes: [{ name: "huge.md", bytes: 24 * MB }],
      pendingWrite: { name: "huge.md", bytes: 1024 },
    });
    expect(plan).toBeNull();
  });

  it("counts a pending NEW note as added", () => {
    const plan = planMemoryCompaction({
      notes: [{ name: "a.md", bytes: 20 * MB }],
      pendingWrite: { name: "b.md", bytes: 6 * MB },
    });
    expect(plan?.required).toBe(true);
  });

  it("compacts per project at 25 MB", () => {
    expect(MEMORY_COMPACT_BYTES).toBe(25 * MB);
  });
});

describe("listMemoryNoteSizes / memoryDirBytes / isAgentMemoryPath", () => {
  let root = "";
  const workspace = "/Users/someone/code/project-x";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-mem-budget-"));
    setAgentMemoryRootOverride(root);
  });

  afterEach(() => {
    setAgentMemoryRootOverride(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns nothing when there is no memory directory yet", async () => {
    expect(await listMemoryNoteSizes(workspace)).toEqual([]);
    expect(await memoryDirBytes(workspace)).toBe(0);
  });

  it("lists notes largest first and sums them", async () => {
    const dir = memoryDirFor(workspace);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "x".repeat(100));
    fs.writeFileSync(path.join(dir, "a.md"), "y".repeat(250));
    fs.writeFileSync(path.join(dir, "b.md"), "z".repeat(650));
    expect(await listMemoryNoteSizes(workspace)).toEqual([
      { name: "b.md", bytes: 650 },
      { name: "a.md", bytes: 250 },
      { name: "MEMORY.md", bytes: 100 },
    ]);
    expect(await memoryDirBytes(workspace)).toBe(1000);
  });

  it("ignores subdirectories rather than throwing on them", async () => {
    const dir = memoryDirFor(workspace);
    fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a.md"), "y".repeat(10));
    expect(await memoryDirBytes(workspace)).toBe(10);
  });

  it("recognizes a note path and rejects everything else", () => {
    const dir = memoryDirFor(workspace);
    expect(isAgentMemoryPath(workspace, path.join(dir, "note.md"))).toBe(true);
    expect(isAgentMemoryPath(workspace, dir)).toBe(false); // the dir itself is not a note
    expect(
      isAgentMemoryPath(workspace, path.join(dir, "..", "escape.md")),
    ).toBe(false);
    expect(isAgentMemoryPath(workspace, "/etc/passwd")).toBe(false);
  });

  it("is scoped to ONE project — another workspace's notes are not this one's", () => {
    // Isolation is structural (slug = path + hash), and compaction pressure must not
    // leak across projects in either direction.
    const otherDir = memoryDirFor("/Users/someone/code/project-y");
    expect(isAgentMemoryPath(workspace, path.join(otherDir, "note.md"))).toBe(
      false,
    );
  });
});
