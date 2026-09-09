/**
 * Agent memory: per-note, path-keyed, index-only in context.
 *
 * The property that matters most is ISOLATION — two workspaces must never see each
 * other's notes — and it's asserted directly rather than inferred, because it's the
 * reason the store is keyed on the workspace path at all.
 *
 * The second property is COST: only the index reaches the prompt, so a large note can
 * never inflate a turn. That is what the old single injected `memory.md` got wrong.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendIndexLine,
  isAgentMemoryDisabled,
  MEMORY_INDEX_FILE,
  memoryDirFor,
  memoryIndexPathFor,
  migrateLegacyMemoryMd,
  readMemoryIndex,
  setAgentMemoryRootOverride,
  workspaceSlug,
} from "@/lib/agent-memory";

let root: string;
let wsA: string;
let wsB: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-mem-root-"));
  wsA = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-ws-a-"));
  wsB = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-ws-b-"));
  setAgentMemoryRootOverride(root);
  delete process.env.ATLARIX_MEMORY;
});

afterEach(async () => {
  setAgentMemoryRootOverride(null);
  for (const d of [root, wsA, wsB]) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

const writeNote = async (ws: string, name: string, body = "a fact") => {
  const dir = memoryDirFor(ws);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.md`), body, "utf8");
};

describe("workspaceSlug", () => {
  it("is stable for the same path", () => {
    expect(workspaceSlug("/Users/x/proj")).toBe(workspaceSlug("/Users/x/proj"));
  });

  it("distinguishes paths that slugify identically", () => {
    // "/a/b-c" and "/a/b/c" both become "a-b-c" once separators are replaced — the
    // hash suffix is what stops two projects sharing one memory directory.
    expect(workspaceSlug("/a/b-c")).not.toBe(workspaceSlug("/a/b/c"));
  });

  it("stays readable so a directory can be traced back to its project", () => {
    expect(workspaceSlug("/Users/x/my-project")).toContain("my-project");
  });

  it("survives a path with characters that are illegal in filenames", () => {
    const slug = workspaceSlug("/tmp/wéird päth (1)");
    expect(slug).toMatch(/^[a-zA-Z0-9._-]+$/);
  });
});

describe("readMemoryIndex", () => {
  it("returns null when a workspace has no notes — no prompt cost at all", async () => {
    expect(await readMemoryIndex(wsA)).toBeNull();
  });

  it("returns null for an index with no notes behind it", async () => {
    // A leftover index must not advertise memory that isn't there.
    const dir = memoryDirFor(wsA);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, MEMORY_INDEX_FILE),
      "# Memory Index\n",
      "utf8",
    );
    expect(await readMemoryIndex(wsA)).toBeNull();
  });

  it("counts notes and returns the index body", async () => {
    await writeNote(wsA, "stack");
    await appendIndexLine(wsA, "- [Stack](stack.md) — vite + electron");
    const got = await readMemoryIndex(wsA);
    expect(got?.noteCount).toBe(1);
    expect(got?.index).toContain("- [Stack](stack.md) — vite + electron");
  });

  it("does not count the index file itself as a note", async () => {
    await writeNote(wsA, "one");
    await appendIndexLine(wsA, "- [One](one.md) — x");
    expect((await readMemoryIndex(wsA))?.noteCount).toBe(1);
  });

  /** The cost property: note SIZE never reaches the prompt. */
  it("carries the index, never the note bodies", async () => {
    await writeNote(wsA, "huge", "y".repeat(50_000));
    await appendIndexLine(wsA, "- [Huge](huge.md) — a big note");
    const got = await readMemoryIndex(wsA);
    expect(got!.index).not.toContain("yyyy");
    expect(got!.index.length).toBeLessThan(200);
  });
});

describe("isolation between workspaces", () => {
  it("a second workspace sees none of the first's notes", async () => {
    await writeNote(wsA, "a-only");
    await appendIndexLine(wsA, "- [A only](a-only.md) — belongs to A");

    expect((await readMemoryIndex(wsA))?.noteCount).toBe(1);
    // The whole reason the store is path-keyed.
    expect(await readMemoryIndex(wsB)).toBeNull();
  });

  it("the two workspaces resolve to different directories", () => {
    expect(memoryDirFor(wsA)).not.toBe(memoryDirFor(wsB));
  });

  it("notes live outside the workspace, so they are never committed", async () => {
    await writeNote(wsA, "n");
    expect(memoryDirFor(wsA).startsWith(root)).toBe(true);
    expect(memoryDirFor(wsA).startsWith(wsA)).toBe(false);
  });
});

describe("appendIndexLine", () => {
  it("creates the index with a heading on first write", async () => {
    await appendIndexLine(wsA, "- [First](first.md) — hook");
    const body = await fs.readFile(memoryIndexPathFor(wsA), "utf8");
    expect(body).toContain("# Memory Index");
    expect(body).toContain("- [First](first.md) — hook");
  });

  it("is idempotent — the same line is never duplicated", async () => {
    await appendIndexLine(wsA, "- [Dup](dup.md) — hook");
    await appendIndexLine(wsA, "- [Dup](dup.md) — hook");
    const body = await fs.readFile(memoryIndexPathFor(wsA), "utf8");
    expect(body.match(/dup\.md/g)).toHaveLength(1);
  });

  it("keeps earlier lines when adding a new one", async () => {
    await appendIndexLine(wsA, "- [One](one.md) — a");
    await appendIndexLine(wsA, "- [Two](two.md) — b");
    const body = await fs.readFile(memoryIndexPathFor(wsA), "utf8");
    expect(body).toContain("one.md");
    expect(body).toContain("two.md");
  });

  it("ignores an empty line", async () => {
    await appendIndexLine(wsA, "   ");
    await expect(fs.access(memoryIndexPathFor(wsA))).rejects.toThrow();
  });
});

describe("migrateLegacyMemoryMd", () => {
  it("carries a pre-v14.23.0 memory.md into the store with an index line", async () => {
    expect(await migrateLegacyMemoryMd(wsA, "# Stack\nVite + Electron")).toBe(
      true,
    );
    const note = await fs.readFile(
      path.join(memoryDirFor(wsA), "project-notes.md"),
      "utf8",
    );
    expect(note).toContain("name: project-notes");
    expect(note).toContain("type: project");
    expect(note).toContain("Vite + Electron");
    expect(await fs.readFile(memoryIndexPathFor(wsA), "utf8")).toContain(
      "project-notes.md",
    );
  });

  it("is idempotent — safe to call on every turn", async () => {
    await migrateLegacyMemoryMd(wsA, "first");
    // A second call must NOT overwrite: the note may have been edited since.
    expect(await migrateLegacyMemoryMd(wsA, "second")).toBe(false);
    const note = await fs.readFile(
      path.join(memoryDirFor(wsA), "project-notes.md"),
      "utf8",
    );
    expect(note).toContain("first");
    expect(note).not.toContain("second");
  });

  it("does nothing for an empty legacy file", async () => {
    expect(await migrateLegacyMemoryMd(wsA, "   \n ")).toBe(false);
    expect(await readMemoryIndex(wsA)).toBeNull();
  });
});

describe("isAgentMemoryDisabled — the benchmark off-switch", () => {
  it("is enabled by default", () => {
    expect(isAgentMemoryDisabled()).toBe(false);
  });

  it.each(["off", "0", "false", "OFF"])("treats %s as disabled", (v) => {
    process.env.ATLARIX_MEMORY = v;
    expect(isAgentMemoryDisabled()).toBe(true);
  });

  it("stays enabled for any other value", () => {
    process.env.ATLARIX_MEMORY = "on";
    expect(isAgentMemoryDisabled()).toBe(false);
  });
});
