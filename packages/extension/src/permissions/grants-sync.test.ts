/**
 * Publishing grants, and applying a revocation made on the website.
 *
 * THE ASSERTION THAT MATTERS is that a revocation NARROWS and nothing widens:
 * the server's answer is a list of origins to remove, and a server that answers
 * with an origin the browser never granted must leave the browser exactly where
 * it was. That is the one-way valve the whole design rests on, and it is the
 * thing a future "why not just sync both ways?" would break.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { deviceId, deviceLabel, syncSiteGrants } from "./grants-sync";
import { grantSite, listGrants } from "./site-grants";

vi.mock("../auth/sign-in", () => ({
  getAccessToken: async () => "test-token",
}));

interface Fake {
  held: Set<string>;
  /** Every `origins` array the RPC was sent, in order. */
  sent: string[][];
}

function installFake(revoke: string[]): Fake {
  const store = new Map<string, unknown>();
  const held = new Set<string>();
  const sent: string[][] = [];

  const area = {
    async get(key?: string | null) {
      return typeof key === "string" && store.has(key)
        ? { [key]: store.get(key) }
        : {};
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
    storage: { local: area, sync: area },
    permissions: {
      async request({ origins }: { origins?: string[] }) {
        for (const o of origins ?? []) held.add(o);
        return true;
      },
      async contains({ origins }: { origins?: string[] }) {
        return (origins ?? []).every((o) => held.has(o));
      },
      async remove({ origins }: { origins?: string[] }) {
        for (const o of origins ?? []) held.delete(o);
        return true;
      },
      onRemoved: { addListener: () => {} },
    },
  };

  // Only the FIRST call carries a revocation. The second is the push that
  // clears it, and answering it with the same list again would loop.
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        p_input: { origins: string[] };
      };
      sent.push(body.p_input.origins);
      calls += 1;
      return {
        ok: true,
        json: async () => ({ ok: true, revoke: calls === 1 ? revoke : [] }),
      };
    }),
  );

  return { held, sent };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("deviceLabel", () => {
  it("names the browser and the platform, and nothing else", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome on macOS");
  });

  it("tells the Chromium family apart, because two of them is the whole point", () => {
    expect(deviceLabel("... Chrome/140 Safari/537.36 Edg/140.0")).toBe(
      "Edge on this device",
    );
    expect(deviceLabel("... Windows NT 10.0 ... Chrome/140 Safari/537.36")).toBe(
      "Chrome on Windows",
    );
  });

  it("never exceeds the column's 64 characters", () => {
    expect(deviceLabel("x".repeat(500)).length).toBeLessThanOrEqual(64);
  });
});

describe("deviceId", () => {
  it("is stable across calls and matches the shape the RPC accepts", async () => {
    installFake([]);
    const first = await deviceId();
    expect(first).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(await deviceId()).toBe(first);
  });
});

describe("syncSiteGrants", () => {
  it("publishes what this browser holds", async () => {
    const fake = installFake([]);
    await grantSite("https://app.example.com/x");
    await grantSite("https://other.test/y");

    await syncSiteGrants();

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.sort()).toEqual([
      "https://app.example.com",
      "https://other.test",
    ]);
  });

  it("applies a website revocation to BOTH halves, permission included", async () => {
    const fake = installFake(["https://app.example.com"]);
    await grantSite("https://app.example.com/x");
    await grantSite("https://other.test/y");
    fake.held.add("https://app.example.com/*");
    fake.held.add("https://other.test/*");

    const { revoked } = await syncSiteGrants();

    expect(revoked).toEqual(["https://app.example.com"]);
    // The record is gone...
    expect((await listGrants()).map((g) => g.origin)).toEqual([
      "https://other.test",
    ]);
    // ...and so is Chrome's permission. A record dropped without the permission
    // leaves the browser still allowing what the user just revoked.
    expect(fake.held.has("https://app.example.com/*")).toBe(false);
    expect(fake.held.has("https://other.test/*")).toBe(true);
  });

  it("pushes again so the server can drop the revoked row", async () => {
    const fake = installFake(["https://app.example.com"]);
    await grantSite("https://app.example.com/x");

    await syncSiteGrants();

    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]).toEqual([]);
  });

  it("NEVER adds an origin the server names but the browser never granted", async () => {
    // The valve. `revoke` is the only thing the server may say, and a server
    // that says something else must not be able to widen the agent's reach.
    const fake = installFake(["https://evil.test"]);
    await grantSite("https://app.example.com/x");
    fake.held.add("https://app.example.com/*");

    await syncSiteGrants();

    expect((await listGrants()).map((g) => g.origin)).toEqual([
      "https://app.example.com",
    ]);
    expect(fake.held.has("https://evil.test/*")).toBe(false);
  });

  it("is silent when signed out or offline — the panel must still open", async () => {
    installFake([]);
    await grantSite("https://app.example.com/x");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    await expect(syncSiteGrants()).resolves.toEqual({ revoked: [] });
    expect((await listGrants()).map((g) => g.origin)).toEqual([
      "https://app.example.com",
    ]);
  });
});
