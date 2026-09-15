/**
 * The GoTrue wire format.
 *
 * Every shape here was read off `@supabase/auth-js`'s own source rather than
 * inferred, because a wrong parameter name fails as a generic 400 with no hint
 * about which field was wrong. The exact-string assertions below are what makes
 * a later "tidy-up" of the query builder visible.
 */

import { describe, expect, it } from "vitest";
import {
  GoTrueError,
  authorizeUrl,
  exchangeCode,
  parseRedirect,
  refreshSession,
  type GoTrueConfig,
} from "./gotrue";

const CFG: GoTrueConfig = {
  url: "https://proj.supabase.co",
  anonKey: "anon-key-123",
};

const REDIRECT = "https://fkoacefbjjjhjceidagdajkgclfjacbe.chromiumapp.org/";

/** A fetch stub that records the one call it receives. */
function stubFetch(response: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  text?: string;
}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      statusText: "",
      text: async () => response.text ?? JSON.stringify(response.body ?? {}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
}

const TOKENS = {
  access_token: "at",
  refresh_token: "rt",
  expires_in: 3600,
  token_type: "bearer",
  user: { id: "u1", email: "a@b.c" },
};

describe("authorizeUrl", () => {
  it("is the exact query GoTrue expects, lowercase s256 included", () => {
    expect(
      authorizeUrl(CFG, {
        provider: "google",
        redirectTo: REDIRECT,
        codeChallenge: "CHALLENGE",
      }),
    ).toBe(
      "https://proj.supabase.co/auth/v1/authorize" +
        "?provider=google" +
        "&redirect_to=https%3A%2F%2Ffkoacefbjjjhjceidagdajkgclfjacbe.chromiumapp.org%2F" +
        "&code_challenge=CHALLENGE" +
        "&code_challenge_method=s256",
    );
  });

  it("percent-encodes the redirect so the trailing slash survives", () => {
    // GoTrue matches its allowlist LITERALLY. A redirect mangled in transit is
    // not rejected — the Site URL is substituted and sign-in silently does
    // nothing, which is the desktop's recorded trap.
    const url = new URL(
      authorizeUrl(CFG, {
        provider: "github",
        redirectTo: REDIRECT,
        codeChallenge: "c",
      }),
    );
    expect(url.searchParams.get("redirect_to")).toBe(REDIRECT);
  });
});

describe("parseRedirect", () => {
  it("reads the authorization code from the query", () => {
    expect(parseRedirect(`${REDIRECT}?code=abc123`)).toEqual({
      kind: "code",
      code: "abc123",
    });
  });

  it("reads an error from the QUERY", () => {
    expect(
      parseRedirect(`${REDIRECT}?error=access_denied&error_description=nope`),
    ).toEqual({ kind: "error", error: "access_denied", description: "nope" });
  });

  it("reads an error from the FRAGMENT too", () => {
    // Providers differ about which half a denial lands in, and a parser that
    // reads only the query reports "no code" for a user who clicked Cancel.
    expect(
      parseRedirect(`${REDIRECT}#error=access_denied&error_description=nope`),
    ).toEqual({ kind: "error", error: "access_denied", description: "nope" });
  });

  it("reports a URL carrying neither, rather than returning a bare code", () => {
    const result = parseRedirect(REDIRECT);
    expect(result).toMatchObject({ kind: "error", error: "no_code" });
  });

  it("returns a VALUE for a non-URL instead of throwing", () => {
    // The error path must be a value the caller has to handle. A rejection
    // skips every `if (error)` branch written to catch it — the exact shape of
    // the launchpad PKCE bug in docs/TODO.md.
    expect(parseRedirect("not a url")).toMatchObject({
      kind: "error",
      error: "invalid_redirect",
    });
  });
});

describe("exchangeCode", () => {
  it("posts auth_code and code_verifier to grant_type=pkce", async () => {
    const { f, calls } = stubFetch({ body: TOKENS });
    await exchangeCode(CFG, { authCode: "CODE", codeVerifier: "VERIFIER" }, f);

    expect(calls[0].url).toBe(
      "https://proj.supabase.co/auth/v1/token?grant_type=pkce",
    );
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      auth_code: "CODE",
      code_verifier: "VERIFIER",
    });
  });

  it("sends apikey and NOT Authorization", async () => {
    // There is no token yet — this is the call that mints one. An empty bearer
    // here produces a 401 that points at authentication rather than the
    // exchange.
    const { f, calls } = stubFetch({ body: TOKENS });
    await exchangeCode(CFG, { authCode: "c", codeVerifier: "v" }, f);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.apikey).toBe("anon-key-123");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(Object.keys(headers)).not.toContain("Authorization");
  });

  it("computes expires_at from expires_in rather than trusting the server", async () => {
    const { f } = stubFetch({ body: TOKENS });
    const before = Math.floor(Date.now() / 1000);
    const session = await exchangeCode(
      CFG,
      { authCode: "c", codeVerifier: "v" },
      f,
    );
    expect(session.expires_at).toBeGreaterThanOrEqual(before + 3600);
    expect(session.user?.id).toBe("u1");
  });

  it("throws an error carrying the server's explanation, not a bare Response", async () => {
    const { f } = stubFetch({
      ok: false,
      status: 400,
      body: {
        error: "invalid_grant",
        error_description: "code verifier mismatch",
      },
    });
    await expect(
      exchangeCode(CFG, { authCode: "c", codeVerifier: "v" }, f),
    ).rejects.toThrow(/code verifier mismatch/);
  });

  it("still reports something useful when the body is not JSON", async () => {
    const { f } = stubFetch({
      ok: false,
      status: 502,
      text: "<html>bad gateway",
    });
    await expect(
      exchangeCode(CFG, { authCode: "c", codeVerifier: "v" }, f),
    ).rejects.toBeInstanceOf(GoTrueError);
  });
});

describe("refreshSession", () => {
  it("posts refresh_token to grant_type=refresh_token", async () => {
    const { f, calls } = stubFetch({ body: TOKENS });
    await refreshSession(CFG, "OLD-RT", f);
    expect(calls[0].url).toBe(
      "https://proj.supabase.co/auth/v1/token?grant_type=refresh_token",
    );
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      refresh_token: "OLD-RT",
    });
  });

  it("carries the status on failure so a caller can tell 400 from 503", async () => {
    const { f } = stubFetch({
      ok: false,
      status: 400,
      body: { error: "invalid_grant" },
    });
    await expect(refreshSession(CFG, "spent", f)).rejects.toMatchObject({
      status: 400,
    });
  });
});
