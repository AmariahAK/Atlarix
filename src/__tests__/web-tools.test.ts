/**
 * v13.1 web-search upgrades: HTML→Markdown extraction (turndown) with a
 * graceful fallback, read-length clamps, and the one-shot Cloudflare-challenge
 * retry with a browser User-Agent.
 */
import { describe, it, expect } from "vitest";
import {
  extractReadableContent,
  clampReadLength,
  fetchWithCfRetry,
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
