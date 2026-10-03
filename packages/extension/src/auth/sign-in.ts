/**
 * Sign-in, sign-out, and the access token every authenticated call asks for.
 *
 * THREE THINGS HERE ARE LOAD-BEARING. Each is a recorded failure elsewhere, not
 * a precaution.
 *
 * 1. **The code verifier never touches storage.** supabase-js persists it
 *    because a full-page redirect destroys the JS context, and `docs/TODO.md`
 *    records what that costs on the launchpad: the write happens BEFORE the
 *    redirect, so a browser with site data blocked throws, and the failure
 *    arrives as a rejection rather than as `{ error }` — skipping every error
 *    branch written to catch it. `launchWebAuthFlow` is one awaited promise in
 *    one context, so the verifier lives in a local `const` and the bug is made
 *    impossible rather than defended against.
 *
 * 2. **`signIn` must be called from the side panel, never the service worker.**
 *    A worker is torn down after ~30s idle. A user reading a consent screen for
 *    ninety seconds is ordinary, and a promise held across that is not
 *    guaranteed to survive. The side panel is a document with an ordinary
 *    lifetime — and it is where `chrome.permissions.request()` has to be called
 *    from anyway, so one constraint settles both.
 *
 * 3. **`getAccessToken` refreshes on demand and single-flight.** Supabase
 *    ROTATES refresh tokens: two concurrent refreshes race, the loser gets
 *    `400 invalid_grant`, and the user is signed out for no reason they can
 *    see. The in-flight promise below fixes that within one context; across
 *    contexts the rule is that the service worker owns this call and other
 *    contexts ask it over `runtime.sendMessage`.
 *
 * There is no timer anywhere in this file, and there must not be one.
 */

import { api } from "../shared/browser-api";
import { GOTRUE } from "./config";
import {
  exchangeCode,
  parseRedirect,
  refreshSession,
  authorizeUrl,
} from "./gotrue";
import { base64UrlEncode, challengeFromVerifier, randomVerifier } from "./pkce";
import { OAUTH_REDIRECT_URL, assertRedirectPinned } from "./redirect";
import {
  clearSession,
  isExpired,
  readSession,
  writeSession,
  type StoredSession,
} from "./session";

export type SignInResult =
  | { kind: "session"; session: StoredSession }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

/**
 * Run the PKCE flow. **Side panel only** — see the docblock above.
 */
export async function signIn(
  provider: "google" | "github" | "email" = "google",
): Promise<SignInResult> {
  if (provider === "email") return signInWithEmail();
  // Before anything else, and before the browser opens a consent screen. Once
  // the flow has run against a redirect GoTrue does not recognise, the user has
  // already been bounced to the website and there is no error left to catch.
  assertRedirectPinned();

  // Local only. Never written anywhere — see rule 1.
  const verifier = randomVerifier();
  const challenge = await challengeFromVerifier(verifier);

  let redirectUrl: string | undefined;
  try {
    redirectUrl = await api().identity.launchWebAuthFlow({
      url: authorizeUrl(GOTRUE, {
        provider,
        redirectTo: OAUTH_REDIRECT_URL,
        codeChallenge: challenge,
      }),
      interactive: true,
    });
  } catch (err) {
    // Chrome rejects when the user closes the window on some versions and
    // resolves `undefined` on others, so both paths have to mean the same
    // thing. Anything that is NOT a close is still worth a console line —
    // silently reporting "cancelled" for a genuine failure would leave someone
    // clicking Sign in forever with nothing to go on.
    const message = messageOf(err);
    if (!/closed|cancell?ed|did not approve/i.test(message)) {
      console.error("[atlarix] launchWebAuthFlow failed:", message);
      return { kind: "error", message };
    }
    return { kind: "cancelled" };
  }

  // Resolving `undefined` is the documented "user closed the window" path, and
  // it is NOT an error. Passing it to `new URL` would throw a TypeError that
  // reads like a bug in the redirect handling.
  if (!redirectUrl) return { kind: "cancelled" };

  const parsed = parseRedirect(redirectUrl);
  if (parsed.kind === "error") {
    if (parsed.error === "access_denied") return { kind: "cancelled" };
    return {
      kind: "error",
      message: parsed.description
        ? `${parsed.error}: ${parsed.description}`
        : parsed.error,
    };
  }

  try {
    const session = await exchangeCode(GOTRUE, {
      authCode: parsed.code,
      codeVerifier: verifier,
    });
    await writeSession(session);
    return { kind: "session", session };
  } catch (err) {
    return { kind: "error", message: messageOf(err) };
  }
}

/**
 * Email + password happens on atlarix.dev: Supabase refuses a password sign-in
 * without a Turnstile token, and Turnstile will not render on an extension
 * page. The site signs in with a client that keeps nothing and redirects to our
 * chromiumapp.org URL with the tokens and the `state` we sent.
 */
export const EMAIL_SIGN_IN_URL = "https://atlarix.dev/auth/app";

async function signInWithEmail(): Promise<SignInResult> {
  assertRedirectPinned();

  // A nonce the site must echo. It is what stops a crafted chromiumapp.org URL
  // carrying someone else's tokens from being taken as this flow's answer.
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));

  let redirectUrl: string | undefined;
  try {
    redirectUrl = await api().identity.launchWebAuthFlow({
      url: `${EMAIL_SIGN_IN_URL}?client=extension&state=${state}`,
      interactive: true,
    });
  } catch (err) {
    const message = messageOf(err);
    if (!/closed|cancell?ed|did not approve/i.test(message)) {
      console.error("[atlarix] launchWebAuthFlow failed:", message);
      return { kind: "error", message };
    }
    return { kind: "cancelled" };
  }
  if (!redirectUrl) return { kind: "cancelled" };

  let fragment: URLSearchParams;
  try {
    fragment = new URLSearchParams(new URL(redirectUrl).hash.replace(/^#/, ""));
  } catch {
    return { kind: "error", message: "Sign-in returned an unreadable address." };
  }
  if (fragment.get("state") !== state) {
    return { kind: "error", message: "Sign-in answer did not match this request. Try again." };
  }
  const refresh = fragment.get("refresh_token");
  if (!refresh) {
    return { kind: "error", message: fragment.get("error_description") ?? "No session came back." };
  }

  try {
    // Refresh straight away rather than storing what arrived. It yields the
    // same StoredSession shape the PKCE path produces, and it ROTATES the
    // refresh token — so the one that travelled through a URL is spent before
    // anything else could use it.
    const session = await refreshSession(GOTRUE, refresh);
    await writeSession(session);
    return { kind: "session", session };
  } catch (err) {
    return { kind: "error", message: messageOf(err) };
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function signOut(): Promise<void> {
  await clearSession();
}

export function getSession(): Promise<StoredSession | null> {
  return readSession();
}

/**
 * Single-flight refresh, owned by whichever context calls this — which must be
 * exactly one. See rule 3.
 */
let inFlight: Promise<StoredSession | null> | null = null;

/** A usable access token, refreshing first if the stored one is spent. */
export async function getAccessToken(): Promise<string | null> {
  const session = await readSession();
  if (!session) return null;
  if (!isExpired(session)) return session.access_token;

  if (!inFlight) {
    inFlight = refreshSession(GOTRUE, session.refresh_token)
      .then(async (fresh) => {
        await writeSession(fresh);
        return fresh;
      })
      .catch(async (err: unknown) => {
        // A refused refresh is terminal: the token is spent or revoked, and
        // keeping the record would fail every later call differently rather
        // than once, clearly. Signed-out is the honest state.
        console.error("[atlarix] session refresh failed:", messageOf(err));
        await clearSession();
        return null;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  const refreshed = await inFlight;
  return refreshed?.access_token ?? null;
}
