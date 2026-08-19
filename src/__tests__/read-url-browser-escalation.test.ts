/**
 * `read_url`: fetch first, browser on failure.
 *
 * The whole value of this design is the escalation that does NOT happen — a
 * healthy page must never construct a window, or deep search's five concurrent
 * fetches become five sequential page loads behind one serialized renderer. So
 * every test here asserts on the CALL COUNT of the hidden page, not just on the
 * text that came back.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const safeFetchMock = vi.fn();
const assertUrlAllowedMock = vi.fn();
vi.mock("@/lib/security/url-policy", () => ({
  safeFetch: (...args: unknown[]) => safeFetchMock(...args),
  assertUrlAllowed: (...args: unknown[]) => assertUrlAllowedMock(...args),
}));

/** Stands in for the shared hidden window. Records every load it is asked for. */
const withHiddenPageMock = vi.fn();
vi.mock("@/lib/browser/headless-page", () => ({
  withHiddenPage: (...args: unknown[]) => withHiddenPageMock(...args),
  isHiddenPageAvailable: () => true,
  shutdownHiddenPages: () => {},
}));

import { fetchUrlContentCached, __clearReadUrlCacheForTests } from "@/lib/tools/web";

function response(
  body: string,
  { status = 200, contentType = "text/html" }: { status?: number; contentType?: string } = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers({ "content-type": contentType }),
    text: async () => body,
  } as unknown as Response;
}

/** A client-rendered shell: plenty of HTML, no prose. */
function jsShell(): string {
  return (
    "<html><head><title>App</title></head><body><div id=\"root\"></div>" +
    `<script>${"x".repeat(40_000)}</script>` +
    "</body></html>"
  );
}

/** Long enough to clear POST_RENDER_MIN_CHARS — a short render is a failed read. */
const PROSE = "the article body continues at length ".repeat(12);

/** Make the mocked hidden page return this rendered DOM. */
function rendersAs(html: string, title = "Rendered") {
  withHiddenPageMock.mockImplementation(
    async (_url: string, _opts: unknown, extract: (wc: unknown) => Promise<unknown>) =>
      extract({ executeJavaScript: async () => ({ html, title }) }),
  );
}

const REAL_PAGE =
  "<html><head><title>Doc</title></head><body><main><h1>Heading</h1>" +
  `<p>${"real prose ".repeat(200)}</p></main></body></html>`;

beforeEach(() => {
  __clearReadUrlCacheForTests();
  safeFetchMock.mockReset();
  withHiddenPageMock.mockReset();
  assertUrlAllowedMock.mockReset();
  assertUrlAllowedMock.mockResolvedValue(new URL("https://example.dev/"));
});

describe("no escalation on the happy path", () => {
  it("never opens a window for a page that fetched fine", async () => {
    safeFetchMock.mockResolvedValue(response(REAL_PAGE));
    const out = await fetchUrlContentCached("https://ok.dev/a", 20_000);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.content).toContain("Heading");
    expect(withHiddenPageMock).not.toHaveBeenCalled();
  });

  it("does not escalate a 404 — a browser renders the same 404", async () => {
    safeFetchMock.mockResolvedValue(response("Not found", { status: 404 }));
    const out = await fetchUrlContentCached("https://ok.dev/missing", 20_000);
    expect(out.ok).toBe(false);
    expect(withHiddenPageMock).not.toHaveBeenCalled();
  });

  it("does not escalate large non-HTML, however thin it extracts", async () => {
    // Plain text extracts to itself, so guard against a future heuristic that
    // measures the wrong thing: there is nothing a renderer adds to text/plain.
    safeFetchMock.mockResolvedValue(
      response("\n".repeat(30_000), { contentType: "text/plain" }),
    );
    const out = await fetchUrlContentCached("https://ok.dev/log.txt", 20_000);
    expect(out.ok).toBe(true);
    expect(withHiddenPageMock).not.toHaveBeenCalled();
  });
});

describe("escalation", () => {
  it("renders a JS shell and returns the rendered content", async () => {
    safeFetchMock.mockResolvedValue(response(jsShell()));
    rendersAs(`<html><body><main><h1>Client Rendered</h1><p>${PROSE}</p></main></body></html>`);

    const out = await fetchUrlContentCached("https://spa.dev/", 20_000);
    expect(withHiddenPageMock).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.content).toContain("Client Rendered");
  });

  it("uses its own partition, never search's cookie jar", async () => {
    safeFetchMock.mockResolvedValue(response(jsShell()));
    rendersAs(`<html><body><main><p>${PROSE}</p></main></body></html>`);
    await fetchUrlContentCached("https://spa.dev/p", 20_000);
    const opts = withHiddenPageMock.mock.calls[0][1] as { partition: string };
    expect(opts.partition).toBe("persist:atlarix-reader");
    expect(opts.partition).not.toContain("search");
  });

  it("escalates a 403 bot wall", async () => {
    safeFetchMock.mockResolvedValue(response("blocked", { status: 403 }));
    rendersAs(`<html><body><main><p>the article behind the wall. ${PROSE}</p></main></body></html>`);
    const out = await fetchUrlContentCached("https://walled.dev/", 20_000);
    expect(withHiddenPageMock).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.content).toContain("behind the wall");
  });

  it("escalates 429 and 503 too", async () => {
    for (const status of [429, 503]) {
      __clearReadUrlCacheForTests();
      withHiddenPageMock.mockReset();
      safeFetchMock.mockResolvedValue(response("nope", { status }));
      rendersAs(`<html><body><main><p>${PROSE}</p></main></body></html>`);
      const out = await fetchUrlContentCached(`https://limited.dev/${status}`, 20_000);
      expect(withHiddenPageMock, `status ${status}`).toHaveBeenCalledTimes(1);
      expect(out.ok, `status ${status}`).toBe(true);
    }
  });

  it("keeps the fetch result when the render comes back worse", async () => {
    // Escalating must never DOWNGRADE a read. This page trips the size branch but
    // already carries real prose; an empty render must not take that away.
    const kept = "unique fetched sentence. " + PROSE;
    const thin =
      `<html><head><title>Thin</title></head><body><main><p>${kept}</p></main></body></html>` +
      `<script>${"y".repeat(40_000)}</script>`;
    safeFetchMock.mockResolvedValue(response(thin));
    rendersAs("<html><body></body></html>", "");
    const out = await fetchUrlContentCached("https://thin.dev/", 20_000);
    expect(withHiddenPageMock).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.content).toContain("unique fetched sentence");
  });

  it("catches a SMALL shell that merely links its bundle", async () => {
    // The shape the first version of this heuristic missed: measured against
    // excalidraw.com (69 chars) and play.vuejs.org (18), both well under any
    // size floor. What marks them is the linked bundle, not the byte count.
    safeFetchMock.mockResolvedValue(
      response(
        '<html><head><title>App</title><script src="/assets/index-a1b2.js"></script></head>' +
          "<body><div id=\"root\">You need to enable JavaScript to run this app.</div></body></html>",
      ),
    );
    rendersAs(`<html><body><main><p>${PROSE}</p></main></body></html>`);
    const out = await fetchUrlContentCached("https://small-spa.dev/", 20_000);
    expect(withHiddenPageMock).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(true);
  });

  it("leaves a small page that loads NO scripts alone", async () => {
    // example.com extracts to 183 chars and is complete. Size alone would have
    // escalated it; the linked-bundle test is what keeps it on the fetch path.
    safeFetchMock.mockResolvedValue(
      response("<html><head><title>Example</title></head><body><main><h1>Example Domain</h1>" +
        "<p>This domain is for use in documentation examples.</p></main></body></html>"),
    );
    const out = await fetchUrlContentCached("https://tiny.dev/", 20_000);
    expect(withHiddenPageMock).not.toHaveBeenCalled();
    expect(out.ok).toBe(true);
  });

  it("reports a page that is unreadable even after rendering", async () => {
    // An editor or a canvas app. Returning `ok` with its title as the body hands
    // the model a few characters labelled as the page content, which it repeats.
    safeFetchMock.mockResolvedValue(
      response('<html><head><title>Playground</title><script src="/app.js"></script></head><body></body></html>'),
    );
    rendersAs("<html><body><main><p>Playground</p></main></body></html>", "Playground");
    const out = await fetchUrlContentCached("https://editor.dev/", 20_000);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("no readable text");
  });

  it("reports the fetch error when the browser is unavailable", async () => {
    safeFetchMock.mockResolvedValue(response("blocked", { status: 403 }));
    withHiddenPageMock.mockResolvedValue(null); // headless build, or a failed load
    const out = await fetchUrlContentCached("https://walled.dev/x", 20_000);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("403");
  });
});

describe("SSRF: the browser path is policed too", () => {
  // safeFetch enforces the policy on the fetch path. The browser path does not go
  // through it, so without an explicit check "read this URL" becomes a port
  // scanner against localhost and the cloud metadata endpoint.
  const blocked = [
    "http://127.0.0.1/admin",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
  ];

  for (const url of blocked) {
    it(`never loads ${url} in the window`, async () => {
      safeFetchMock.mockResolvedValue(response("blocked", { status: 403 }));
      assertUrlAllowedMock.mockRejectedValue(new Error("URL blocked: private address"));
      rendersAs("<html><body><main><p>secrets</p></main></body></html>");

      const out = await fetchUrlContentCached(url, 20_000);
      expect(withHiddenPageMock).not.toHaveBeenCalled();
      expect(out.ok).toBe(false);
    });
  }

  it("checks the policy before loading, not after", async () => {
    safeFetchMock.mockResolvedValue(response(jsShell()));
    assertUrlAllowedMock.mockRejectedValue(new Error("URL blocked"));
    rendersAs("<html><body><main><p>rendered</p></main></body></html>");
    await fetchUrlContentCached("http://127.0.0.1:9000/", 20_000);
    expect(assertUrlAllowedMock).toHaveBeenCalled();
    expect(withHiddenPageMock).not.toHaveBeenCalled();
  });
});
