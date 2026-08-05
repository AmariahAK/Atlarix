/**
 * The compaction directive has to reach the agent on a turn where it ISN'T writing a
 * note.
 *
 * `edit_file` attaches the directive when a memory write happens, which covers the case
 * where the agent is already in the store. But if memory is over the threshold and the
 * agent simply never opens it again, that path never fires and nothing ever asks. The
 * memory prompt section carries the same directive every turn, which is what makes this
 * a forcing function rather than a message it saw once.
 *
 * Below the threshold the section must stay exactly as it was — this is a section that
 * is paid for on every request, on Core with no prompt caching.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadMemoryMdSection } from "@/ipc/handlers/chat_stream/context-sections";
import {
  MEMORY_COMPACT_BYTES,
  appendIndexLine,
  memoryDirFor,
  setAgentMemoryRootOverride,
} from "@/lib/agent-memory";

const MB = 1024 * 1024;

let root = "";
let workspace = "";

/** Minimal params — the section only reads `preflight`, `hasWorkspace` and `appPath`. */
function params() {
  return {
    effectiveWorkMode: "build",
    preflight: { time: async <T>(_label: string, fn: () => Promise<T> | T) => await fn() },
    hasWorkspace: true,
    appPath: workspace,
    effectiveAppId: 1,
    req: {},
  } as unknown as Parameters<typeof loadMemoryMdSection>[0];
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

describe("memory prompt section — compaction directive", () => {
  it("carries no directive for a small store", async () => {
    await writeNote("small.md", 2048);
    const section = await loadMemoryMdSection(params());
    expect(section).not.toBeNull();
    expect(section?.content).not.toMatch(/compact/i);
  });

  it("carries the flag on the header line once past the threshold", async () => {
    await writeNote("huge.md", MEMORY_COMPACT_BYTES + MB);
    const section = await loadMemoryMdSection(params());
    const header = section!.content.split("\n")[0]!;
    expect(header).toMatch(/compact/i);
    expect(header).toContain("huge.md");
    expect(header).toContain("guides/memory");
  });

  /**
   * The per-turn cost is the point.
   *
   * This section renders on EVERY dispatch, so the first version of this signal — a
   * 147-token paragraph — was 147 tokens on every request until the store shrank
   * (~7,350 over a 50-turn session), on Core with no prompt caching. That is the
   * payload-instead-of-index mistake v14.25.0 existed to undo, reintroduced.
   *
   * The flag now adds ~24 tokens to a header line that was already being paid for, and
   * the convention stays behind the `guides/memory` pointer the section already carries.
   */
  it("adds only a flag's worth of text, not a lesson", async () => {
    await writeNote("small.md", 2048);
    const before = (await loadMemoryMdSection(params()))!.content;

    await writeNote("huge.md", MEMORY_COMPACT_BYTES + MB);
    const after = (await loadMemoryMdSection(params()))!.content;

    // The delta is dominated by the new index line for huge.md, not by the directive.
    const headerBefore = before.split("\n")[0]!;
    const headerAfter = after.split("\n")[0]!;
    expect(headerAfter.length - headerBefore.length).toBeLessThan(120);
    // No instruction prose — that belongs in the guide.
    expect(after).not.toMatch(/non-obvious/i);
    expect(after).not.toMatch(/git history already records/i);
    // Still one line for the header, so it cannot grow into a block unnoticed.
    expect(headerAfter.split("\n")).toHaveLength(1);
  });

  it("keeps the index and the read pointer alongside the flag", async () => {
    // The flag is additive: losing the index to make room for it would cost the agent
    // the very thing it needs to do the compaction.
    await writeNote("huge.md", MEMORY_COMPACT_BYTES + MB);
    const section = await loadMemoryMdSection(params());
    expect(section?.content).toContain("Project memory —");
    expect(section?.content).toContain("read_file");
    expect(section?.content).toContain("guides/memory");
    expect(section?.content).toContain("huge.md");
  });

  it("repeats on every turn while the store is still over", async () => {
    // Idempotent by construction (computed per turn from disk), which is what stops a
    // one-shot notice from being ignored forever.
    await writeNote("huge.md", MEMORY_COMPACT_BYTES + MB);
    const a = await loadMemoryMdSection(params());
    const b = await loadMemoryMdSection(params());
    expect(a?.content).toBe(b?.content);
    expect(b!.content.split("\n")[0]).toMatch(/compact/i);
  });

  it("goes quiet once the notes are actually compacted", async () => {
    await writeNote("huge.md", MEMORY_COMPACT_BYTES + MB);
    expect((await loadMemoryMdSection(params()))?.content).toMatch(/compact/i);
    // The agent does the work: rewrites the note far smaller.
    await fs.writeFile(
      path.join(memoryDirFor(workspace), "huge.md"),
      "the consolidated facts\n",
    );
    expect((await loadMemoryMdSection(params()))?.content).not.toMatch(/compact/i);
  });

  it("is absent entirely under ATLARIX_MEMORY=off", async () => {
    await writeNote("huge.md", MEMORY_COMPACT_BYTES + MB);
    process.env.ATLARIX_MEMORY = "off";
    try {
      expect(await loadMemoryMdSection(params())).toBeNull();
    } finally {
      delete process.env.ATLARIX_MEMORY;
    }
  });
});
