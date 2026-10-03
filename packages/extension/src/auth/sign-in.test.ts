/**
 * Sign-in orchestration.
 *
 * Every assertion below is a recorded failure rather than a hypothetical:
 *
 *   - the verifier never reaching storage is the launchpad PKCE bug
 *     (`docs/TODO.md`), where the write happens BEFORE the redirect and a
 *     browser with site data blocked throws a rejection that skips every error
 *     branch written to catch it;
 *   - `launchWebAuthFlow` resolving `undefined` is the documented "user closed
 *     the window" path, and passing it to `new URL` throws a TypeError that
 *     reads like a bug in redirect handling;
 *   - the single-flight refresh is Supabase ROTATING refresh tokens, where two
 *     concurrent refreshes race and the loser's `400 invalid_grant` presents to
 *     the user as a spontaneous logout.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const REDIRECT = "https://fkoacefbjjjhjceidagdajkgclfjacbe.chromiumapp.org/";
const ID = "fkoacefbjjjhjceidagdajkgclfjacbe";

interface FakeChrome {
  store: Map<string, unknown>;
  setCalls: number;
  launch: ReturnType<typeof vi.fn>;
}

function installFakeChrome(): FakeChrome {
  const store = new Map<string, unknown>();
  const state = { setCalls: 0 } as { setCalls: number };
  const area = {
    async get(key?: string | null) {
      return typeof key === "string" && store.has(key)
        ? { [key]: store.get(key) }
        : {};
    },
    async set(items: Record<string, unknown>) {
      state.setCalls++;
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async clear() {
      store.clear();
    },
  };
  const launch = vi.fn();
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { id: ID, getManifest: () => ({ permissions: ["identity"] }) },
    identity: { launchWebAuthFlow: launch, getRedirectURL: () => REDIRECT },
    storage: { local: area, sync: area },
  };
  return {
    store,
    launch,
    get setCalls() {
      return state.setCalls;
    },
  } as FakeChrome;
}

const TOKENS = {
  access_token: "at",
  refresh_token: "rt",
  expires_in: 3600,
  token_type: "bearer",
  user: { id: "u1" },
};

let chromeFake: FakeChrome;

beforeEach(async () => {
  vi.resetModules();
  chromeFake = installFakeChrome();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "",
      text: async () => JSON.stringify(TOKENS),
    })) as unknown as typeof fetch,
  );
});

/** Imported per-test because `getAccessToken` keeps module-level in-flight state. */
async function loadSignIn() {
  return import("./sign-in");
}

describe("signIn", () => {
  it("NEVER writes the code verifier to storage", async () => {
    // The whole point of using launchWebAuthFlow: it is one awaited promise in
    // one context, so the verifier survives in a closure and does not need
    // persisting. supabase-js persists because a full-page redirect destroys
    // the context — and that write is what breaks with site data blocked.
    chromeFake.launch.mockResolvedValue(`${REDIRECT}?code=abc`);
    const { signIn } = await loadSignIn();

    const result = await signIn("google");

    expect(result.kind).toBe("session");
    // Exactly one write, and it is the session — never a verifier.
    expect(chromeFake.setCalls).toBe(1);
    const stored = JSON.stringify([...chromeFake.store.entries()]);
    expect(stored).not.toContain("verifier");
    expect([...chromeFake.store.keys()]).toEqual(["atlarix.session.v1"]);
  });

  it("sends a challenge, and never the verifier, to the provider", async () => {
    chromeFake.launch.mockResolvedValue(`${REDIRECT}?code=abc`);
    const { signIn } = await loadSignIn();
    await signIn("google");

    const url = new URL(chromeFake.launch.mock.calls[0][0].url);
    expect(url.searchParams.get("code_challenge_method")).toBe("s256");
    const challenge = url.searchParams.get("code_challenge");
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    // The verifier goes to the TOKEN endpoint later, never to the browser.
    expect(url.searchParams.get("code_verifier")).toBeNull();
  });

  it("treats a resolved undefined as cancelled, not as a TypeError", async () => {
    // `new URL(undefined)` throws, and the resulting message says nothing about
    // the user having closed the window.
    chromeFake.launch.mockResolvedValue(undefined);
    const { signIn } = await loadSignIn();
    await expect(signIn("google")).resolves.toEqual({ kind: "cancelled" });
  });

  it("treats access_denied as cancelled rather than an error to show", async () => {
    chromeFake.launch.mockResolvedValue(`${REDIRECT}?error=access_denied`);
    const { signIn } = await loadSignIn();
    await expect(signIn("google")).resolves.toEqual({ kind: "cancelled" });
  });

  it("surfaces a real provider error with its description", async () => {
    chromeFake.launch.mockResolvedValue(
      `${REDIRECT}?error=server_error&error_description=upstream%20down`,
    );
    const { signIn } = await loadSignIn();
    const result = await signIn("google");
    expect(result).toMatchObject({ kind: "error" });
    expect((result as { message: string }).message).toContain("upstream down");
  });

  it("refuses to open the flow at all when the id is not the pinned one", async () => {
    // Ordering is the point: once the browser has been sent to a consent screen
    // against a redirect GoTrue does not recognise, the user is bounced to the
    // website and there is no error left to catch.
    (globalThis as Record<string, unknown>).chrome = {
      ...(globalThis as unknown as { chrome: Record<string, unknown> }).chrome,
      runtime: { id: "b".repeat(32), getManifest: () => ({ permissions: [] }) },
    };
    const { signIn } = await loadSignIn();
    await expect(signIn("google")).rejects.toThrow(/pinned/i);
    expect(chromeFake.launch).not.toHaveBeenCalled();
  });
});

describe("getAccessToken", () => {
  it("returns null when signed out", async () => {
    const { getAccessToken } = await loadSignIn();
    await expect(getAccessToken()).resolves.toBeNull();
  });

  it("returns the stored token without refreshing when it is fresh", async () => {
    const { getAccessToken } = await loadSignIn();
    chromeFake.store.set("atlarix.session.v1", {
      access_token: "fresh",
      refresh_token: "rt",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: "bearer",
      user: null,
    });
    await expect(getAccessToken()).resolves.toBe("fresh");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes ONCE for concurrent callers — Supabase rotates refresh tokens", async () => {
    // Two refreshes race, the loser gets 400 invalid_grant, and the user is
    // signed out for no reason they can see.
    const { getAccessToken } = await loadSignIn();
    chromeFake.store.set("atlarix.session.v1", {
      access_token: "spent",
      refresh_token: "rt",
      expires_at: Math.floor(Date.now() / 1000) - 10,
      token_type: "bearer",
      user: null,
    });

    const results = await Promise.all([
      getAccessToken(),
      getAccessToken(),
      getAccessToken(),
    ]);

    expect(results).toEqual(["at", "at", "at"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("clears the session when a refresh is refused, rather than leaving a corpse", async () => {
    // Keeping a spent record makes every later call fail differently instead of
    // once, clearly. Signed-out is the honest state.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        statusText: "",
        text: async () => JSON.stringify({ error: "invalid_grant" }),
      })) as unknown as typeof fetch,
    );
    const { getAccessToken } = await loadSignIn();
    chromeFake.store.set("atlarix.session.v1", {
      access_token: "spent",
      refresh_token: "revoked",
      expires_at: Math.floor(Date.now() / 1000) - 10,
      token_type: "bearer",
      user: null,
    });

    await expect(getAccessToken()).resolves.toBeNull();
    expect(chromeFake.store.has("atlarix.session.v1")).toBe(false);
  });

  it("recovers after a failed refresh instead of wedging the in-flight slot", async () => {
    // A single-flight guard that never clears turns one network blip into a
    // permanently signed-out extension.
    const { getAccessToken, signOut } = await loadSignIn();
    chromeFake.store.set("atlarix.session.v1", {
      access_token: "spent",
      refresh_token: "revoked",
      expires_at: Math.floor(Date.now() / 1000) - 10,
      token_type: "bearer",
      user: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: "",
        text: async () => "",
      })) as unknown as typeof fetch,
    );
    await getAccessToken();
    await signOut();

    // A later, healthy sign-in must work — the module cannot be left holding a
    // rejected promise.
    chromeFake.store.set("atlarix.session.v1", {
      access_token: "ok",
      refresh_token: "rt",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: "bearer",
      user: null,
    });
    await expect(getAccessToken()).resolves.toBe("ok");
  });
});

describe("signIn('email')", () => {
  /** Resolve launchWebAuthFlow with a hand-off that echoes `state`, or not. */
  function answerWith(stateFor: (sent: string) => string, extra = "&refresh_token=handed") {
    chromeFake.launch.mockImplementation(async ({ url }: { url: string }) => {
      const sent = new URL(url).searchParams.get("state")!;
      return `${REDIRECT}#access_token=handed-at${extra}&state=${stateFor(sent)}`;
    });
  }

  it("opens atlarix.dev's hand-off page with a nonce, not a provider consent screen", async () => {
    answerWith((s) => s);
    const { signIn, EMAIL_SIGN_IN_URL } = await loadSignIn();
    await signIn("email");
    const url = new URL(chromeFake.launch.mock.calls[0][0].url);
    expect(`${url.origin}${url.pathname}`).toBe(EMAIL_SIGN_IN_URL);
    expect(url.searchParams.get("client")).toBe("extension");
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });

  it("stores a session from a REFRESH of the handed token, never the handed one", async () => {
    answerWith((s) => s);
    const { signIn } = await loadSignIn();
    const result = await signIn("email");
    expect(result.kind).toBe("session");
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain("grant_type=refresh_token");
    expect(JSON.parse(init.body)).toEqual({ refresh_token: "handed" });
    const stored = JSON.stringify([...chromeFake.store.entries()]);
    expect(stored).not.toContain("handed");
  });

  it("refuses an answer whose state is not ours, and stores nothing", async () => {
    answerWith(() => "someone-elses-state-value");
    const { signIn } = await loadSignIn();
    const result = await signIn("email");
    expect(result.kind).toBe("error");
    expect(fetch).not.toHaveBeenCalled();
    expect(chromeFake.store.size).toBe(0);
  });

  it("treats a closed window as cancelled", async () => {
    chromeFake.launch.mockResolvedValue(undefined);
    const { signIn } = await loadSignIn();
    await expect(signIn("email")).resolves.toEqual({ kind: "cancelled" });
  });
});
