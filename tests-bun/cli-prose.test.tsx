/** @jsxImportSource @opentui/react */
/**
 * The CLI's prose renderer (src/cli/tui/Prose.tsx): markdown drawn
 * synchronously, so a streaming reply never shows raw `##` / `---` and a
 * wrapped line is never drawn over by the next block (owner, 2026-10-04).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { lexer, type Tokens } from "marked";
import { fenceFiletype, Prose, tableLines } from "../src/cli/tui/Prose";
import { linkify, oneLineKeepingUrl, setTerminalHyperlinks } from "../src/cli/tui/links";

let destroy: (() => void) | null = null;
afterEach(() => {
  destroy?.();
  destroy = null;
});

async function frame(node: React.ReactNode, width = 60, height = 30) {
  const setup = await testRender(node, { width, height });
  destroy = () => setup.renderer.destroy();
  await setup.renderOnce();
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("prose in the terminal", () => {
  it("draws headings, bold and inline code without their markdown syntax", async () => {
    const f = await frame(<Prose text={"## The content\n\nUse **jq** and `awk` here."} width={60} plain />);
    expect(f).toContain("The content");
    expect(f).toContain("Use jq and awk here.");
    expect(f).not.toContain("##");
    expect(f).not.toContain("**");
    expect(f).not.toContain("`");
  });

  it("mid-stream, a half-written marker line is held back, never shown raw", async () => {
    const f = await frame(<Prose text={"First paragraph.\n\n##"} streaming width={60} plain />);
    expect(f).toContain("First paragraph.");
    expect(f).not.toContain("##");
    const g = await frame(<Prose text={"First paragraph.\n-"} streaming width={60} plain />);
    expect(g).not.toMatch(/^\s*-\s*$/m);
  });

  it("a wrapped paragraph keeps every word, and the next block starts below it", async () => {
    const long = "A notable detail in the workflow: the commit message includes a trailer, so the queue itself is being curated with the help of the Atlarix agent.";
    const f = await frame(<Prose text={`${long}\n\n## The content`} width={40} plain />, 40, 30);
    const flat = f.replace(/\s+/g, " ");
    expect(flat).toContain("with the help of the Atlarix agent.");
    const lines = f.split("\n");
    const agentLine = lines.findIndex((l) => l.includes("agent."));
    const headingLine = lines.findIndex((l) => l.includes("The content"));
    expect(headingLine).toBeGreaterThan(agentLine);
  });

  it("an unfinished graph shows as one line, not raw JSON", async () => {
    const f = await frame(<Prose text={'Here:\n\n```graph\n{"nodes":[{"id":"a","name":"A"'} streaming width={60} plain />);
    expect(f).toContain("drawing the graph");
    expect(f).not.toContain('"nodes"');
  });

  it("a wide table fits the width: columns shrink and cells wrap", () => {
    const t = lexer("| Path | Purpose |\n|---|---|\n| .github/workflows/daily-quote.yml | The automation that runs every morning and commits the quote |", { gfm: true })[0] as Tokens.Table;
    const { lines } = tableLines(t, 50);
    for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(50);
    expect(lines.join(" ")).toContain("commits");
  });

  it("a checklist item is one line: the box, then its text, no raw [x]", async () => {
    const f = await frame(<Prose text={"- [x] Write a random plan\n- [ ] Leave the last step open"} width={60} plain />);
    expect(f).toContain("☑ Write a random plan");
    expect(f).toContain("☐ Leave the last step open");
    expect(f).not.toContain("[x]");
    expect(f).not.toContain("[ ]");
  });

  it("short fence tags resolve to their grammar", () => {
    expect(fenceFiletype("ts")).toBe("typescript");
    expect(fenceFiletype("js")).toBe("javascript");
    expect(fenceFiletype("py")).toBe("python");
    expect(fenceFiletype("rust title=main.rs")).toBe("rust");
    expect(fenceFiletype(undefined)).toBeUndefined();
  });
});

describe("links are clickable (OSC 8)", () => {
  /** The text drawn, and which characters of it link where (the renderer's own hit test). */
  async function linksIn(node: React.ReactNode, width = 80, height = 6) {
    const setup = await testRender(node, { width, height });
    destroy = () => setup.renderer.destroy();
    await setup.renderOnce();
    await setup.renderOnce();
    const text = setup.captureCharFrame();
    const rows = text.split("\n");
    const r = setup.renderer as unknown as { getLinkAt(x: number, y: number): string | null };
    const links = new Map<string, string>();
    rows.forEach((row, y) => {
      [...row].forEach((ch, x) => {
        const url = r.getLinkAt(x, y);
        if (url) links.set(url, (links.get(url) ?? "") + ch);
      });
    });
    return { text, links };
  }

  it("a markdown link's label is a link, and its URL shows where the terminal cannot link", async () => {
    setTerminalHyperlinks(false);
    const a = await linksIn(<Prose text={"See [the docs](https://atlarix.dev/docs)."} width={80} plain />);
    expect(a.links.get("https://atlarix.dev/docs")).toBe("the docs");
    expect(a.text).toContain("(https://atlarix.dev/docs)");
    setTerminalHyperlinks(true);
    const b = await linksIn(<Prose text={"See [the docs](https://atlarix.dev/docs)."} width={80} plain />);
    expect(b.links.get("https://atlarix.dev/docs")).toBe("the docs");
    expect(b.text).not.toContain("(https://atlarix.dev/docs)");
    setTerminalHyperlinks(false);
  });

  it("a bare URL in plain text (command output, a flash) is a link", async () => {
    const f = await linksIn(<text>{linkify("  ➜  Local:   http://localhost:5173/ ready.")}</text>);
    expect([...f.links.entries()]).toEqual([["http://localhost:5173/", "http://localhost:5173/"]]);
  });

  it("a cut line keeps its URL whole, and non-http stays text", () => {
    const line = "  VITE v6.0.0  ready in 312 ms   ➜  Local:   http://localhost:5173/";
    const cut = oneLineKeepingUrl(line, 40);
    expect(cut.endsWith("http://localhost:5173/")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(40);
    expect(linkify("javascript:alert(1) and file:///etc/passwd")).toHaveLength(1);
  });
});
