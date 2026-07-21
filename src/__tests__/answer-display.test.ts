import { describe, expect, it } from "vitest";
import {
  extractVisibleAnswerMarkdown,
  mapOutsideFences,
  sanitizeMarkdownForDisplay,
} from "@/lib/chat/answer-display";

describe("extractVisibleAnswerMarkdown", () => {
  it("keeps trailing markdown after tool tags", () => {
    const content = [
      '<atlarix-tool-call tool="read_file" status="success"></atlarix-tool-call>',
      '<atlarix-tool-result tool="read_file" status="success"></atlarix-tool-result>',
      "",
      "Here is the final summary for the user.",
    ].join("\n");
    const visible = extractVisibleAnswerMarkdown(content);
    expect(visible).toContain("final summary");
  });

  it("strips unclosed thinking tags from visible answer while streaming", () => {
    const content =
      "<think>Still planning the approach without a close tag yet";
    const visible = extractVisibleAnswerMarkdown(content);
    expect(visible).toBe("");
  });

  it("does not duplicate in-progress thinking into visible answer", () => {
    const content =
      "<think>The user wants an E2E flow explanation.</think>\n\nFinal answer here.";
    const visible = extractVisibleAnswerMarkdown(content);
    expect(visible).not.toContain("E2E flow explanation");
    expect(visible).toContain("Final answer here");
  });

  it("preserves plan artifact markers", () => {
    const marker =
      "<!-- atlarix-plan-artifact:787bb61d-51c9-4476-9370-ee0d7a6a7832 -->";
    const visible = extractVisibleAnswerMarkdown(`${marker}\nShort intro.`);
    expect(visible).toContain("atlarix-plan-artifact");
    expect(visible).toContain("Short intro");
  });
});

describe("sanitizeMarkdownForDisplay — fence awareness", () => {
  it("keeps blank lines INSIDE a fenced code block", () => {
    const s = ["```py", "def a():", "    pass", "", "", "def b():", "    pass", "```"].join(
      "\n",
    );
    // Fenced body is passed through byte-identical; only prose newlines collapse.
    expect(sanitizeMarkdownForDisplay(s)).toBe(s);
  });

  it("keeps JSON-shaped lines inside a code fence (does not strip them)", () => {
    const s = [
      "Example config:",
      "```json",
      '{ "path": "src/a.ts", "mode": "read" }',
      '{ "success": true, "result": "ok" }',
      "```",
    ].join("\n");
    const out = sanitizeMarkdownForDisplay(s);
    expect(out).toContain('{ "path": "src/a.ts", "mode": "read" }');
    expect(out).toContain('{ "success": true, "result": "ok" }');
  });

  it("still strips a tool-result envelope in PROSE (outside a fence)", () => {
    const s = 'Here you go.\n{ "success": true, "result": "done" }\nAll set.';
    const out = sanitizeMarkdownForDisplay(s);
    expect(out).not.toContain('"success"');
    expect(out).toContain("Here you go.");
    expect(out).toContain("All set.");
  });

  it("collapses prose blank lines but not fenced ones in the same string", () => {
    const s = "Intro.\n\n\n```txt\n\n\nbody\n```\n\n\nOutro.";
    const out = sanitizeMarkdownForDisplay(s);
    expect(out).toContain("```txt\n\n\nbody\n```"); // fence body intact
    expect(out).not.toContain("Intro.\n\n\n"); // prose runs collapsed (≤ 1 blank)
    expect(out).not.toContain("```\n\n\nOutro."); // trailing prose collapsed too
  });
});

describe("mapOutsideFences", () => {
  it("does not treat a shorter ``` inside a ```` fence as a closing delimiter", () => {
    const s = "before\n````\n```\ninside\n````\nafter";
    // Uppercasing only outside fences: the whole ```` block stays lowercase.
    const out = mapOutsideFences(s, (seg) => seg.toUpperCase());
    expect(out).toBe("BEFORE\n````\n```\ninside\n````\nAFTER");
  });

  it("is identity when fn is identity", () => {
    const s = "a\n```\nb\n```\nc";
    expect(mapOutsideFences(s, (x) => x)).toBe(s);
  });
});
