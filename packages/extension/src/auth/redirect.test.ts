/**
 * The redirect URL, and the identity underneath it.
 *
 * Modelled on `src/__tests__/oauth-redirect-allowlist-match.test.ts`, which
 * exists because the desktop app shipped `atlarix:///auth/callback` against an
 * allowlisted `atlarix://auth/callback` and sign-in did nothing, with no error
 * anywhere to grep for. GoTrue matches the allowlist literally and, on a miss,
 * silently substitutes the Site URL.
 *
 * THE LOAD-BEARING TEST IS THE FIRST ONE. It re-derives the extension id FROM
 * `manifest.json`'s key rather than trusting the constant, so a mistyped key and
 * a mistyped id cannot quietly agree with each other. That derivation caught a
 * real error the first time it ran: the key was transcribed from a screenshot
 * and one character came back as `l` instead of `I`, which still decoded as
 * valid base64 and still produced a 294-byte DER — only the id disagreed.
 */

import { describe, expect, it } from "vitest";
// The REAL manifest, imported rather than read with `node:fs` — this package's
// tsconfig sets `types: []` and correctly refused the Node route. It also means
// this test follows the file if it ever moves, instead of silently passing
// against a path that no longer exists.
import manifest from "../../manifest.json";
import {
  ATLARIX_EXTENSION_ID,
  OAUTH_REDIRECT_URL,
  redirectPinFailure,
} from "./redirect";

/** Chrome's id derivation: sha256(DER)[0..16], each NIBBLE mapped `0-f` → `a-p`. */
async function extensionIdFromKey(base64Key: string): Promise<string> {
  const der = Uint8Array.from(atob(base64Key), (ch) => ch.charCodeAt(0));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", der));
  return Array.from(hash.subarray(0, 16))
    .map(
      (b) =>
        String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)),
    )
    .join("");
}

describe("the extension id is the one manifest.key produces", () => {
  it("pins a key at all — without it Chrome derives an id from the FOLDER PATH", () => {
    // A path-derived id differs per machine and per checkout, so every developer
    // would need their own Supabase allowlist entry, and the published build
    // would have yet another.
    expect(manifest.key).toBeTypeOf("string");
    expect(manifest.key).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("derives exactly ATLARIX_EXTENSION_ID, so neither value is taken on trust", async () => {
    expect(await extensionIdFromKey(manifest.key as string)).toBe(
      ATLARIX_EXTENSION_ID,
    );
  });

  it("is 32 characters of a-p — an id never contains a digit", () => {
    // Each nibble maps into `a`-`p`, so a digit anywhere means the value was
    // copied from something that is not an extension id.
    expect(ATLARIX_EXTENSION_ID).toMatch(/^[a-p]{32}$/);
  });
});

describe("the redirect URL Supabase must hold, byte for byte", () => {
  it("is the exact allowlisted string, trailing slash included", () => {
    expect(OAUTH_REDIRECT_URL).toBe(
      "https://fkoacefbjjjhjceidagdajkgclfjacbe.chromiumapp.org/",
    );
  });

  it("parses to the host chromiumapp.org serves, with an empty path", () => {
    const parsed = new URL(OAUTH_REDIRECT_URL);
    expect(parsed.protocol).toBe("https:");
    expect(parsed.hostname).toBe(`${ATLARIX_EXTENSION_ID}.chromiumapp.org`);
    expect(parsed.pathname).toBe("/");
    expect(parsed.search).toBe("");
  });
});

describe("pin failures", () => {
  it("passes when the running id matches and no redirect was observed", () => {
    expect(redirectPinFailure(ATLARIX_EXTENSION_ID, undefined)).toBeNull();
  });

  it("passes when both agree exactly", () => {
    expect(
      redirectPinFailure(ATLARIX_EXTENSION_ID, OAUTH_REDIRECT_URL),
    ).toBeNull();
  });

  it("is FATAL on a different id, and says what to do about it", () => {
    const failure = redirectPinFailure("a".repeat(32), undefined);
    expect(failure?.level).toBe("fatal");
    // Must name BOTH ids — "wrong id" alone does not tell you which end to fix.
    expect(failure?.message).toContain("a".repeat(32));
    expect(failure?.message).toContain(ATLARIX_EXTENSION_ID);
    // And must say why the failure would otherwise be invisible.
    expect(failure?.message).toMatch(/silent/i);
  });

  it("only WARNS on a trailing-slash difference — Chrome does not document it", () => {
    const failure = redirectPinFailure(
      ATLARIX_EXTENSION_ID,
      OAUTH_REDIRECT_URL.replace(/\/$/, ""),
    );
    expect(failure?.level).toBe("warn");
    expect(failure?.message).toMatch(/trailing slash/i);
  });

  it("is FATAL on any other redirect difference", () => {
    const failure = redirectPinFailure(
      ATLARIX_EXTENSION_ID,
      "https://evil.example/",
    );
    expect(failure?.level).toBe("fatal");
    expect(failure?.message).toMatch(/nothing was attempted/i);
  });

  it("tolerates an unknown runtime id rather than blocking on it", () => {
    // `runtime.id` is always present in an extension context; outside one there
    // is nothing to compare, and refusing there would break the unit tests of
    // every caller for no safety gain.
    expect(redirectPinFailure(undefined, undefined)).toBeNull();
  });
});
