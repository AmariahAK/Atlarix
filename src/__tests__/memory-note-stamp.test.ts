/**
 * Notes the agent writes are stamped with `metadata.modified` and
 * `metadata.originSessionId` — on the bytes that land, so the approval diff, the
 * write and the read-before-edit record all see the same note.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { realpathSync } from "node:fs";
import { ToolRegistry } from "@/lib/tools/registry";
import { memoryDirFor, setAgentMemoryRootOverride } from "@/lib/agent-memory";
import {
  readNoteFrontmatter,
  stampNoteFrontmatter,
} from "@/lib/memory/note-frontmatter";
import "@/lib/tools/edit";

const NOTE = `---
name: deploy-order
description: deploy the proxy first
metadata:
  type: project
---

Deploy the proxy first.
`;

describe("stampNoteFrontmatter", () => {
  const stamp = { modified: "2026-10-21T12:00:00.000Z", originSessionId: "s-1" };

  it("adds both fields inside metadata and leaves the rest byte for byte", () => {
    const out = stampNoteFrontmatter(NOTE, stamp);
    expect(out).toBe(NOTE.replace(
      "  type: project\n",
      "  type: project\n  modified: 2026-10-21T12:00:00.000Z\n  originSessionId: s-1\n",
    ));
    expect(readNoteFrontmatter(out)).toMatchObject({
      name: "deploy-order",
      description: "deploy the proxy first",
      type: "project",
      modified: "2026-10-21T12:00:00.000Z",
    });
  });

  it("replaces existing stamps instead of adding a second pair", () => {
    const once = stampNoteFrontmatter(NOTE, stamp);
    const twice = stampNoteFrontmatter(once, { modified: "2026-10-22T00:00:00.000Z", originSessionId: "s-2" });
    expect(twice.match(/modified:/g)).toHaveLength(1);
    expect(twice.match(/originSessionId:/g)).toHaveLength(1);
    expect(twice).toContain("  modified: 2026-10-22T00:00:00.000Z");
    expect(twice).toContain("  originSessionId: s-2");
  });

  it("adds a metadata block to a note without one", () => {
    const bare = "---\nname: a\ndescription: b\ntype: user\n---\nbody\n";
    const out = stampNoteFrontmatter(bare, stamp);
    expect(out).toBe(
      "---\nname: a\ndescription: b\ntype: user\nmetadata:\n  modified: 2026-10-21T12:00:00.000Z\n  originSessionId: s-1\n---\nbody\n",
    );
  });

  it("keeps the note's own indentation and CRLF line endings", () => {
    const crlf = NOTE.replace("  type", "    type").replace(/\n/g, "\r\n");
    const out = stampNoteFrontmatter(crlf, { modified: "M" });
    expect(out).toContain("\r\n    modified: M\r\n---");
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("leaves a file with no frontmatter alone", () => {
    expect(stampNoteFrontmatter("just text\n", stamp)).toBe("just text\n");
  });
});

describe("edit_file stamps memory notes", () => {
  let ws = "";
  let memDir = "";

  beforeEach(() => {
    const base = realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-stamp-")));
    ws = path.join(base, "workspace");
    fs.mkdirSync(ws, { recursive: true });
    setAgentMemoryRootOverride(path.join(base, "atlarix-home"));
    memDir = memoryDirFor(ws);
    fs.mkdirSync(memDir, { recursive: true });
    delete process.env.ATLARIX_MEMORY;
  });

  afterEach(() => {
    setAgentMemoryRootOverride(null);
    fs.rmSync(path.dirname(ws), { recursive: true, force: true });
  });

  async function write(target: string, content: string) {
    return (await ToolRegistry.execute("edit_file", {
      workspace: ws,
      path: target,
      operation: "write",
      content,
      description: "note",
      _scopeSessionId: "session-uuid-1",
    })) as { preview?: { content?: string; lines?: number } };
  }

  it("stamps modified and originSessionId on a note", async () => {
    const before = Date.now();
    const res = await write(path.join(memDir, "deploy-order.md"), NOTE);
    const fm = readNoteFrontmatter(res.preview!.content!);
    expect(Date.parse(fm.modified!)).toBeGreaterThanOrEqual(before - 1000);
    expect(res.preview!.content).toContain("  originSessionId: session-uuid-1");
    expect(res.preview!.content).toContain("Deploy the proxy first.");
    expect(res.preview!.lines).toBe(res.preview!.content!.split("\n").length);
  });

  it("does not stamp MEMORY.md", async () => {
    // Even an index someone gave a frontmatter block: the index is pointers, not a note.
    const index = "---\nname: index\n---\n# Memory Index\n\n- [A](a.md) — hook\n";
    const res = await write(path.join(memDir, "MEMORY.md"), index);
    expect(res.preview!.content).toBe(index);
  });

  it("does not touch a workspace file that looks like a note", async () => {
    const res = await write("docs/note.md", NOTE);
    expect(res.preview!.content).toBe(NOTE);
  });

  it("does nothing under ATLARIX_MEMORY=off", async () => {
    process.env.ATLARIX_MEMORY = "off";
    try {
      const res = await write(path.join(memDir, "deploy-order.md"), NOTE);
      expect(res.preview!.content).toBe(NOTE);
    } finally {
      delete process.env.ATLARIX_MEMORY;
    }
  });
});
