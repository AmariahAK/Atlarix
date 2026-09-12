/**
 * PKCE (RFC 7636) — the verifier, the challenge, and the base64url they need.
 *
 * WRITTEN BY HAND RATHER THAN TAKEN FROM A LIBRARY, deliberately. This package
 * ships no dependencies, and every byte of it is read by a Web Store reviewer
 * looking at an extension that asks for broad host access. Forty lines of
 * WebCrypto is a better answer there than a transitive tree.
 *
 * WEBCRYPTO ONLY, AND THAT IS LOAD-BEARING. `crypto.getRandomValues` and
 * `crypto.subtle` exist in a service worker, a side panel and an offscreen
 * document alike. `node:crypto` exists in none of them, which is why the repo's
 * only other PKCE (the MCP client's) is not reusable here — it runs in Electron
 * main and reaches for Node.
 *
 * The functions below are pure apart from the RNG, so `pkce.test.ts` can check
 * them against RFC 7636's own published vector instead of against themselves.
 */

/**
 * base64url, unpadded — RFC 7636 §4.1's encoding.
 *
 * The loop is not an accident. `String.fromCharCode(...bytes)` is the idiomatic
 * one-liner and it spreads the whole array onto the call stack: fine for the 32
 * bytes used here, a RangeError for the first caller who passes something
 * larger. That is a trap worth closing at the definition rather than relying on
 * every future caller to stay small.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * A fresh code verifier.
 *
 * 32 random bytes encode to 43 base64url characters, which is exactly RFC
 * 7636's minimum length — and base64url's alphabet is a subset of the spec's
 * `unreserved` set, so the output never needs escaping in a URL.
 */
export function randomVerifier(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** base64url(SHA-256(ASCII(verifier))) — the `code_challenge`. */
export async function challengeFromVerifier(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * The method value GoTrue actually sends — LOWERCASE.
 *
 * RFC 7636 spells it `S256`, and supabase-js sends `s256`. It is a named export
 * so a test can pin it, because the failure mode is someone "correcting" it to
 * the RFC spelling during a tidy-up and discovering months later that sign-in
 * broke for a reason no error message mentions.
 */
export const CODE_CHALLENGE_METHOD = "s256";
