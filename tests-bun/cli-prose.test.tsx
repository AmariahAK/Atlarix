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
