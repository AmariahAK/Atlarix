/**
 * The point of v14.23.0's memory change is a NUMBER: what these two context sections
 * cost per turn. Both used to paste a whole file into the system prompt (clamped to
 * 3000 chars each, so ~6 KB of every request), which on Core — open-weight, no prompt
 * caching — is paid in full on every turn.
 *
 * So this measures rather than describes. It also pins the two properties that make the
 * pointer safe: it cannot carry a truncation marker, and the instructions pointer names
 * the file's sections so a weak model can tell whether the rules apply.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendIndexLine,
  memoryDirFor,
  setAgentMemoryRootOverride,
} from "@/lib/agent-memory";
import { extractHeadings, readProjectInstructions } from "@/lib/project-memory";

let root: string;
let workspace: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-ptr-root-"));
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-ptr-ws-"));
  setAgentMemoryRootOverride(root);
  delete process.env.ATLARIX_MEMORY;
});

afterEach(async () => {
  setAgentMemoryRootOverride(null);
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

/** A realistic large instructions file: 10 KB with real headings. */
async function writeBigInstructions(): Promise<string> {
  const body = [
    "# Project rules",
    "Follow these strictly.",
    "## Testing",
    "x".repeat(4000),
    "## Style",
    "y".repeat(4000),
    "## Deployment",
    "z".repeat(2000),
  ].join("\n");
  await fs.mkdir(path.join(workspace, ".atlarix"), { recursive: true });
  await fs.writeFile(
    path.join(workspace, ".atlarix", "atlarix.md"),
    body,
    "utf8",
  );
  return body;
}

describe("project-instructions pointer", () => {
  it("reads the file WHOLE — the old 3000-char clamp silently dropped the tail", async () => {
    const body = await writeBigInstructions();
    const res = await readProjectInstructions(workspace);
    expect(res?.content).toBe(body);
    expect(res?.content).not.toContain("...(truncated)");
    // The tail — the part that used to vanish — is present.
    expect(res!.content).toContain("Deployment");
  });

  it("names the sections, so the pointer isn't a coin flip on a weak model", async () => {
    await writeBigInstructions();
    const res = await readProjectInstructions(workspace);
    const headings = extractHeadings(res!.content);
    expect(headings).toEqual([
      "Project rules",
      "Testing",
      "Style",
      "Deployment",
    ]);
    // And the heading list itself stays tiny next to the 10 KB body.
    expect(headings.join(" · ").length).toBeLessThan(200);
  });
});

describe("memory index cost", () => {
  it("20 notes with large bodies cost a few hundred chars, not their size", async () => {
    const dir = memoryDirFor(workspace);
    await fs.mkdir(dir, { recursive: true });
    for (let i = 0; i < 20; i++) {
      // 2 KB each — 40 KB of notes in total.
      await fs.writeFile(
        path.join(dir, `note-${i}.md`),
        "b".repeat(2000),
        "utf8",
      );
      await appendIndexLine(
        workspace,
        `- [Note ${i}](note-${i}.md) — hook ${i}`,
      );
    }

    const { readMemoryIndex } = await import("@/lib/agent-memory");
    const got = await readMemoryIndex(workspace);
    expect(got?.noteCount).toBe(20);

    // The index is what reaches the prompt. 40 KB of notes → well under 1 KB of index.
    expect(got!.index.length).toBeLessThan(1000);
    expect(got!.index).not.toContain("bbbb");
    // Cost grows per NOTE (one line), not per byte — that's the whole design.
    expect(
      got!.index.split("\n").filter((l) => l.startsWith("- ")).length,
    ).toBe(20);
  });
});
