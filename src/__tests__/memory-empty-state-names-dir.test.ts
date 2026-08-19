/**
 * A workspace with NO notes is still told where notes go.
 *
 * This is the root cause of the two-directory bug. `loadMemoryMdSection` is the only
 * place the absolute memory path is published, and it used to bail on an empty store:
 *
 *     const memory = await readMemoryIndex(appPath);
 *     if (!memory) return null;        // readMemoryIndex is null when notes.length === 0
 *
 * Meanwhile `src/skills/guides/memory.md` tells the agent the memory dir is "path shown
 * in your context". So on a fresh workspace the context said nothing, the skill pointed
 * at nothing, and the agent invented `~/.atlarix/projects/<basename>/memory/` — the
 * obvious human-readable guess. Notes landed outside the store, which kept the store
 * empty, which kept the section hidden. The FIRST note could never be written to the
 * right place, and every attempt raised a sandbox-escalation prompt because the guessed
 * path is outside the grant.
 *
 * The cost side is pinned too: this section renders on EVERY turn, so the empty state
 * has to stay small — a paragraph here is a paragraph on every request, which is the
 * v14.25.0 payload-instead-of-index mistake.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadMemoryMdSection } from "@/ipc/handlers/chat_stream/context-sections";
import {
  appendIndexLine,
  memoryDirFor,
  setAgentMemoryRootOverride,
} from "@/lib/agent-memory";

let root = "";
let workspace = "";

function params() {
  return {
    effectiveWorkMode: "build",
    preflight: { time: async <T>(_l: string, fn: () => Promise<T> | T) => await fn() },
    hasWorkspace: true,
    appPath: workspace,
    effectiveAppId: 1,
    req: {},
  } as unknown as Parameters<typeof loadMemoryMdSection>[0];
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-empty-root-"));
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-empty-ws-"));
  setAgentMemoryRootOverride(root);
  delete process.env.ATLARIX_MEMORY;
});

afterEach(async () => {
  setAgentMemoryRootOverride(null);
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("memory section on an empty store", () => {
  it("names the ABSOLUTE directory, so the first note has somewhere correct to go", async () => {
    const section = await loadMemoryMdSection(params());
    expect(section).not.toBeNull();
    expect(section!.content).toContain(memoryDirFor(workspace));
  });

  it("does not leave the agent to guess the human-readable path", async () => {
    // The exact directory the agent invented on a real machine. It must not be what
    // the prompt implies, and the published path must not merely be a placeholder.
    const section = await loadMemoryMdSection(params());
    const guessed = path.join(root, "projects", path.basename(workspace), "memory");
    expect(section!.content).not.toContain(guessed);
    expect(section!.content).not.toContain("<slug>");
  });

  it("stays small — it renders on every turn until a note exists", async () => {
    const section = await loadMemoryMdSection(params());
    // Generous ceiling; the point is that it can never grow into a paragraph.
    expect(section!.content.length).toBeLessThan(600);
    // Header plus one instruction line.
    expect(section!.content.split("\n").length).toBeLessThanOrEqual(2);
  });

  it("keeps memory OPTIONAL in tone — a note must never displace the user's task", async () => {
    const section = await loadMemoryMdSection(params());
    expect(section!.content).toMatch(/optional/i);
  });

  it("hands over to the real index section as soon as a note exists", async () => {
    const dir = memoryDirFor(workspace);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "thing.md"), "# thing\n", "utf8");
    await appendIndexLine(workspace, "- [Thing](thing.md) — a hook");

    const section = await loadMemoryMdSection(params());
    expect(section!.content).toContain("1 note(s)");
    expect(section!.content).toContain("- [Thing](thing.md) — a hook");
    expect(section!.content).not.toContain("no notes yet");
  });

  it("still renders nothing when memory is switched off entirely", async () => {
    // ATLARIX_MEMORY=off must remove the surface completely, empty store included —
    // benchmark runs carry no memory surface at all.
    process.env.ATLARIX_MEMORY = "off";
    expect(await loadMemoryMdSection(params())).toBeNull();
  });
});
