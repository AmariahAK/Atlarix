/**
 * A stored record is not a session.
 *
 * OBSERVED 2026-09-13, in Brave, on a real build. The panel showed a chat with
 * no sign-in buttons, a model picker reading "Atlarix Core is unreachable", and
 * a status line telling the user to check their connection — while the proxy
 * was up and answering. The session had simply expired, and every layer did its
 * own job correctly: `getAccessToken` refreshed, was refused, and cleared the
 * record; `listModels` raised a 401; the panel called both of those a network
 * problem because its signed-in test was "is there anything in storage".
 *
 * These tests are the shape of that bug, held still.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const FUTURE = () => Math.floor(Date.now() / 1000) + 3600;
const PAST = () => Math.floor(Date.now() / 1000) - 3600;

let storage: Map<string, unknown>;

function install(session: unknown) {
  storage = new Map();
  if (session) storage.set("atlarix.session.v1", session);
  const area = {
    async get(key?: string | null) {
      return typeof key === "string" && storage.has(key)
        ? { [key]: storage.get(key) }
        : {};
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) storage.set(k, v);
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) storage.delete(k);
    },
    async clear() {
      storage.clear();
    },
  };
  (globalThis as Record<string, unknown>).chrome = {
    storage: { local: area, sync: area },
  };
}

const session = (expiresAt: number) => ({
  access_token: "at",
  refresh_token: "rt",
  expires_at: expiresAt,
  token_type: "bearer",
  user: { id: "u1", email: "someone@example.test" },
});

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("a live session", () => {
  it("is signed in, and says who", async () => {
    install(session(FUTURE()));
    const { accountState } = await import("./account");
    const state = await accountState();
    expect(state.signedIn).toBe(true);
    expect(state.session?.user?.email).toBe("someone@example.test");
  });
});

describe("an expired session whose refresh is refused", () => {
  it("is signed OUT, even though storage still had a record", async () => {
    // THE BUG. The panel asked "is there a record" and got yes, so it hid the
    // only route back in.
    install(session(PAST()));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid_grant" }),
        text: async () => '{"error":"invalid_grant"}',
      })) as unknown as typeof fetch,
    );

    const { accountState } = await import("./account");
    expect((await accountState()).signedIn).toBe(false);
  });

  it("still reports WHOSE session it was, after the record is wiped", async () => {
    // The refresh clears storage, so reading the profile has to happen first —
    // otherwise the panel goes blank instead of saying "sign in again".
    install(session(PAST()));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid_grant" }),
        text: async () => "{}",
      })) as unknown as typeof fetch,
    );

    const state = await (await import("./account")).accountState();
    expect(state.session?.user?.email).toBe("someone@example.test");
    expect(storage.has("atlarix.session.v1")).toBe(false);
  });
});

describe("an expired session that refreshes cleanly", () => {
  it("is signed in — expiry alone is not a sign-out", async () => {
    install(session(PAST()));
    // `postToken` reads `res.text()`, not `res.json()` — a fixture supplying
    // only `json` makes a SUCCESSFUL refresh throw, which looks exactly like the
    // refusal case and would have had this test passing for the wrong reason.
    const body = JSON.stringify({
      access_token: "fresh",
      refresh_token: "rt2",
      expires_in: 3600,
      token_type: "bearer",
      user: { id: "u1", email: "someone@example.test" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => body,
      })) as unknown as typeof fetch,
    );

    const { accountState } = await import("./account");
    expect((await accountState()).signedIn).toBe(true);
    // And the refreshed token was written back, so the next call is free.
    expect(
      (storage.get("atlarix.session.v1") as { access_token: string })
        .access_token,
    ).toBe("fresh");
  });
});

describe("no session at all", () => {
  it("never touches the network to find that out", async () => {
    install(null);
    const f = vi.fn();
    vi.stubGlobal("fetch", f as unknown as typeof fetch);
    const state = await (await import("./account")).accountState();
    expect(state).toEqual({ signedIn: false, session: null });
    expect(f).not.toHaveBeenCalled();
  });
});
