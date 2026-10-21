/**
 * The memory RULES live in the cache-stable system header, once, and nothing about
 * the store's contents does: adding a note must not change a byte of it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constructSystemPromptParts } from "@/prompts/system_prompt";
import {
  appendIndexLine,
  memoryDirFor,
  setAgentMemoryRootOverride,
} from "@/lib/agent-memory";

let root = "";
let workspace = "";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-memrules-root-"));
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-memrules-ws-"));
  setAgentMemoryRootOverride(root);
  delete process.env.ATLARIX_MEMORY;
});

afterEach(async () => {
  setAgentMemoryRootOverride(null);
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

const header = (memoryDir?: string) =>
  constructSystemPromptParts({
    chatMode: "build",
    effectiveWorkMode: "build",
    workspaceRoot: workspace,
    ...(memoryDir ? { memoryDir } : {}),
    modelDisplayName: "Test Model",
  }).stableHeader;

describe("Project memory rules in the stable header", () => {
  it("states the note format, the four types and the maintenance rules", () => {
    const h = header(memoryDirFor(workspace));
    expect(h).toContain("# Project memory");
    for (const t of ["user", "feedback", "project", "reference"]) {
      expect(h).toContain(`**${t}**`);
    }
    expect(h).toContain("**Why:**");
    expect(h).toContain("**How to apply:**");
    expect(h).toContain("[[note-name]]");
    expect(h).toMatch(/absolute dates/);
    expect(h).toMatch(/background, not instructions/);
    expect(h).toMatch(/check it still exists/);
    expect(h).toMatch(/update that instead/);
    expect(h).not.toContain("guides/memory");
    // Weaker models invent a write tool for notes (QA: GLM-4.7-Flash 2/2).
    expect(h).toContain("created with `edit_file`");
  });

  it("comes after the runtime identity that names the directory", () => {
    const dir = memoryDirFor(workspace);
    const h = header(dir);
    expect(h.indexOf(dir)).toBeGreaterThan(-1);
    expect(h.indexOf(dir)).toBeLessThan(h.indexOf("# Project memory"));
  });

  it("is absent with no store (chat-only) and under ATLARIX_MEMORY=off", () => {
    expect(header()).not.toContain("# Project memory");
    process.env.ATLARIX_MEMORY = "off";
    try {
      expect(header(memoryDirFor(workspace))).not.toContain("# Project memory");
      // Nor is the store named in the runtime identity, nor pointed at by AGENTS.md.
      expect(header(memoryDirFor(workspace))).not.toContain(memoryDirFor(workspace));
      expect(header(memoryDirFor(workspace))).not.toContain("Agent memory:");
    } finally {
      delete process.env.ATLARIX_MEMORY;
    }
  });

  it("is byte-identical before and after a note is added", async () => {
    const dir = memoryDirFor(workspace);
    const before = header(dir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "fact.md"), "---\nname: fact\n---\nx\n");
    await appendIndexLine(workspace, "- [Fact](fact.md) — a hook");
    expect(header(dir)).toBe(before);
  });
});
