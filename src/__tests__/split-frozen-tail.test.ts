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
});
