import { describe, expect, it } from "vitest";
import { findReplacement, reindentReplacement } from "@/lib/tools/edit-match";

/**
 * First direct unit coverage for the edit_file match cascade (v14.8.7 §D port)
 * and the fuzzy re-indent pass that goes beyond the opencode reference (which
 * splices new_content verbatim — the live Go tab-corruption bug).
 */

describe("findReplacement cascade", () => {
  const content = "def load():\n    value = 1\n    return value\n";

  it("exact match is not fuzzy and reports its strategy", () => {
    const r = findReplacement(content, "    value = 1");
    expect(r).toMatchObject({ kind: "match", fuzzy: false, strategy: "exact" });
  });

  it("exact multi-occurrence reports multiple with count", () => {
    const c = "a()\nb()\na()\n";
    const r = findReplacement(c, "a()");
    expect(r).toMatchObject({ kind: "multiple", occurrences: 2 });
  });

  it("line-trimmed match tolerates indent drift and yields the file's span", () => {
    const r = findReplacement(content, "  value = 1\n  return value");
    expect(r.kind).toBe("match");
    if (r.kind !== "match") return;
    expect(r.fuzzy).toBe(true);
    expect(r.strategy).toBe("line-trimmed");
    expect(content.slice(r.index, r.index + r.matchLength)).toBe(
      "    value = 1\n    return value",
    );
  });

  it("escape-normalized match yields the file's real newlines", () => {
    const r = findReplacement(content, "    value = 1\\n    return value");
    expect(r.kind).toBe("match");
    if (r.kind !== "match") return;
    expect(r.fuzzy).toBe(true);
    expect(content.slice(r.index, r.index + r.matchLength)).toBe(
      "    value = 1\n    return value",
    );
  });

  it("unicode-punctuation match yields the file's original typography", () => {
    const c = "title: “Hello — world”\n";
    const r = findReplacement(c, 'title: "Hello - world"');
    expect(r.kind).toBe("match");
    if (r.kind !== "match") return;
    expect(c.slice(r.index, r.index + r.matchLength)).toBe(
      "title: “Hello — world”",
    );
  });

  it("ambiguous fuzzy candidates are skipped, not guessed", () => {
    // Two distinct lines that both line-trim to the same search → ambiguous
    // for the fuzzy strategies; no exact match exists.
    const c = "  x = 1\n    x = 1\n";
    const r = findReplacement(c, "\tx = 1");
    expect(r.kind).not.toBe("match");
  });

  it("disproportionate block-anchor spans are refused", () => {
    const filler = Array.from({ length: 30 }, (_, i) => `  filler${i}()`).join(
      "\n",
    );
    const c = `start() {\n${filler}\nend()\n`;
    const r = findReplacement(c, "start() {\nmiddle()\nend()");
    expect(["disproportionate", "none"]).toContain(r.kind);
  });
});

describe("reindentReplacement", () => {
  it("verbatim when there is no indent drift (escape/unicode fuzz)", () => {
    const r = reindentReplacement(
      "    value = 1",
      "    value = 1",
      "    value = 2",
    );
    expect(r).toEqual({ text: "    value = 2", changed: false });
  });

  it("re-anchors spaces onto tabs, mapped lines adopt real depth (Go live case)", () => {
    const matched =
      "\t\t\t} else if cancelRequested() {\n\t\t\t\tcancel()\n\t\t\t\treturn quit";
    const old =
      "        } else if cancelRequested() {\n            cancel()\n            return quit";
    const next =
      "        } else if cancelRequested() {\n            snapshot()\n            cancel()\n            return quit";
    const r = reindentReplacement(matched, old, next);
    expect(r.changed).toBe(true);
    expect(r.text).toBe(
      "\t\t\t} else if cancelRequested() {\n\t\t\t\tsnapshot()\n\t\t\t\tcancel()\n\t\t\t\treturn quit",
    );
  });

  it("re-anchors tabs onto spaces (reverse direction)", () => {
    const matched = "    if ok {\n        run()\n    }";
    const old = "\tif ok {\n\t\trun()\n\t}";
    const next = "\tif ok {\n\t\trun()\n\t\tlog()\n\t}";
    const r = reindentReplacement(matched, old, next);
    expect(r.changed).toBe(true);
    expect(r.text).toBe("    if ok {\n        run()\n        log()\n    }");
  });

  it("2-space model onto 4-space file", () => {
    const matched = "def f():\n    a()\n    b()";
    const old = "def f():\n  a()\n  b()";
    const next = "def f():\n  a()\n  c()\n  b()";
    const r = reindentReplacement(matched, old, next);
    expect(r.changed).toBe(true);
    expect(r.text).toBe("def f():\n    a()\n    c()\n    b()");
  });

  it("novel lines nested deeper than any old line extrapolate by unit", () => {
    const matched = "\tif ok {\n\t\trun()\n\t}";
    const old = "  if ok {\n    run()\n  }";
    const next =
      "  if ok {\n    run()\n    if deep {\n      inner()\n    }\n  }";
    const r = reindentReplacement(matched, old, next);
    expect(r.changed).toBe(true);
    expect(r.text).toBe(
      "\tif ok {\n\t\trun()\n\t\tif deep {\n\t\t\tinner()\n\t\t}\n\t}",
    );
  });

  it("repeated closers map monotonically", () => {
    const matched = "\tif a {\n\t\tx()\n\t}\n\tif b {\n\t\ty()\n\t}";
    const old = "  if a {\n    x()\n  }\n  if b {\n    y()\n  }";
    const next = "  if a {\n    x()\n  }\n  if b {\n    z()\n  }";
    const r = reindentReplacement(matched, old, next);
    expect(r.changed).toBe(true);
    expect(r.text).toBe("\tif a {\n\t\tx()\n\t}\n\tif b {\n\t\tz()\n\t}");
  });

  it("single-line matched span only re-anchors the first line", () => {
    const r = reindentReplacement(
      "\t\tcancel()",
      "        cancel()",
      "        snapshot()",
    );
    expect(r.changed).toBe(true);
    expect(r.text).toBe("\t\tsnapshot()");
  });

  it("blank lines pass through untouched", () => {
    const matched = "\tif ok {\n\n\t\trun()\n\t}";
    const old = "  if ok {\n\n    run()\n  }";
    const next = "  if ok {\n\n    run()\n  }";
    const r = reindentReplacement(matched, old, next);
    expect(r.changed).toBe(true);
    expect(r.text).toBe("\tif ok {\n\n\t\trun()\n\t}");
  });

  it("preserves CRLF line endings", () => {
    const matched = "\tif ok {\r\n\t\trun()\r\n\t}";
    const old = "  if ok {\r\n    run()\r\n  }";
    const next = "  if ok {\r\n    stop()\r\n  }";
    const r = reindentReplacement(matched, old, next);
    expect(r.changed).toBe(true);
    expect(r.text).toBe("\tif ok {\r\n\t\tstop()\r\n\t}");
  });

  it("falls back verbatim on mixed tabs+spaces in one leading run", () => {
    const matched = "\t  weird()\n\t\tok()";
    const old = "    weird()\n        ok()";
    const next = "    weird()\n        ok()\n        added()";
    const r = reindentReplacement(matched, old, next);
    expect(r.changed).toBe(false);
    expect(r.text).toBe(next);
  });

  it("falls back verbatim when line counts do not align", () => {
    const r = reindentReplacement(
      "\ta()\n\tb()\n\tc()",
      "  a()\n  b()",
      "  a()\n  z()",
    );
    expect(r).toEqual({ text: "  a()\n  z()", changed: false });
  });

  it("falls back verbatim when nothing maps (full rewrite of the region)", () => {
    const matched = "\told1()\n\told2()";
    const old = "  old1()\n  old2()";
    const next = "  brandNew1()\n  brandNew2()";
    const r = reindentReplacement(matched, old, next);
    expect(r.changed).toBe(false);
  });

  it("never touches non-leading whitespace", () => {
    const matched = '\tmsg := "a  b\tc"';
    const old = '    msg := "a  b\tc"';
    const next = '    msg := "a  b\tc" // note';
    const r = reindentReplacement(matched, old, next);
    expect(r.changed).toBe(true);
    expect(r.text).toBe('\tmsg := "a  b\tc" // note');
  });
});
