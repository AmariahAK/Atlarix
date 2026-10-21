/**
 * The compaction directive has to reach the agent on a turn where it ISN'T writing a
 * note.
 *
 * `edit_file` attaches the directive when a memory write happens, which covers the case
 * where the agent is already in the store. But if memory is over the threshold and the
 * agent simply never opens it again, that path never fires and nothing ever asks. So the
 * flag also rides the memory index whenever a user message carries it (the first message
 * of a session, the first after a compaction, a change notice).
 *
 * Below the threshold that reminder must stay exactly the index — it is saved with the
 * row and replayed on every later request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Same reason as agent-memory-compaction-gate: these cross the real 25 MB threshold, so
// each writes ~26 MB. The `node` project inherits vitest's 5 s default timeout, which is a
// thin margin on a Windows runner scanning a fresh large write — the class of gap that
// caused a Windows-only failure in v14.23.0.
vi.setConfig({ testTimeout: 30_000 });
import { buildMemoryTurnContext } from "@/lib/memory/session-context";
import {
  MEMORY_COMPACT_BYTES,
  appendIndexLine,
  memoryDirFor,
  setAgentMemoryRootOverride,
} from "@/lib/agent-memory";

const MB = 1024 * 1024;

let root = "";
let workspace = "";

/** A first user message of a session: no history, recall stubbed out. */
function firstMessage() {
  return buildMemoryTurnContext({
    workspacePath: workspace,
    scope: null,
    history: [],
    userText: "hello",
    select: async () => [],
  });
}

async function writeNote(name: string, bytes: number) {
  const dir = memoryDirFor(workspace);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), "x".repeat(bytes));
  await appendIndexLine(workspace, `- [${name}](${name}) — a note`);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-memprompt-root-"));
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-memprompt-ws-"));
  setAgentMemoryRootOverride(root);
  delete process.env.ATLARIX_MEMORY;
});

afterEach(async () => {
  setAgentMemoryRootOverride(null);
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("memory index reminder — compaction directive", () => {
  it("carries no directive for a small store", async () => {
    await writeNote("small.md", 2048);
    const text = await firstMessage();
    expect(text).toContain("MEMORY.md");
    expect(text).not.toMatch(/compact/i);
  });

  it("carries the flag once past the threshold, naming the note", async () => {
    await writeNote("huge.md", MEMORY_COMPACT_BYTES + MB);
    const text = await firstMessage();
    const flag = text.split("\n").find((l) => /compact/i.test(l))!;
    expect(flag).toContain("huge.md");
    expect(flag).not.toContain("guides/memory");
  });

  /**
   * The flag, not a lesson: the HOW is in the system header's rules, which are always
   * present. Before the rules moved there, the first version of this cost 147 tokens.
   */
  it("adds only a flag's worth of text, not a lesson", async () => {
    await writeNote("huge.md", MEMORY_COMPACT_BYTES + MB);
    const text = await firstMessage();
    const flagLines = text.split("\n").filter((l) => /compact/i.test(l));
    expect(flagLines).toHaveLength(1);
    expect(flagLines[0]!.length).toBeLessThan(140);
    expect(text).not.toMatch(/non-obvious/i);
    expect(text).not.toMatch(/git history already records/i);
  });

  it("keeps the index alongside the flag", async () => {
    // The flag is additive: losing the index to make room for it would cost the agent
    // the very thing it needs to do the compaction.
    await writeNote("huge.md", MEMORY_COMPACT_BYTES + MB);
    const text = await firstMessage();
    expect(text).toContain("- [huge.md](huge.md) — a note");
  });

  it("goes quiet once the notes are actually compacted", async () => {
    await writeNote("huge.md", MEMORY_COMPACT_BYTES + MB);
    expect(await firstMessage()).toMatch(/compact/i);
    // The agent does the work: rewrites the note far smaller.
    await fs.writeFile(
      path.join(memoryDirFor(workspace), "huge.md"),
      "the consolidated facts\n",
    );
    expect(await firstMessage()).not.toMatch(/compact/i);
  });

  it("is absent entirely under ATLARIX_MEMORY=off", async () => {
    await writeNote("huge.md", MEMORY_COMPACT_BYTES + MB);
    process.env.ATLARIX_MEMORY = "off";
    try {
      expect(await firstMessage()).toBe("");
    } finally {
      delete process.env.ATLARIX_MEMORY;
    }
  });
});
