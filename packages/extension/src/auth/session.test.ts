/**
 * The session store.
 *
 * What is actually being tested is that the store treats `chrome.storage.local`
 * as UNTRUSTED INPUT. It is a LevelDB file any local process running as the
 * user can rewrite, so what comes back is not necessarily what was written —
 * and a malformed record has to become a clean signed-out state rather than a
 * TypeError somewhere inside a fetch.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSession,
  isExpired,
  readSession,
  sessionFromTokenResponse,
  writeSession,
  type StoredSession,
} from "./session";

/** Minimal in-memory `storage.local`, matching the async shape we call. */
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
    storage: { local: area, sync: area },
  };
  return store;
}

const SESSION: StoredSession = {
  access_token: "at",
  refresh_token: "rt",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  token_type: "bearer",
  user: { id: "u1" },
};

let store: Map<string, unknown>;
beforeEach(() => {
  store = installFakeChrome();
});

describe("round trip", () => {
  it("stores under a versioned key, matching the site-grant convention", async () => {
    await writeSession(SESSION);
    expect([...store.keys()]).toEqual(["atlarix.session.v1"]);
    expect(await readSession()).toEqual(SESSION);
  });

  it("reads null when nothing is stored", async () => {
    expect(await readSession()).toBeNull();
  });

  it("clears", async () => {
    await writeSession(SESSION);
    await clearSession();
    expect(await readSession()).toBeNull();
  });
});

describe("a rewritten record is signed-out, not a crash", () => {
  it.each([
    ["not an object", "hello"],
    ["null", null],
    ["missing refresh_token", { access_token: "a", expires_at: 1 }],
    [
      "empty access_token",
      { access_token: "", refresh_token: "r", expires_at: 1 },
    ],
    [
      "expires_at as a string",
      { access_token: "a", refresh_token: "r", expires_at: "soon" },
    ],
    [
      "expires_at NaN",
      { access_token: "a", refresh_token: "r", expires_at: Number.NaN },
    ],
  ])("returns null for %s", async (_label, value) => {
    store.set("atlarix.session.v1", value);
    await expect(readSession()).resolves.toBeNull();
  });
});

describe("sessionFromTokenResponse", () => {
  it("derives expires_at from expires_in, not from the server's own field", async () => {
    // GoTrue omits `expires_at` on some response shapes while `expires_in` is
    // always present. Reading the absolute field would give NaN, which compares
    // false against everything and makes a dead token look permanently fresh.
    const before = Math.floor(Date.now() / 1000);
    const s = sessionFromTokenResponse({
      access_token: "a",
      refresh_token: "r",
      expires_in: 60,
    });
    expect(s.expires_at).toBeGreaterThanOrEqual(before + 60);
    expect(s.token_type).toBe("bearer");
    expect(s.user).toBeNull();
  });
});

describe("isExpired", () => {
  const at = (secondsFromNow: number): StoredSession => ({
    ...SESSION,
    expires_at: Math.floor(Date.now() / 1000) + secondsFromNow,
  });

  it("is false with plenty of time left", () => {
    expect(isExpired(at(3600))).toBe(false);
  });

  it("is true once past the expiry", () => {
    expect(isExpired(at(-1))).toBe(true);
  });

  it("treats the skew window as already spent", () => {
    // 30s of life left, 60s of skew: a token that would expire mid-request must
    // count as gone before the request starts.
    expect(isExpired(at(30))).toBe(true);
    expect(isExpired(at(120))).toBe(false);
  });

  it("takes the skew as a parameter, so a caller can be stricter", () => {
    expect(isExpired(at(30), Date.now(), 0)).toBe(false);
  });
});
