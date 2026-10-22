/**
 * The Core proxy's fallback (item 10): only on no connection or 502/503/504,
 * never on a 4xx and never once a response has started; the primary skipped
 * for 3 minutes, then tried again; only an https URL on a host we run on.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  FALLBACK_HOLD_MS,
  __resetProxyFailoverForTests,
  onFallback,
  proxyFetch,
  setBuiltFallback,
  setConfiguredFallback,
  setProxyFailoverLog,
  validFallbackUrl,
} from "@/shared/proxy-failover";

const PRIMARY = "https://atlarix-production.up.railway.app/v1";
const FALLBACK = "https://abc123.lambda-url.us-east-1.on.aws";
const URL_ = `${PRIMARY}/chat/completions`;

let t = 1_000_000;
const now = () => t;
let calls: string[] = [];
const fake =
  (answers: Record<string, number | "down">) =>
  async (input: string | URL): Promise<Response> => {
    const u = String(input);
    calls.push(u);
    const a = answers[u.startsWith(FALLBACK) ? "fallback" : "primary"];
    if (a === "down") throw new TypeError("fetch failed");
    return new Response("{}", { status: a });
  };

beforeEach(() => {
  __resetProxyFailoverForTests();
  setConfiguredFallback(FALLBACK);
  calls = [];
  t += 10 * FALLBACK_HOLD_MS;
});

describe("which URL", () => {
  it("takes only https on a host we run on", () => {
    expect(validFallbackUrl(FALLBACK + "/")).toBe(FALLBACK);
    expect(validFallbackUrl("http://abc.lambda-url.us-east-1.on.aws")).toBeNull();
    expect(validFallbackUrl("https://evil.example.com")).toBeNull();
    expect(validFallbackUrl("https://on.aws.evil.com")).toBeNull();
    expect(validFallbackUrl("not a url")).toBeNull();
  });

  it("the hosted config wins over the build's; a bad one is ignored, and said", () => {
    __resetProxyFailoverForTests();
    const lines: string[] = [];
    setProxyFailoverLog((l) => lines.push(l));
    setBuiltFallback("https://built.up.railway.app");
    setConfiguredFallback("https://evil.example.com");
    expect(lines[0]).toContain("ignored");
    setConfiguredFallback(FALLBACK);
    expect(onFallback()).toBe(false);
  });
});

describe("when it falls back", () => {
  it("no connection: the same request on the fallback, and the primary skipped for 3 minutes", async () => {
    const f = fake({ primary: "down", fallback: 200 });
    const r = await proxyFetch(PRIMARY, URL_, { method: "POST", body: "{}" }, f as never, now);
    expect(r.status).toBe(200);
    expect(calls).toEqual([URL_, `${FALLBACK}/v1/chat/completions`]);
    calls = [];
    t += FALLBACK_HOLD_MS - 1;
    await proxyFetch(PRIMARY, URL_, { method: "POST", body: "{}" }, f as never, now);
    expect(calls).toEqual([`${FALLBACK}/v1/chat/completions`]);
    expect(onFallback(t)).toBe(true);
    calls = [];
    t += 2;
    await proxyFetch(PRIMARY, URL_, {}, fake({ primary: 200, fallback: 200 }) as never, now);
    expect(calls).toEqual([URL_]);
  });

  it.each([502, 503, 504])("%s: the fallback", async (status) => {
    const r = await proxyFetch(PRIMARY, URL_, { body: "{}" }, fake({ primary: status, fallback: 200 }) as never, now);
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it.each([400, 401, 402, 404, 429, 500])("%s: the primary's answer, no fallback", async (status) => {
    const r = await proxyFetch(PRIMARY, URL_, { body: "{}" }, fake({ primary: status, fallback: 200 }) as never, now);
    expect(r.status).toBe(status);
    expect(calls).toEqual([URL_]);
  });

  it("a 200 is never second-guessed: a stream that started stays where it is", async () => {
    const r = await proxyFetch(PRIMARY, URL_, { body: "{}" }, fake({ primary: 200, fallback: 200 }) as never, now);
    expect(r.status).toBe(200);
    expect(calls).toEqual([URL_]);
  });

  it("a body that cannot be sent twice is not retried, but the next request goes to the fallback", async () => {
    const stream = new ReadableStream();
    const r = await proxyFetch(PRIMARY, URL_, { body: stream } as RequestInit, fake({ primary: 503, fallback: 200 }) as never, now);
    expect(r.status).toBe(503);
    expect(calls).toEqual([URL_]);
    calls = [];
    await proxyFetch(PRIMARY, URL_, { body: "{}" }, fake({ primary: 503, fallback: 200 }) as never, now);
    expect(calls).toEqual([`${FALLBACK}/v1/chat/completions`]);
  });

  it("Stop (an aborted request) is not an outage", async () => {
    const ac = new AbortController();
    ac.abort();
    const aborting = async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    await expect(proxyFetch(PRIMARY, URL_, { signal: ac.signal }, aborting as never, now)).rejects.toThrow();
    expect(onFallback(t)).toBe(false);
  });

  it("no fallback configured: exactly today's behaviour", async () => {
    __resetProxyFailoverForTests();
    const r = await proxyFetch(PRIMARY, URL_, {}, fake({ primary: 503, fallback: 200 }) as never, now);
    expect(r.status).toBe(503);
    expect(calls).toEqual([URL_]);
  });

  it("a URL that is not the proxy's goes through untouched", async () => {
    await proxyFetch(PRIMARY, "https://example.com/x", {}, fake({ primary: 200, fallback: 200 }) as never, now);
    expect(calls).toEqual(["https://example.com/x"]);
  });
});

describe("the app's and the CLI's proxy calls", () => {
  it("coreProxyFetch takes the build's fallback and uses it when the proxy answers 503", async () => {
    __resetProxyFailoverForTests();
    const was = { url: process.env.ATLARIX_CORE_PROXY_URL, fb: process.env.ATLARIX_CORE_PROXY_FALLBACK_URL, fetch: globalThis.fetch };
    process.env.ATLARIX_CORE_PROXY_URL = "https://atlarix-production.up.railway.app";
    process.env.ATLARIX_CORE_PROXY_FALLBACK_URL = FALLBACK;
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      seen.push(String(input));
      return new Response("{}", { status: String(input).startsWith(FALLBACK) ? 200 : 503 });
    }) as typeof fetch;
    try {
      const { coreProxyFetch } = await import("@/ipc/shared/core_proxy");
      const r = await coreProxyFetch(`${PRIMARY}/connectors/list`, { method: "POST", body: "{}" });
      expect(r.status).toBe(200);
      expect(seen).toEqual([`${PRIMARY}/connectors/list`, `${FALLBACK}/v1/connectors/list`]);
    } finally {
      process.env.ATLARIX_CORE_PROXY_URL = was.url;
      process.env.ATLARIX_CORE_PROXY_FALLBACK_URL = was.fb;
      if (was.url === undefined) delete process.env.ATLARIX_CORE_PROXY_URL;
      if (was.fb === undefined) delete process.env.ATLARIX_CORE_PROXY_FALLBACK_URL;
      globalThis.fetch = was.fetch;
    }
  });
});
