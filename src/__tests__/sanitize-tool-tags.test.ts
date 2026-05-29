import { describe, expect, it } from "vitest";
import {
  isOnlyToolDebris,
  sanitizeMarkdownForDisplay,
  stripHallucinatedAtlarixToolTagsFromDelta,
  stripMultilineToolJsonEnvelopes,
  stripOrphanToolTagFragments,
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
