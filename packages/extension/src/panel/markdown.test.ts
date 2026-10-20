/**
 * The renderer.
 *
 * THE FIRST DESCRIBE IS THE POINT OF THE FILE. This renders model output, and
 * model output here is downstream of pages the agent read — so a page that gets
 * the model to echo markup back would be running script in an extension page,
 * where the session and the `chrome.*` namespace live. Every one of those cases
 * passes trivially today because nothing ever parses HTML; they exist to fail
 * loudly the day somebody reaches for `innerHTML` to add a feature.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

let host: HTMLElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
});

function render(md: string): HTMLElement {
  renderMarkdown(host, md);
  return host;
}

describe("model output is never parsed as markup", () => {
  it("renders a script tag as the characters it is", () => {
    render("Try <script>alert(1)</script> instead");
    expect(host.querySelector("script")).toBeNull();
    expect(host.textContent).toContain("<script>alert(1)</script>");
  });

  it("renders an img with an onerror handler as text", () => {
    render('<img src=x onerror="alert(1)">');
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("onerror");
  });

  it("does not honour an inline event attribute smuggled into a code span", () => {
    render("`<div onclick=steal()>`");
    const code = host.querySelector("code");
    expect(code?.textContent).toBe("<div onclick=steal()>");
    expect(host.querySelector("div")).toBeNull();
  });

  it("never produces a javascript: link from a URL-shaped string", () => {
    // The URL branch matches http(s) only. A `javascript:` URI must stay text.
    render("javascript:alert(1)");
    expect(host.querySelector("a")).toBeNull();
  });
});

describe("links", () => {
  it("carries rel=noopener, which is the load-bearing half", () => {
    // Without it the opened page holds a `window.opener` handle back to an
    // EXTENSION page.
    render("See https://example.com/x for more");
    const a = host.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com/x");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a?.getAttribute("target")).toBe("_blank");
  });

  it("leaves trailing punctuation outside the link", () => {
    render("Go to https://example.com/page.");
    expect(host.querySelector("a")?.textContent).toBe(
      "https://example.com/page",
    );
    expect(host.textContent?.endsWith(".")).toBe(true);
  });

  it("does not linkify a URL inside a code span", () => {
    render("`https://example.com`");
    expect(host.querySelector("a")).toBeNull();
    expect(host.querySelector("code")?.textContent).toBe("https://example.com");
  });
});

describe("[text](url) links", () => {
  it("links the text, without the brackets, and with the same rel and target", () => {
    // QA E8: the brackets showed, and only the bare URL inside was linked.
    render("Read [the docs](https://example.com/docs) first.");
    const links = host.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]!.textContent).toBe("the docs");
    expect(links[0]!.getAttribute("href")).toBe("https://example.com/docs");
    expect(links[0]!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[0]!.getAttribute("target")).toBe("_blank");
    expect(host.textContent).toBe("Read the docs first.");
  });

  it("renders a Sources list as one link per item", () => {
    render("**Sources**\n- [Foo (bar) - Wikipedia](https://en.wikipedia.org/wiki/Foo_(bar)) · en.wikipedia.org\n- [Guide](https://example.com/guide)");
    const links = [...host.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)", "https://example.com/guide"]);
    expect(links.map((a) => a.textContent)).toEqual(["Foo (bar) - Wikipedia", "Guide"]);
    expect(host.textContent).not.toContain("](");
  });

  it("allows mailto:", () => {
    render("[write to us](mailto:hi@example.com)");
    expect(host.querySelector("a")?.getAttribute("href")).toBe("mailto:hi@example.com");
  });

  it("never makes a link of javascript:, data: or vbscript:, however it is spelled", () => {
    for (const href of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "//evil.example/x", "/relative"]) {
      render(`[x](${href})`);
      expect(host.querySelector("a"), href).toBeNull();
      expect(host.textContent, href).toContain("[x]");
    }
  });

  it("keeps the link text as text, never markup", () => {
    render("[<img src=x onerror=alert(1)>](https://example.com)");
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("a")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("leaves a [text](url) inside a code span alone", () => {
    render("`[a](https://example.com)`");
    expect(host.querySelector("a")).toBeNull();
    expect(host.querySelector("code")?.textContent).toBe("[a](https://example.com)");
  });
});

describe("blocks", () => {
  it("renders a fenced block as pre > code with its language", () => {
    render("```ts\nconst x = 1;\n```");
    const code = host.querySelector("pre > code");
    expect(code?.textContent).toBe("const x = 1;");
    expect((code as HTMLElement).dataset.lang).toBe("ts");
  });

  it("renders an UNCLOSED fence as code while it is still streaming", () => {
    // Waiting for the closing fence makes a long block appear as raw text and
    // then snap into place, which reads as a glitch on every code answer.
    render("```\nhalf a function(");
    expect(host.querySelector("pre > code")?.textContent).toBe(
      "half a function(",
    );
  });

  it("renders bullets as a list", () => {
    render("- one\n- two");
    expect(
      [...host.querySelectorAll("li")].map((li) => li.textContent),
    ).toEqual(["one", "two"]);
  });

  it("joins a wrapped paragraph into one", () => {
    render("a line\nand its continuation\n\nnew paragraph");
    const ps = [...host.querySelectorAll("p")];
    expect(ps).toHaveLength(2);
    expect(ps[0].textContent).toBe("a line and its continuation");
  });

  it("renders bold and inline code together without either eating the other", () => {
    render("**bold** and `code`");
    expect(host.querySelector("strong")?.textContent).toBe("bold");
    expect(host.querySelector("code")?.textContent).toBe("code");
  });
});

describe("re-rendering", () => {
  it("replaces rather than appends, so a stream does not duplicate itself", () => {
    render("first");
    render("second");
    expect(host.textContent).toBe("second");
  });
});

/**
 * Headings and numbered lists.
 *
 * These were the exception to "an unhandled construct renders as its literal
 * text, which is legible". A heading fell through to the paragraph branch,
 * which joins consecutive lines with a space — so a heading and the sentence
 * under it became one line starting with `###`, and a numbered list collapsed
 * into a single paragraph with the numbers still embedded in it. Reported from
 * a real answer.
 */
describe("headings", () => {
  it("makes a heading, at its own level", () => {
    render("# One\n\n## Two\n\n### Three");
    expect(host.querySelector("h1")?.textContent).toBe("One");
    expect(host.querySelector("h2")?.textContent).toBe("Two");
    expect(host.querySelector("h3")?.textContent).toBe("Three");
    expect(host.textContent).not.toContain("#");
  });

  it("does not swallow the paragraph under it", () => {
    // THE REPORTED BUG. Without a heading block these two lines are joined into
    // "### Main message It positions Amariah as…".
    render("### Main message\nIt positions Amariah as an engineer.");
    expect(host.querySelector("h3")?.textContent).toBe("Main message");
    expect(host.querySelector("p")?.textContent).toBe(
      "It positions Amariah as an engineer.",
    );
  });

  it("renders inline spans inside a heading", () => {
    render("## The **big** one");
    expect(host.querySelector("h2 strong")?.textContent).toBe("big");
  });

  it("stops at six, and leaves a bare hash alone", () => {
    render("####### seven");
    expect(host.querySelector("h6")).toBeNull();
    expect(host.textContent).toContain("#######");
    render("#nospace");
    expect(host.querySelector("h1")).toBeNull();
  });

  it("drops closing hashes", () => {
    render("## Middle ##");
    expect(host.querySelector("h2")?.textContent).toBe("Middle");
  });
});

describe("numbered lists", () => {
  it("makes one list of the items, not one paragraph", () => {
    render("1. First\n2. Second\n3. Third");
    const items = [...host.querySelectorAll("ol li")].map((li) => li.textContent);
    expect(items).toEqual(["First", "Second", "Third"]);
    expect(host.querySelector("p")).toBeNull();
  });

  it("keeps the numbers the model chose", () => {
    // A list renumbered from 1 contradicts prose that refers to "step 4".
    render("4. Fourth\n5. Fifth");
    expect(host.querySelector("ol")?.getAttribute("start")).toBe("4");
  });

  it("does not set start when it begins at one", () => {
    render("1. First");
    expect(host.querySelector("ol")?.hasAttribute("start")).toBe(false);
  });

  it("accepts the `1)` spelling", () => {
    render("1) First\n2) Second");
    expect(host.querySelectorAll("ol li")).toHaveLength(2);
  });

  it("does not turn a date or a price into a list", () => {
    // `2026. ` at the start of a line is a year, not an item — but this is what
    // the rule costs, so it is written down rather than discovered.
    render("A sentence.\nThe answer is 42.5 percent.");
    expect(host.querySelector("ol")).toBeNull();
  });

  it("keeps bullets and numbers as separate lists", () => {
    render("- a\n- b\n\n1. one\n2. two");
    expect(host.querySelectorAll("ul li")).toHaveLength(2);
    expect(host.querySelectorAll("ol li")).toHaveLength(2);
  });

  it("ends the list at a blank line", () => {
    render("1. One\n\nA paragraph.");
    expect(host.querySelectorAll("ol li")).toHaveLength(1);
    expect(host.querySelector("p")?.textContent).toBe("A paragraph.");
  });

  it("renders inline spans inside an item", () => {
    render("1. Use `npm run build` first");
    expect(host.querySelector("ol li code")?.textContent).toBe("npm run build");
  });
});

describe("italics", () => {
  // Seen in a real answer as the literal characters: "unit sales are *rising*".
  it("renders single asterisks as emphasis", () => {
    render("unit sales are *rising* throughout");
    expect(host.querySelector("em")?.textContent).toBe("rising");
    expect(host.textContent).not.toContain("*");
  });

  it("still prefers bold when both could match", () => {
    // Alternation is ordered: offered the italic branch first, `**x**` matches
    // `*` + `*x*` and renders a stray asterisk around emphasised text.
    render("**definitely bold**");
    expect(host.querySelector("strong")?.textContent).toBe("definitely bold");
    expect(host.querySelector("em")).toBeNull();
  });

  it("leaves snake_case alone", () => {
    // The reason `_x_` is not emphasis: the model writes these constantly.
    render("call read_attachment with file_data set");
    expect(host.querySelector("em")).toBeNull();
    expect(host.textContent).toContain("read_attachment");
  });

  it("does not emphasise a lone asterisk or across a line break", () => {
    render("2 * 3 = 6");
    expect(host.querySelector("em")).toBeNull();
  });

  it("keeps italic out of a code span", () => {
    render("`a * b` stays code");
    expect(host.querySelector("code")?.textContent).toBe("a * b");
    expect(host.querySelector("em")).toBeNull();
  });
});

/**
 * Tables, promoted out of "unhandled is legible" on 2026-09-17.
 *
 * That rule holds for a blockquote, whose raw text still reads as what it is.
 * A table's raw text is a wall of pipes and dashes, which is not a plainer
 * rendering of the content — it is a wrong one. The owner hit it the first time
 * a model answered with a comparison.
 *
 * The risky half is NOT the happy path: it is everything that looks a bit like
 * a table and is not. Inventing structure that the model did not mean is worse
 * than showing pipes, so most of these assert that prose is left alone.
 */
describe("tables", () => {
  const TABLE = [
    "| Tab | Site | Permission |",
    "| --- | --- | --- |",
    "| 554529584 | news.ycombinator.com | not granted |",
    "| 554529585 | github.com | granted |",
  ].join("\n");

  it("renders a real table as a table", () => {
    const el = render(TABLE);
    const table = el.querySelector("table");
    expect(table).not.toBeNull();
    expect(el.querySelectorAll("thead th")).toHaveLength(3);
    expect(el.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(el.querySelectorAll("tbody tr")[1].children[1].textContent).toBe(
      "github.com",
    );
  });

  it("still builds every node, never parsing HTML", () => {
    const el = render("| A |\n| --- |\n| <img src=x onerror=alert(1)> |");
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("td")?.textContent).toContain("<img");
  });

  it("survives a ragged row without shifting later columns", () => {
    // Common while a table is still streaming in.
    const el = render("| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |");
    const cells = el.querySelectorAll("tbody td");
    expect(cells).toHaveLength(3);
    expect(cells[2].textContent).toBe("");
  });

  it("leaves a sentence containing a pipe alone", () => {
    const el = render("Use grep | wc -l to count them.");
    expect(el.querySelector("table")).toBeNull();
    expect(el.textContent).toContain("grep | wc -l");
  });

  it("needs the separator row — a header alone is not a table", () => {
    const el = render("| A | B |\n| 1 | 2 |");
    expect(el.querySelector("table")).toBeNull();
  });

  it("ignores a separator whose column count disagrees with the header", () => {
    const el = render("| A | B | C |\n| --- | --- |\n| 1 | 2 | 3 |");
    expect(el.querySelector("table")).toBeNull();
  });

  it("accepts alignment markers and missing outer pipes", () => {
    const el = render("A | B\n:--- | ---:\n1 | 2");
    expect(el.querySelector("table")).not.toBeNull();
    expect(el.querySelectorAll("thead th")).toHaveLength(2);
  });

  it("renders inline formatting inside cells", () => {
    const el = render("| A |\n| --- |\n| **bold** and `code` |");
    expect(el.querySelector("td strong")?.textContent).toBe("bold");
    expect(el.querySelector("td code")?.textContent).toBe("code");
  });
});

describe("checklists", () => {
  it("draws [ ] and [x] items as boxes", () => {
    const el = document.createElement("div");
    renderMarkdown(el, "- [ ] Add it\n- [x] Agree the name");
    const items = [...el.querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toEqual(["☐ Add it", "☑ Agree the name"]);
  });
});
