/**
 * The `text` kernel op — the one both browser backends now share.
 *
 * WHY THIS OP EXISTS AT ALL. `browser_inspect(mode:"text")` used to splice its
 * own `querySelector` into `executeJavaScript` on the desktop, and the extension
 * had no equivalent, so `target:"chrome"` could not serve the mode. Two
 * implementations of "the page's text" would have drifted the moment either was
 * touched, and `target` promises the model ONE contract across both browsers.
 *
 * EVALUATED FROM ITS SOURCE, not imported and called — the kernel is stringified
 * and injected, so it may not close over anything in its module. Calling the
 * import directly would pass even if the body referenced a module constant that
 * does not exist in the page. (Same reason as the search-results test.)
 */
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import {
  PAGE_TEXT_MAX_CHARS,
  atlarixPageKernel,
  type PageRequest,
  type PageTextResult,
} from "@/lib/browser/page-scripts";

function runText(html: string, req: Omit<PageRequest & { op: "text" }, "op">) {
  const dom = new JSDOM(html, { url: "https://example.com/doc" });
  const { window } = dom;
  const run = new Function(
    "document",
    "location",
    "URL",
    "window",
    `return (${atlarixPageKernel.toString()})(${JSON.stringify({ op: "text", ...req })})`,
  );
  return run(
    window.document,
    window.location,
    window.URL,
    window,
  ) as PageTextResult;
}

describe("the text kernel op", () => {
  it("returns the document's visible text", () => {
    const r = runText(
      "<body><h1>Title</h1><p>Body copy here.</p></body>",
      { max: PAGE_TEXT_MAX_CHARS },
    );
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Title");
    expect(r.text).toContain("Body copy here.");
    expect(r.clipped).toBe(false);
    expect(r.url).toBe("https://example.com/doc");
  });

  it("scopes to a selector", () => {
    const r = runText(
      "<body><nav>Skip me</nav><main id=m><p>Keep me</p></main></body>",
      { selector: "#m", max: PAGE_TEXT_MAX_CHARS },
    );
    expect(r.text).toContain("Keep me");
    expect(r.text).not.toContain("Skip me");
  });

  it("names the selector when nothing matches, instead of returning empty text", () => {
    // The distinction that matters: "your selector was wrong" and "this page has
    // no text" are different problems with different fixes, and an empty string
    // for both would make them indistinguishable.
    const r = runText("<body><p>hi</p></body>", {
      selector: "#nope",
      max: PAGE_TEXT_MAX_CHARS,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("#nope");
    expect(r.text).toBe("");
  });

  it("reports clipping rather than silently truncating", () => {
    const r = runText(`<body><p>${"x".repeat(500)}</p></body>`, { max: 100 });
    expect(r.clipped).toBe(true);
    expect(r.text.length).toBe(100);
  });

  it("does not return the contents of script or style elements", () => {
    // textContent would; innerText does not, and jsdom's fallback to textContent
    // is why this is asserted against a real DOM rather than assumed.
    const r = runText(
      "<body><p>visible</p><script>var secret=1;</script></body>",
      { max: PAGE_TEXT_MAX_CHARS },
    );
    expect(r.text).toContain("visible");
    expect(r.text).not.toContain("secret");
  });
});
