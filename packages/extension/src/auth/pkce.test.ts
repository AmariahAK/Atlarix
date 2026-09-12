/**
 * PKCE, checked against RFC 7636 rather than against itself.
 *
 * A hand-rolled crypto helper tested only on its own round trip proves nothing:
 * base64url with the wrong alphabet, or a digest over the wrong encoding, will
 * round-trip perfectly and be rejected by the server. The published vector in
 * the RFC's Appendix B is the one assertion here that can fail for the right
 * reason.
 */

import { describe, expect, it } from "vitest";
import {
  CODE_CHALLENGE_METHOD,
  base64UrlEncode,
  challengeFromVerifier,
  randomVerifier,
} from "./pkce";

/** RFC 7636 Appendix B. */
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("challengeFromVerifier", () => {
  it("reproduces the RFC 7636 Appendix B vector", async () => {
    expect(await challengeFromVerifier(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });

  it("is deterministic and sensitive to a single character", async () => {
    const a = await challengeFromVerifier("abc");
    expect(await challengeFromVerifier("abc")).toBe(a);
    expect(await challengeFromVerifier("abd")).not.toBe(a);
  });
});

describe("base64UrlEncode", () => {
  it("uses the URL-safe alphabet and strips padding", () => {
    // 0xFB 0xFF exercises both substituted characters: standard base64 gives
    // "+/8=" here, and every one of those three differences matters in a URL.
    const encoded = base64UrlEncode(new Uint8Array([0xfb, 0xff]));
    expect(encoded).toBe("-_8");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
  });

  it("handles a buffer far larger than a verifier without overflowing", () => {
    // The reason the implementation loops instead of using
    // `String.fromCharCode(...bytes)`: the spread form is a RangeError here,
    // and 32 bytes staying under the limit today is not a guarantee.
    const big = new Uint8Array(200_000).fill(0x41);
    expect(() => base64UrlEncode(big)).not.toThrow();
    expect(base64UrlEncode(big).length).toBeGreaterThan(200_000);
  });

  it("round-trips through the decoder a server would use", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    const encoded = base64UrlEncode(bytes);
    const restored = Uint8Array.from(
      atob(encoded.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    expect(Array.from(restored)).toEqual(Array.from(bytes));
  });
});

describe("randomVerifier", () => {
  it("is 43 characters — RFC 7636's minimum length", () => {
    expect(randomVerifier()).toHaveLength(43);
  });

  it("only uses characters from the spec's unreserved set", () => {
    // base64url's alphabet is a subset of `unreserved`, so the verifier never
    // needs escaping when it is posted back.
    for (let i = 0; i < 20; i++) {
      expect(randomVerifier()).toMatch(/^[A-Za-z0-9\-._~]+$/);
    }
  });

  it("differs every time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => randomVerifier()));
    expect(seen.size).toBe(50);
  });
});

describe("the method literal", () => {
  it("is LOWERCASE s256, which is what GoTrue sends", () => {
    // RFC 7636 spells it `S256`. supabase-js sends `s256`. This assertion
    // exists because the failure mode is someone "correcting" it during a
    // tidy-up, and nothing in the resulting error mentions the case.
    expect(CODE_CHALLENGE_METHOD).toBe("s256");
  });
});
