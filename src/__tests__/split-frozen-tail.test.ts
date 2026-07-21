/**
 * splitFrozenTail freezes completed markdown blocks so only the growing tail
 * re-parses during streaming. It must NEVER cut inside a fenced code block or
 * between the lines of a list/table/blockquote — that would split one construct
 * into two ReactMarkdown roots (broken table, double bullets) mid-stream. Prose
 * paragraphs and headings ARE safe to cut at. Reassembly (frozen + tail) must
 * always equal the input.
 */
import { describe, it, expect } from "vitest";
import { splitFrozenTail } from "@/components/chat/AtlarixMarkdownSegment";

const roundtrips = (s: string) => {
  const { frozen, tail } = splitFrozenTail(s);
  expect(frozen + tail).toBe(s);
};

describe("splitFrozenTail", () => {
  it("freezes completed paragraphs, leaving the growing one as the tail", () => {
    const s = "First paragraph.\nSecond paragraph.\nThird still grow";
    const { frozen, tail } = splitFrozenTail(s);
    expect(frozen).toBe("First paragraph.\nSecond paragraph.");
    expect(tail).toBe("\nThird still grow");
    roundtrips(s);
  });

  it("never cuts inside an open code fence", () => {
    const s = "Intro line.\n```ts\nconst a = 1;\nconst b = 2;";
    const { frozen } = splitFrozenTail(s);
    // The only balanced-fence cut is before the fence opens.
    expect(frozen).toBe("Intro line.");
    roundtrips(s);
  });

  it("keeps a whole list in one block (no cut between items)", () => {
    const s = "Here is a list:\n- one\n- two\n- three";
    const { frozen, tail } = splitFrozenTail(s);
    // Cut is allowed only before the list starts, so items stay together.
    expect(frozen).toBe("Here is a list:");
    expect(tail).toBe("\n- one\n- two\n- three");
    roundtrips(s);
  });

  it("keeps a whole table in one block", () => {
    const s = "Table:\n| a | b |\n| - | - |\n| 1 | 2 |";
    const { frozen } = splitFrozenTail(s);
    expect(frozen).toBe("Table:");
    roundtrips(s);
  });

  it("keeps a blockquote together", () => {
    const s = "Quote:\n> line one\n> line two";
    const { frozen } = splitFrozenTail(s);
    expect(frozen).toBe("Quote:");
    roundtrips(s);
  });

  it("cuts safely after a heading", () => {
    const s = "# Title\nA paragraph after the heading that keeps going";
    const { frozen, tail } = splitFrozenTail(s);
    expect(frozen).toBe("# Title");
    expect(tail).toBe("\nA paragraph after the heading that keeps going");
    roundtrips(s);
  });

  it("returns tail-only when there is no safe cut yet", () => {
    const s = "single growing line with no newline";
    expect(splitFrozenTail(s)).toEqual({ frozen: "", tail: s });
  });

  it("freezes past a closed code fence", () => {
    const s = "Intro.\n```ts\nconst a = 1;\n```\nAfter the fence still typ";
    const { frozen, tail } = splitFrozenTail(s);
    expect(frozen).toBe("Intro.\n```ts\nconst a = 1;\n```");
    expect(tail).toBe("\nAfter the fence still typ");
    roundtrips(s);
  });

  // Regression: a ``` line INSIDE a longer outer fence is content, not a
  // delimiter. The old /```/g parity count toggled on it, flipping parity for
  // every later block so a cut landed mid-fence and spilled the code body out.
  it("does not treat a ``` inside a ```` outer fence as a delimiter", () => {
    const example = "````md\n```\nsome example\n````";
    const s = `${example}\nIntro line.\n\`\`\`json\n{ "a": 1 }`;
    const { frozen, tail } = splitFrozenTail(s);
    // The open json fence + its body must stay TOGETHER in the tail — never cut
    // between the opening fence and its body.
    expect(frozen).toBe(`${example}\nIntro line.`);
    expect(tail).toBe('\n```json\n{ "a": 1 }');
    roundtrips(s);
  });

  it("keeps an open fence's body with its opening fence after an earlier stray fence", () => {
    // Earlier CLOSED block whose body contains a lone ``` line (odd raw count).
    const s = [
      "````md",
      "```", // content of the ```` block, NOT a delimiter
      "````",
      "Now the real block:",
      "```json",
      "__inputs: [",
      '  { "name": "DS_KUBERNETES" }',
    ].join("\n");
    const { frozen, tail } = splitFrozenTail(s);
    // Must freeze up to the prose line and keep the whole open json fence in tail.
    expect(frozen).toBe("````md\n```\n````\nNow the real block:");
    expect(tail).toBe('\n```json\n__inputs: [\n  { "name": "DS_KUBERNETES" }');
    roundtrips(s);
  });

  it("treats ~~~ fences the same as ``` fences", () => {
    const s = "Intro.\n~~~py\nx = 1\ny = 2";
    const { frozen } = splitFrozenTail(s);
    expect(frozen).toBe("Intro.");
    roundtrips(s);
  });
});
