/**
 * Reclaiming notes an agent wrote to a GUESSED memory directory.
 *
 * The store is keyed by `workspaceSlug()`, which appends a hash. Until this release the
 * absolute path was published to the agent only once notes already existed
 * (`loadMemoryMdSection` returned null on an empty store), while `guides/memory` told
 * it the path was "shown in your context". So on a fresh workspace the agent had
 * nothing to go on and wrote to the obvious human-readable guess,
 * `~/.atlarix/projects/<basename>/memory/` — which kept the real store empty, which
 * kept the path unpublished. Observed on a real machine: three notes stranded in
 * `projects/wisdom-drop/memory/` while `projects/Users-…-wisdom-drop-1upmb8f/memory/`
 * sat empty, and every note write raised a sandbox-escalation prompt because the
 * guessed path is outside the grant.
 *
 * `adoptMisplacedMemoryDir` MOVES those notes. Deletion is the point — a second store
 * left behind is what caused the confusion, and removing it means a second workspace
 * sharing the basename has nothing left to also adopt. That makes verify-before-delete
 * the load-bearing guarantee, so it is pinned hardest here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  adoptMisplacedMemoryDir,
  MEMORY_INDEX_FILE,
  memoryDirFor,
  readMemoryIndex,
  setAgentMemoryRootOverride,
} from "@/lib/agent-memory";

let root: string;
let ws: string;

/** The directory an agent invents when it has no path to go on. */
function guessedDirFor(workspacePath: string): string {
  return path.join(root, "projects", path.basename(workspacePath), "memory");
}

async function writeNote(dir: string, name: string, body: string) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), body, "utf8");
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-adopt-root-"));
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-adopt-ws-"));
  setAgentMemoryRootOverride(root);
  delete process.env.ATLARIX_MEMORY;
});

afterEach(async () => {
  setAgentMemoryRootOverride(null);
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(ws, { recursive: true, force: true });
});

describe("adoptMisplacedMemoryDir", () => {
  it("moves stranded notes into the real store and removes the guessed directory", async () => {
    const guessed = guessedDirFor(ws);
    await writeNote(guessed, "project-overview.md", "# overview\n");
    await writeNote(guessed, "adding-quotes.md", "# quotes\n");
    await writeNote(
      guessed,
      MEMORY_INDEX_FILE,
      "# Memory Index\n\n- [Overview](project-overview.md)\n",
    );

    expect(await adoptMisplacedMemoryDir(ws)).toBe(true);

    const index = await readMemoryIndex(ws);
    expect(index?.noteCount).toBe(2);
    expect(index?.index).toContain("Overview");
    // The whole point: no second store left behind.
    await expect(fs.access(path.dirname(guessed))).rejects.toThrow();
  });

  it("carries the index across, not just the notes", async () => {
    const guessed = guessedDirFor(ws);
    await writeNote(guessed, "a.md", "# a\n");
    await writeNote(
      guessed,
      MEMORY_INDEX_FILE,
      "# Memory Index\n\n- [A](a.md) — hook\n",
    );

    await adoptMisplacedMemoryDir(ws);

    const carried = await fs.readFile(
      path.join(memoryDirFor(ws), MEMORY_INDEX_FILE),
      "utf8",
    );
    expect(carried).toContain("- [A](a.md) — hook");
  });

  it("refuses when the real store already holds notes — never overwrite", async () => {
    await writeNote(memoryDirFor(ws), "real.md", "# the real one\n");
    const guessed = guessedDirFor(ws);
    await writeNote(guessed, "stranded.md", "# stranded\n");

    expect(await adoptMisplacedMemoryDir(ws)).toBe(false);
    // Source untouched, so nothing is lost and it can be resolved by hand.
    await expect(
      fs.access(path.join(guessed, "stranded.md")),
    ).resolves.toBeUndefined();
    expect((await readMemoryIndex(ws))?.noteCount).toBe(1);
  });

  it("refuses a directory stamped for a DIFFERENT workspace", async () => {
    // Two projects can share a basename (/a/api, /b/api). The stamp is what stops the
    // second one taking notes the first already claimed.
    const guessed = guessedDirFor(ws);
    await writeNote(guessed, "note.md", "# note\n");
    await fs.writeFile(
      path.join(path.dirname(guessed), ".workspace"),
      "/somewhere/else/entirely\n",
      "utf8",
    );

    expect(await adoptMisplacedMemoryDir(ws)).toBe(false);
    await expect(
      fs.access(path.join(guessed, "note.md")),
    ).resolves.toBeUndefined();
  });

  it("writes a .workspace stamp so ownership stops being a guess", async () => {
    const guessed = guessedDirFor(ws);
    await writeNote(guessed, "note.md", "# note\n");

    await adoptMisplacedMemoryDir(ws);

    const stamp = await fs.readFile(
      path.join(path.dirname(memoryDirFor(ws)), ".workspace"),
      "utf8",
    );
    expect(stamp.trim()).toBe(path.resolve(ws));
  });

  it("is a no-op when there is nothing stranded, and is safe to call every turn", async () => {
    expect(await adoptMisplacedMemoryDir(ws)).toBe(false);
    expect(await adoptMisplacedMemoryDir(ws)).toBe(false);

    const guessed = guessedDirFor(ws);
    await writeNote(guessed, "note.md", "# note\n");
    expect(await adoptMisplacedMemoryDir(ws)).toBe(true);
    // Second call has nothing left to do and must not throw or undo anything.
    expect(await adoptMisplacedMemoryDir(ws)).toBe(false);
    expect((await readMemoryIndex(ws))?.noteCount).toBe(1);
  });

  it("ignores MEMORY.md when deciding whether anything is stranded", async () => {
    // An index with no notes is a leftover, not a store worth adopting.
    const guessed = guessedDirFor(ws);
    await writeNote(guessed, MEMORY_INDEX_FILE, "# Memory Index\n");
    expect(await adoptMisplacedMemoryDir(ws)).toBe(false);
    await expect(fs.access(guessed)).resolves.toBeUndefined();
  });

  it("does not adopt from itself when the basename already yields the store", async () => {
    // Guard against a path shape where candidate and target resolve to the same dir —
    // adopting would then delete the store it just populated.
    const real = memoryDirFor(ws);
    await writeNote(real, "note.md", "# note\n");
    await adoptMisplacedMemoryDir(ws);
    await expect(
      fs.access(path.join(real, "note.md")),
    ).resolves.toBeUndefined();
  });
});
