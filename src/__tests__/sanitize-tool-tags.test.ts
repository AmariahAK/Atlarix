import { describe, expect, it } from "vitest";
import {
  isOnlyToolDebris,
  sanitizeMarkdownForDisplay,
  stripHallucinatedAtlarixToolTagsFromDelta,
  stripMultilineToolJsonEnvelopes,
  stripOrphanToolTagFragments,
  stripTextEmittedToolCallBlocks,
} from "@/lib/chat/answer-display";

describe("stripHallucinatedAtlarixToolTagsFromDelta", () => {
  it("removes hallucinated tool_calls tags from streaming deltas", () => {
    const raw = 'Done.\n<atlarix-tool_calls tool="write_file">';
    const out = stripHallucinatedAtlarixToolTagsFromDelta(raw);
    expect(out).toBe("Done.\n");
    expect(out).not.toContain("atlarix-tool");
  });
});

describe("stripOrphanToolTagFragments", () => {
  it("removes orphan closing tool-result tags", () => {
    const raw = '</atlarix-tool-result>\n{"message":"Plan created."}';
    const out = stripOrphanToolTagFragments(raw);
    expect(out).not.toContain("atlarix-tool-result");
    expect(out).not.toContain("Plan created");
  });

  it("removes partial tool call openers", () => {
    const raw = '<atlarix-tool-call tool="read_file" status="running">';
    expect(stripOrphanToolTagFragments(raw)).toBe("");
  });
});

describe("sanitizeMarkdownForDisplay", () => {
  it("strips orphan tags from markdown segments", () => {
    const out = sanitizeMarkdownForDisplay(
      "Hello\n</atlarix-tool-result>\nWorld",
    );
    expect(out).toContain("Hello");
    expect(out).toContain("World");
    expect(out).not.toContain("atlarix-tool");
  });
});

describe("stripMultilineToolJsonEnvelopes", () => {
  it("removes multiline success/result envelopes", () => {
    const envelope = [
      "{",
      '  "success": true,',
      '  "result": "# Repo overview\\n\\n## Top-level\\n- src/"',
      "}",
    ].join("\n");
    const out = stripMultilineToolJsonEnvelopes(`${envelope}\n\nAnswer text.`);
    expect(out).not.toContain('"success"');
    expect(out).toContain("Answer text.");
  });
});

describe("stripTextEmittedToolCallBlocks (B1: native-FC text-emitted tool leaks)", () => {
  it("strips a JSON-bodied <ask_user> block (any tool, not just via the parser)", () => {
    const raw =
      'Let me ask.\n<ask_user>{"questions":[{"question":"Tabs or spaces?","options":["Tabs","Spaces"]}]}</ask_user>';
    const out = stripTextEmittedToolCallBlocks(raw);
    expect(out).toContain("Let me ask.");
    expect(out).not.toContain("ask_user");
    expect(out).not.toContain("questions");
  });

  it("strips other tools' leaked calls (read_file, run_command) incl. nested JSON", () => {
    const raw =
      'Reading.\n<read_file>{"path":"src/a.ts","range":{"start":1,"end":9}}</read_file>\nThen:\n<run_command>{"command":"ls"}</run_command>\nDone.';
    const out = stripTextEmittedToolCallBlocks(raw);
    expect(out).toContain("Reading.");
    expect(out).toContain("Then:");
    expect(out).toContain("Done.");
    expect(out).not.toContain("read_file");
    expect(out).not.toContain('"path"');
    expect(out).not.toContain("run_command");
  });

  it("drops an unclosed JSON-bodied opener at the streaming tail", () => {
    const raw = 'Working…\n<ask_user>{"questions":[{"question":"Which env';
    expect(stripTextEmittedToolCallBlocks(raw).trim()).toBe("Working…");
  });

  it("PRESERVES prose/code that merely mentions a tool name (no JSON body)", () => {
    const prose = "Use the `read_file` tool, e.g. <read_file> in docs.";
    expect(stripTextEmittedToolCallBlocks(prose)).toBe(prose);
    const code = "if (x) { doThing(); } // not a tool call";
    expect(stripTextEmittedToolCallBlocks(code)).toBe(code);
  });

  it("is applied by sanitizeMarkdownForDisplay", () => {
    const out = sanitizeMarkdownForDisplay(
      'Hi\n<web_search>{"query":"x"}</web_search>\nBye',
    );
    expect(out).toContain("Hi");
    expect(out).toContain("Bye");
    expect(out).not.toContain("web_search");
  });
});

describe("isOnlyToolDebris", () => {
  it("returns true for JSON-only remnants", () => {
    expect(isOnlyToolDebris('"message": "done"')).toBe(true);
  });

  it("returns true for multiline tool envelopes only", () => {
    const envelope = [
      "{",
      '  "success": true,',
      '  "result": "# Repo overview\\n\\n## Structure"',
      "}",
    ].join("\n");
    expect(isOnlyToolDebris(envelope)).toBe(true);
  });

  it("returns false for real prose", () => {
    expect(isOnlyToolDebris("Here is the answer.")).toBe(false);
  });
});
