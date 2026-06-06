/**
 * v12 7A — user-agent loader (.atlarix/agents/*.md).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadUserAgent,
  listUserAgents,
  renderUserAgentSystemBlock,
} from "@/lib/agents/user-agents";

let dir: string;
const agentsDir = () => path.join(dir, ".atlarix", "agents");
const writeAgent = (name: string, content: string) => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.writeFileSync(path.join(agentsDir(), `${name}.md`), content);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-agents-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadUserAgent", () => {
  it("parses frontmatter + body", () => {
    writeAgent(
      "reviewer",
      `---
description: Cautious reviewer
mode: ask
model: anthropic/claude-opus-4-8
tools: [read_file, search]
---
You are a meticulous code reviewer. Find bugs, not style nits.`,
    );
    const a = loadUserAgent(dir, "reviewer")!;
    expect(a.name).toBe("reviewer");
    expect(a.description).toBe("Cautious reviewer");
    expect(a.mode).toBe("ask");
    expect(a.model).toBe("anthropic/claude-opus-4-8");
    expect(a.tools).toEqual(["read_file", "search"]);
    expect(a.systemPrompt).toContain("meticulous code reviewer");
  });

  it("defaults mode to build and omits optional fields", () => {
    writeAgent("plain", `---\ndescription: x\n---\nDo the thing.`);
    const a = loadUserAgent(dir, "plain")!;
    expect(a.mode).toBe("build");
    expect(a.model).toBeUndefined();
    expect(a.tools).toBeUndefined();
  });

  it("coerces an invalid mode to build", () => {
    writeAgent("weird", `---\nmode: wizard\n---\nbody`);
    expect(loadUserAgent(dir, "weird")!.mode).toBe("build");
  });

  it("rejects a body-less agent", () => {
    writeAgent("empty", `---\ndescription: x\n---\n   `);
    expect(loadUserAgent(dir, "empty")).toBeNull();
  });

  it("returns null for reserved mode-skill names", () => {
    writeAgent("build-mode", `---\n---\noverride body`);
    expect(loadUserAgent(dir, "build-mode")).toBeNull();
  });

  it("blocks path traversal", () => {
    expect(loadUserAgent(dir, "../secrets")).toBeNull();
    expect(loadUserAgent(dir, "a/b")).toBeNull();
  });

  it("returns null when absent", () => {
    expect(loadUserAgent(dir, "nope")).toBeNull();
  });
});

describe("listUserAgents", () => {
  it("lists .md agents, excludes mode-skill overrides, sorted", () => {
    writeAgent("zeta", `---\n---\nbody`);
    writeAgent("alpha", `---\n---\nbody`);
    writeAgent("ask-mode", `---\n---\nbody`); // reserved → excluded
    fs.writeFileSync(path.join(agentsDir(), "notes.txt"), "ignored");
    expect(listUserAgents(dir).map((a) => a.name)).toEqual(["alpha", "zeta"]);
  });

  it("empty when the dir is absent", () => {
    expect(listUserAgents(dir)).toEqual([]);
  });
});

describe("renderUserAgentSystemBlock", () => {
  it("includes name, description, and body", () => {
    writeAgent("r", `---\ndescription: D\n---\nBODY`);
    const block = renderUserAgentSystemBlock(loadUserAgent(dir, "r")!);
    expect(block).toContain("# Active agent: r");
    expect(block).toContain("D");
    expect(block).toContain("BODY");
  });
});
