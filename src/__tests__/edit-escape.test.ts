import { describe, expect, it } from "vitest";
import { analyzeEscaping, repairOverEscaped } from "@/lib/tools/edit-escape";
import { findReplacement } from "@/lib/tools/edit-match";

/**
 * v14.8.7 §B/§D — over-escape detection + repair, and the self-healing replace
 * cascade. Pure-function coverage (no fs).
 */

describe("analyzeEscaping", () => {
  it("repairs a whole file collapsed onto one line with literal \\n", () => {
    // The over-escape symptom: a multi-line file emitted as one physical line.
    const collapsed =
      'import a from "b";\\nimport c from "d";\\n\\nfunction f() {\\n  return 1;\\n}';
    expect(analyzeEscaping(collapsed)).toBe("repair");
    const repaired = repairOverEscaped(collapsed);
    expect(repaired).toContain("\n");
    expect(repaired).not.toContain("\\n");
    expect(repaired.split("\n").length).toBeGreaterThan(3);
  });

  it("leaves a legit one-line file with a \\n string literal untouched (no false positive)", () => {
    // `\n` inside a normal string literal is CORRECT source — must not be touched.
    const legit = 'export const sep = "a\\nb";';
    expect(analyzeEscaping(legit)).toBe("ok");
  });

  it("leaves normal multi-line content (real newlines) untouched", () => {
    const normal = "function f() {\n  return 1;\n}\n";
    expect(analyzeEscaping(normal)).toBe("ok");
  });

  it("leaves a doc mentioning \\n in prose untouched", () => {
    const doc = "Use \\n for a newline.\nThat is the convention.\n";
    // has real newlines + a \n but not at a statement boundary → ok
    expect(analyzeEscaping(doc)).toBe("ok");
  });

  it("hard-blocks ambiguous partial over-escaping (real newlines mixed with structural \\n)", () => {
    const mixed = "function f() {\n  const x = 1;\\n  return x;\\n}\n";
    expect(analyzeEscaping(mixed)).toBe("ambiguous");
  });

  // Live-observed false positive: writing a normal multi-line test file that
  // happens to contain regex literals got hard-blocked as "ambiguous", so the
  // model could never satisfy the retry — its content was already correct. It
  // fell back to shell heredocs, which cascaded their own escaping and produced
  // genuinely broken output. Over-escaping is a per-ARGUMENT failure: a model
  // that escapes newlines escapes all of them. So content dominated by real
  // newlines is by definition not collapsed, whatever `\n` it quotes.
  describe("does not block legitimate code that merely quotes \\n", () => {
    it("a file using a regex literal with \\n after a closing paren", () => {
      const file = [
        "function extractFrontmatter(content) {",
        "  const match = content.match(/^---\\n([\\s\\S]*?)\\n---/)",
        "  if (!match) throw new Error('No frontmatter found')",
        "  return match[1]",
        "}",
      ].join("\n");
      expect(analyzeEscaping(file)).toBe("ok");
    });

    it("a file using join(',\\n') and split('\\n')", () => {
      const file = [
        "export function render(rows) {",
        "  const lines = rows.join(',\\n')",
        "  return lines.split('\\n').filter(Boolean)",
        "}",
      ].join("\n");
      expect(analyzeEscaping(file)).toBe("ok");
    });

    it("a template literal ending a line with },\\n", () => {
      const file = [
        "const tpl = `{",
        '  "a": 1,\\n  "b": 2',
        "}`;",
        "export default tpl;",
      ].join("\n");
      expect(analyzeEscaping(file)).toBe("ok");
    });

    it("still blocks when literal \\n OUTNUMBER the real newlines", () => {
      // The genuine partial-escape shape: most breaks escaped, a couple real.
      const half =
        "function f() {\n  const a = 1;\\n  const b = 2;\\n  const c = 3;\\n  return a;\\n}";
      expect(analyzeEscaping(half)).toBe("ambiguous");
    });
  });
});

describe("findReplacement — unicode punctuation layer (v14.8.10)", () => {
  // A curly-quoted markdown file; the model emits straight-ASCII old_content
  // (the observed "Content to replace not found" loop).
  const md =
    "# Quotes\n\n" +
    "> “Be the change you wish to see.”\n" +
    "> — Mahatma Gandhi\n\n" +
    "> “Stay hungry…”\n" +
    "> – Steve Jobs\n";

  it("matches a curly-quoted line from a straight-quoted find (single line)", () => {
    const r = findReplacement(md, '> "Be the change you wish to see."');
    expect(r.kind).toBe("match");
    if (r.kind === "match") {
      expect(r.fuzzy).toBe(true);
      // The matched span is the ORIGINAL content (typography preserved).
      expect(md.slice(r.index, r.index + r.matchLength)).toContain("“");
    }
  });

  it("matches a multi-line block across em-dash and ellipsis differences", () => {
    const find = '> "Stay hungry..."\n> - Steve Jobs';
    const r = findReplacement(md, find);
    expect(r.kind).toBe("match");
    if (r.kind === "match") {
      expect(md.slice(r.index, r.index + r.matchLength)).toContain("…");
    }
  });

  it("does NOT match when the text genuinely differs", () => {
    const r = findReplacement(md, '> "Be the change you want to see."');
    expect(r.kind).toBe("none");
  });

  it("exact content still wins non-fuzzy when typography matches", () => {
    const r = findReplacement(md, "> — Mahatma Gandhi");
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.fuzzy).toBe(false);
  });
});

describe("findReplacement", () => {
  const file = "import os\n\n\ndef load():\n    value = 1\n    return value\n";

  it("exact unique match is not fuzzy", () => {
    const r = findReplacement(file, "    value = 1\n    return value");
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.fuzzy).toBe(false);
  });

  it("indentation drift self-heals (fuzzy)", () => {
    const r = findReplacement(file, "  value = 1\n  return value");
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.fuzzy).toBe(true);
  });

  it("over-escaped old_content self-heals via EscapeNormalized", () => {
    const r = findReplacement(file, "def load():\\n    value = 1");
    expect(r.kind).toBe("match");
  });

  it("reports multiple exact occurrences", () => {
    const dup = "x = 1\nx = 1\n";
    const r = findReplacement(dup, "x = 1");
    expect(r.kind).toBe("multiple");
    if (r.kind === "multiple") expect(r.occurrences).toBe(2);
  });

  it("returns none when nothing resembles old_content", () => {
    expect(findReplacement(file, "completely absent text").kind).toBe("none");
  });
});
