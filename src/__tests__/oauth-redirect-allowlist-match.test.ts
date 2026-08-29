/**
 * The `redirectTo` handed to Supabase must be BYTE-IDENTICAL to an entry in the
 * project's Auth → URL Configuration → Redirect URLs list.
 *
 * GoTrue compiles each allowlist entry into a glob (separators `.` and `/`) and
 * matches the requested redirect as a literal string — no URL normalisation, so
 * a differing slash count is simply not a match. And a non-match is NOT an
 * error: GoTrue silently substitutes the Site URL. The observed failure is
 * therefore "sign-in opens the browser, finishes, lands on the website, and the
 * desktop app never hears anything" — no error anywhere to grep for.
 *
 * That is exactly what `${DEEP_LINK_PROTOCOL}://${AUTH_CALLBACK_PATH}` produced:
 * `atlarix:///auth/callback`, three slashes, against an allowlist holding
 * `atlarix://auth/callback`.
 */
import { describe, expect, it } from "vitest";

import { AUTH_CALLBACK_URL, DEEP_LINK_PROTOCOL } from "@/lib/auth/supabase-client";
import { AUTH_CALLBACK_URL as RENDERER_AUTH_CALLBACK_URL } from "@/shims/supabase-client-renderer-stub";

/** The entry that must exist in Supabase → Auth → URL Configuration. */
const SUPABASE_ALLOWLISTED_REDIRECT = "atlarix://auth/callback";

describe("OAuth redirect matches the Supabase allowlist", () => {
  it("is the exact allowlisted string, two slashes and no trailing slash", () => {
    expect(AUTH_CALLBACK_URL).toBe(SUPABASE_ALLOWLISTED_REDIRECT);
  });

  it("is not the three-slash spelling that falls back to the Site URL", () => {
    expect(AUTH_CALLBACK_URL).not.toBe(`${DEEP_LINK_PROTOCOL}:///auth/callback`);
    expect(AUTH_CALLBACK_URL.split("://")[1]?.startsWith("/")).toBe(false);
  });

  it("the renderer stub agrees, so nothing in the UI advertises a different URL", () => {
    expect(RENDERER_AUTH_CALLBACK_URL).toBe(AUTH_CALLBACK_URL);
  });

  it("parses to the shape main.ts's deep-link handler dispatches on", () => {
    // handleDeepLinkReturn matches `hostname === "auth"` OR
    // `pathname.startsWith("/auth/callback")`. The two-slash spelling takes the
    // hostname branch; assert it rather than trusting the fallback.
    const parsed = new URL(`${AUTH_CALLBACK_URL}#access_token=t&refresh_token=r`);
    expect(parsed.protocol).toBe("atlarix:");
    expect(parsed.hostname).toBe("auth");
    expect(parsed.hash).toContain("access_token=t");
  });
});
