/**
 * v13.1 web-search upgrades: HTML→Markdown extraction (turndown) with a
 * graceful fallback, read-length clamps, and the one-shot Cloudflare-challenge
 * retry with a browser User-Agent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The read_url cache is only observable through the fetch that does NOT happen,
 * so the network layer has to be countable.
 */
const safeFetchMock = vi.fn();
vi.mock("@/lib/security/url-policy", () => ({
  safeFetch: (...args: unknown[]) => safeFetchMock(...args),
  // Also mocked, though nothing here escalates: a partial module mock would leave
  // `assertUrlAllowed` undefined, so the first test that DID escalate would fail
  // on a TypeError rather than on the behaviour it was written to check.
  assertUrlAllowed: async (u: string) => new URL(u),
}));

import {
  extractReadableContent,
  clampReadLength,
  fetchWithCfRetry,
  fetchUrlContentCached,
  __clearReadUrlCacheForTests,
} from "@/lib/tools/web";

describe("extractReadableContent (turndown HTML→Markdown)", () => {
  it("converts main content to Markdown, preserving headings/lists/code/links", () => {
    const html = `
      <html><head><title>Doc</title></head><body>
        <nav>skip me</nav>
        <main>
          <h1>Title</h1>
          <p>Intro with a <a href="https://x.dev">link</a>.</p>
          <ul><li>one</li><li>two</li></ul>
          <pre><code>const a = 1;</code></pre>
        </main>
        <footer>footer junk</footer>
      </body></html>`;
    const md = extractReadableContent(html, "text/html");
    expect(md).toContain("# Title");
    expect(md).toContain("[link](https://x.dev)");
    // List items survive as markdown bullets (marker may be - or *).
    expect(md).toMatch(/[-*]\s+one/);
    expect(md).toMatch(/[-*]\s+two/);
    expect(md).toContain("const a = 1;");
    expect(md).not.toContain("skip me");
    expect(md).not.toContain("footer junk");
  });

  it("passes text/plain through untouched", () => {
    expect(extractReadableContent("raw text", "text/plain")).toBe("raw text");
  });

  it("does not throw on malformed HTML (falls back gracefully)", () => {
    const out = extractReadableContent("<div><p>unclosed <b>bold", "text/html");
    expect(typeof out).toBe("string");
    expect(out).toContain("unclosed");
  });
});

describe("clampReadLength", () => {
  it("uses the fallback for missing/invalid values", () => {
    expect(clampReadLength(undefined, 20_000)).toBe(20_000);
    expect(clampReadLength(0, 20_000)).toBe(20_000);
    expect(clampReadLength(-5, 20_000)).toBe(20_000);
    expect(clampReadLength("nope", 20_000)).toBe(20_000);
  });

  it("clamps to the 50K cap", () => {
    expect(clampReadLength(99_999, 20_000)).toBe(50_000);
    expect(clampReadLength(12_000, 20_000)).toBe(12_000);
  });
});

/**
 * A research turn reads the same URL more than once, and up to five sub-agents
 * can be reading it at the same moment. Each of those used to be a fresh fetch.
 */
describe("read_url cache", () => {
  function pageResponse(body: string): Response {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => body,
    } as unknown as Response;
  }

  beforeEach(() => {
    __clearReadUrlCacheForTests();
    safeFetchMock.mockReset();
    safeFetchMock.mockResolvedValue(
      pageResponse("<html><head><title>Doc</title></head><body><main><p>hello</p></main></body></html>"),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    __clearReadUrlCacheForTests();
  });

  it("serves a repeat read from cache instead of refetching", async () => {
    const first = await fetchUrlContentCached("https://x.dev/a", 20_000);
    const second = await fetchUrlContentCached("https://x.dev/a", 20_000);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  /** `maxLength` changes what the caller gets back, so it is part of the key. */
  it("refetches when maxLength differs", async () => {
    await fetchUrlContentCached("https://x.dev/a", 20_000);
    await fetchUrlContentCached("https://x.dev/a", 5_000);
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
  });

  it("refetches a different URL", async () => {
    await fetchUrlContentCached("https://x.dev/a", 20_000);
    await fetchUrlContentCached("https://x.dev/b", 20_000);
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent reads of the same URL into one fetch", async () => {
    const [a, b, c] = await Promise.all([
      fetchUrlContentCached("https://x.dev/a", 20_000),
      fetchUrlContentCached("https://x.dev/a", 20_000),
      fetchUrlContentCached("https://x.dev/a", 20_000),
    ]);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  /**
   * A transient failure pinned for 15 minutes would be worse than the extra
   * fetch — and retrying is exactly what the agent does next.
   */
  it("does not cache a failure", async () => {
    safeFetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      headers: new Headers(),
      text: async () => "",
    } as unknown as Response);
    const first = await fetchUrlContentCached("https://x.dev/down", 20_000);
    expect(first.ok).toBe(false);
    await fetchUrlContentCached("https://x.dev/down", 20_000);
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
  });

  it("refetches once the 15-minute TTL has passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T10:00:00Z"));
    await fetchUrlContentCached("https://x.dev/a", 20_000);

    vi.setSystemTime(new Date("2026-08-17T10:14:00Z"));
    await fetchUrlContentCached("https://x.dev/a", 20_000);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-08-17T10:16:00Z"));
    await fetchUrlContentCached("https://x.dev/a", 20_000);
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchWithCfRetry", () => {
  function res(status: number, headers: Record<string, string> = {}): Response {
    return { status, headers: new Headers(headers) } as unknown as Response;
  }

  it("retries once with a browser UA on a 403 cf-mitigated challenge", async () => {
    const calls: Record<string, string>[] = [];
    const out = await fetchWithCfRetry(
      async (headers) => {
        calls.push(headers);
        return calls.length === 1
          ? res(403, { "cf-mitigated": "challenge" })
          : res(200);
      },
      { "User-Agent": "Atlarix/1.0" },
    );
    expect(out.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]["User-Agent"]).toContain("Mozilla/5.0");
  });

  it("does not retry a plain 403 (no cf-mitigated header)", async () => {
    let n = 0;
    const out = await fetchWithCfRetry(
      async () => {
        n++;
        return res(403);
      },
      { "User-Agent": "Atlarix/1.0" },
    );
    expect(out.status).toBe(403);
    expect(n).toBe(1);
  });

  it("does not retry a successful first response", async () => {
    let n = 0;
    await fetchWithCfRetry(
      async () => {
        n++;
        return res(200);
      },
      {},
    );
    expect(n).toBe(1);
  });
});
