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
