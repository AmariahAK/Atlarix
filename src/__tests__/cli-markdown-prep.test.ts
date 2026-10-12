/**
 * Markdown made to read well in a terminal (src/cli/tui/markdown-prep.ts):
 * the app's visual fences become text, and a table is closed before prose.
 */
import { describe, expect, it } from "vitest";
import { prepareMarkdown, settleStreaming } from "@/cli/tui/markdown-prep";
import { oneLine } from "@/cli/tui/format";

describe("markdown for the terminal", () => {
  it("a graph fence becomes its edges, not raw JSON", () => {
    const md = 'Here:\n\n```graph\n{"title":"Arch","nodes":[{"id":"web","name":"Web"},{"id":"api","name":"API"},{"id":"db","name":"Postgres"}],"edges":[{"source":"web","target":"api"}]}\n```\nDone.';
    expect(prepareMarkdown(md)).toBe("Here:\n\n**Arch**\n- Web → API\n- Postgres\nDone.");
  });

  it("a chart fence becomes labelled bars", () => {
    const out = prepareMarkdown('```chart\n{"type":"bar","title":"LOC","labels":["backend","web"],"values":[29,38]}\n```');
    expect(out).toContain("**LOC**");
    expect(out).toMatch(/backend +█+ 29/);
    expect(out).toMatch(/web +█{24} 38/);
  });

  it("a markmap becomes an outline", () => {
    expect(prepareMarkdown("```markmap\n# Root\n## A\n### A1\n## B\n```")).toBe("**Root**\n- A\n  - A1\n- B");
  });

  it("leaves a fence it can't read as it was", () => {
    const md = "```graph\nnot json\n```";
    expect(prepareMarkdown(md)).toBe(md);
  });

  it("closes a table before prose that follows it", () => {
    expect(prepareMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\nThen prose.")).toBe("| a | b |\n|---|---|\n| 1 | 2 |\n\nThen prose.");
    expect(prepareMarkdown("```\n| x |\nnot a table\n```")).toBe("```\n| x |\nnot a table\n```");
  });
});

describe("one line", () => {
  it("cuts long or multi-line text with an ellipsis", () => {
    expect(oneLine("short", 20)).toBe("short");
    expect(oneLine("first line\nsecond", 20)).toBe("first line…");
    expect(oneLine("a".repeat(30), 10)).toBe("aaaaaaaaa…");
  });
});

describe("tips and border hints", () => {
  it("a tip holds still for its key and names only terminal keys", async () => {
    const { pickTip, TIPS } = await import("@/cli/tui/tips");
    expect(pickTip("s1:3")).toBe(pickTip("s1:3"));
    for (const t of TIPS) expect(`${t.keys ?? ""} ${t.text}`).not.toMatch(/Settings|⌘|Dictate|voice/i);
  });
});

describe("separators", () => {
  it("a --- under a paragraph stays a separator, not a heading", () => {
    expect(prepareMarkdown("Some paragraph.\n---\nNext.")).toBe("Some paragraph.\n\n---\nNext.");
    expect(prepareMarkdown("Already apart.\n\n---")).toBe("Already apart.\n\n---");
    expect(prepareMarkdown("```\ncode\n---\n```")).toBe("```\ncode\n---\n```");
    expect(prepareMarkdown("| a | b |\n|---|---|")).toBe("| a | b |\n|---|---|");
  });
});

describe("a reply still streaming", () => {
  it("holds back a last line that is only block markers, so it can't flip meaning", () => {
    expect(settleStreaming("Intro\n-")).toBe("Intro\n");
    expect(settleStreaming("Intro\n--")).toBe("Intro\n");
    expect(settleStreaming("Intro\n##")).toBe("Intro\n");
    expect(settleStreaming("Intro\n```ts")).toBe("Intro\n");
    expect(settleStreaming("Intro\n3.")).toBe("Intro\n");
  });

  it("holds back an unclosed table row", () => {
    expect(settleStreaming("| a | b |\n|---|---|\n| 1 | 2")).toBe("| a | b |\n|---|---|\n");
  });

  it("streams prose word by word", () => {
    expect(settleStreaming("Intro\nThe agent read 14 fi")).toBe("Intro\nThe agent read 14 fi");
    expect(settleStreaming("## Head")).toBe("## Head");
    expect(settleStreaming("- an item in progr")).toBe("- an item in progr");
  });

  it("shows an unfinished graph as one line, not raw JSON", () => {
    expect(settleStreaming('Here:\n\n```graph\n{"nodes":[{"id":"a"')).toBe("Here:\n\n_drawing the graph…_");
  });

  it("leaves a finished graph alone", () => {
    const done = 'Here:\n\n```graph\n{"nodes":[]}\n```\nAfter';
    expect(settleStreaming(done)).toBe(done);
  });
});

describe("a tip during a turn", () => {
  it("can leave out tips that would be beside the point", async () => {
    const { pickTip } = await import("@/cli/tui/tips");
    for (let i = 0; i < 200; i++) expect(pickTip(`s:${i}`, ["ctrl+t"]).keys).not.toBe("ctrl+t");
  });
});
