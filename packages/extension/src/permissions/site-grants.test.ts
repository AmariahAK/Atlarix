/**
 * Site grants — and specifically `originOf`, which is the whole security surface.
 *
 * A grant says "the agent may act here". Every way that can go wrong is a string
 * that reads like a hostname to a pattern matcher and resolves somewhere else:
 * a lookalike subdomain, a suffix, userinfo before an `@`, a query parameter, a
 * Cyrillic `а`. The cases below are that list.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  grantSite,
  isGranted,
  listGrants,
  originOf,
  revokeAll,
  revokeSite,
  sameOrigin,
} from "./site-grants";

/** Minimal in-memory `storage.sync`, matching the async shape we call. */
function installFakeChrome() {
  const store = new Map<string, unknown>();
  const area = {
    async get(key?: string | string[] | null) {
      if (typeof key === "string") {
        return store.has(key) ? { [key]: store.get(key) } : {};
      }
      return Object.fromEntries(store);
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async clear() {
      store.clear();
    },
  };
  (globalThis as Record<string, unknown>).chrome = {
    storage: { sync: area, local: area },
  };
  return store;
}

beforeEach(() => {
  installFakeChrome();
});

describe("originOf", () => {
  it("keeps scheme, host and a non-default port, and drops everything else", () => {
    expect(originOf("https://app.test/some/path?q=1#frag")).toBe(
      "https://app.test",
    );
    expect(originOf("https://app.test:8443/x")).toBe("https://app.test:8443");
    // Default ports normalise away, so :443 and bare are one origin.
    expect(originOf("https://app.test:443/x")).toBe("https://app.test");
  });

  it("treats http and https as different origins", () => {
    expect(sameOrigin("https://app.test", "http://app.test")).toBe(false);
  });

  it("is not fooled by a host that only APPEARS in the URL", () => {
    // The real host is evil.test in both.
    expect(originOf("https://evil.test/?next=https://app.test")).toBe(
      "https://evil.test",
    );
    expect(originOf("https://evil.test/#https://app.test")).toBe(
      "https://evil.test",
    );
  });

  it("is not fooled by userinfo before the @", () => {
    expect(originOf("https://app.test@evil.test/")).toBe("https://evil.test");
    expect(originOf("https://app.test:secret@evil.test/")).toBe(
      "https://evil.test",
    );
  });

  it("does not let a suffix inherit a grant", () => {
    // The classic: a substring/endsWith check would grant both of these.
    expect(sameOrigin("https://app.test", "https://app.test.evil.com")).toBe(
      false,
    );
    expect(sameOrigin("https://app.test", "https://notapp.test")).toBe(false);
  });

  it("does not let a subdomain inherit its parent's grant", () => {
    expect(
      sameOrigin("https://example.test", "https://evil.example.test"),
    ).toBe(false);
    expect(
      sameOrigin("https://app.example.test", "https://evil.example.test"),
    ).toBe(false);
  });

  it("separates a homograph from the name it imitates", () => {
    // Cyrillic 'а' (U+0430). URL renders it as punycode, so it stores and
    // compares as a different origin — which is the correct outcome.
    const cyrillic = "https://аpp.test";
    expect(originOf(cyrillic)).toContain("xn--");
    expect(sameOrigin(cyrillic, "https://app.test")).toBe(false);
  });

  it("refuses anything that is not an http(s) page", () => {
    for (const url of [
      "file:///etc/passwd",
      "chrome://settings",
      "chrome-extension://abc/x.html",
      "javascript:alert(1)",
      "data:text/html,<b>x",
      "about:blank",
      "not a url",
      "",
    ]) {
      expect(originOf(url), url).toBeNull();
    }
  });

  it("returns null rather than throwing on junk input", () => {
    expect(originOf(undefined)).toBeNull();
    expect(originOf(null)).toBeNull();
  });
});

describe("the grant store", () => {
  it("grants an origin and covers its other paths", async () => {
    expect(await isGranted("https://app.test/login")).toBe(false);
    await grantSite("https://app.test/login");
    expect(await isGranted("https://app.test/login")).toBe(true);
    // Same origin, different page — the grant is per site, not per page.
    expect(await isGranted("https://app.test/settings/billing")).toBe(true);
  });

  it("does not leak a grant to a neighbour, a suffix or another scheme", async () => {
    await grantSite("https://app.test");
    for (const other of [
      "https://app.test.evil.com/",
      "https://evil.app.test/",
      "http://app.test/",
      "https://app.test:8443/",
    ]) {
      expect(await isGranted(other), other).toBe(false);
    }
  });

  it("never grants a URL that cannot hold one", async () => {
    expect(await grantSite("chrome://settings")).toBeNull();
    expect(await isGranted("chrome://settings")).toBe(false);
    expect(await listGrants()).toHaveLength(0);
  });

  it("revokes one origin without touching the others", async () => {
    await grantSite("https://a.test");
    await grantSite("https://b.test");
    expect(await revokeSite("https://a.test")).toBe(true);
    expect(await isGranted("https://a.test")).toBe(false);
    expect(await isGranted("https://b.test")).toBe(true);
    // Revoking something that was never granted is a no-op, not an error.
    expect(await revokeSite("https://c.test")).toBe(false);
  });

  it("lists newest first and clears everything on request", async () => {
    await grantSite("https://old.test");
    await new Promise((r) => setTimeout(r, 2));
    await grantSite("https://new.test");
    const list = await listGrants();
    expect(list.map((g) => g.origin)).toEqual([
      "https://new.test",
      "https://old.test",
    ]);

    await revokeAll();
    expect(await listGrants()).toHaveLength(0);
    expect(await isGranted("https://new.test")).toBe(false);
  });

  it("re-granting refreshes the date rather than duplicating", async () => {
    await grantSite("https://app.test");
    const first = (await listGrants())[0].grantedAt;
    await new Promise((r) => setTimeout(r, 2));
    await grantSite("https://app.test/other");
    const list = await listGrants();
    expect(list).toHaveLength(1);
    expect(list[0].grantedAt).toBeGreaterThan(first);
  });

  it("survives a corrupted storage value instead of throwing", async () => {
    // A hand-edited LevelDB, or an older schema.
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        sync: {
          async get() {
            return { "atlarix.siteGrants.v1": "not-an-object" };
          },
          async set() {},
          async remove() {},
          async clear() {},
        },
      },
    };
    expect(await isGranted("https://app.test")).toBe(false);
    expect(await listGrants()).toEqual([]);
  });
});
