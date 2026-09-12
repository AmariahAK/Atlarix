/**
 * The OAuth redirect URL, and the identity it depends on.
 *
 * WHY THIS IS ITS OWN MODULE. GoTrue matches `redirect_to` against the project's
 * allowlist as a LITERAL string — each entry is compiled to a glob over `.` and
 * `/`, with no URL normalisation — and a non-match is **not an error**. It
 * silently substitutes the Site URL. So the observed failure is "sign-in opens,
 * the user completes it, and the extension never hears anything", with nothing
 * to grep for anywhere. The desktop app has the same trap on record: it shipped
 * `atlarix:///auth/callback` (three slashes) against an allowlisted
 * `atlarix://auth/callback`, and `src/__tests__/oauth-redirect-allowlist-match.test.ts`
 * exists because of it. This is that test's sibling.
 *
 * WHAT IS ASSERTED, AND WHAT IS ONLY WARNED ABOUT. The assertion is on
 * `chrome.runtime.id`, because that is unambiguous and is the thing that
 * actually goes wrong in practice — a `key` that was never pasted into the
 * manifest, or pasted from a different draft item. Chrome's documentation does
 * NOT state whether `identity.getRedirectURL()` returns a trailing slash, so
 * that comparison cannot be the subject of a byte-identity pin; it is a loud
 * warning instead. We choose the `redirect_to` string ourselves, and a
 * navigation to the bare host normalises to `/` before Chrome's interceptor
 * sees it, so the slashed spelling is correct on the wire either way.
 */

import { api } from "../shared/browser-api";

/**
 * The Chrome Web Store item id, fixed by `manifest.key`.
 *
 * Derived from the SHA-256 of the key's DER bytes — the first 16 bytes, each
 * nibble mapped `0-f` → `a-p` — which is why it is 32 characters of `a`–`p` and
 * never contains a digit. `redirect.test.ts` re-derives it FROM the manifest
 * rather than trusting this line, so a mistyped key and a mistyped id cannot
 * agree with each other.
 *
 * The unpacked build shares this id only because the key is pinned. Without it
 * Chrome derives an id from the absolute folder path instead, which differs per
 * machine and per checkout — and would need its own allowlist entry on every
 * developer's box.
 */
export const ATLARIX_EXTENSION_ID = "fkoacefbjjjhjceidagdajkgclfjacbe";

/**
 * The EXACT string handed to GoTrue as `redirect_to`, and the EXACT string that
 * must appear in Supabase → Auth → URL Configuration → Redirect URLs.
 *
 * Trailing slash included. Change one character here and sign-in fails silently.
 */
export const OAUTH_REDIRECT_URL = `https://${ATLARIX_EXTENSION_ID}.chromiumapp.org/`;

export type RedirectPinFailure =
  | { level: "fatal"; message: string }
  | { level: "warn"; message: string };

/**
 * Compare the running extension's identity against what this build pinned.
 *
 * Pure, and takes both readings as arguments, so every branch is testable
 * without a `chrome` stub and without a browser.
 */
export function redirectPinFailure(
  runtimeId: string | undefined,
  observedRedirectUrl: string | undefined,
): RedirectPinFailure | null {
  if (runtimeId && runtimeId !== ATLARIX_EXTENSION_ID) {
    return {
      level: "fatal",
      message:
        `Extension id is ${runtimeId}, but this build pinned ${ATLARIX_EXTENSION_ID}. ` +
        `Sign-in would fail SILENTLY: GoTrue does not reject an unknown redirect, ` +
        `it substitutes the Site URL and the extension never hears back. ` +
        `Either manifest.key is missing or wrong, or Supabase needs ` +
        `https://${runtimeId}.chromiumapp.org/ added to Auth > URL Configuration > Redirect URLs.`,
    };
  }

  if (!observedRedirectUrl || observedRedirectUrl === OAUTH_REDIRECT_URL) {
    return null;
  }

  // The one difference we tolerate, because the platform does not document it
  // and it does not change what goes on the wire.
  if (
    observedRedirectUrl.replace(/\/$/, "") ===
    OAUTH_REDIRECT_URL.replace(/\/$/, "")
  ) {
    return {
      level: "warn",
      message:
        `chrome.identity.getRedirectURL() returned ${observedRedirectUrl}, which differs ` +
        `from the pinned ${OAUTH_REDIRECT_URL} only by a trailing slash. Proceeding with ` +
        `the pinned spelling, which is what the Supabase allowlist holds. Worth recording ` +
        `in docs/TODO.md: Chrome does not document which spelling it returns.`,
    };
  }

  return {
    level: "fatal",
    message:
      `chrome.identity.getRedirectURL() returned ${observedRedirectUrl}, which is not ` +
      `the pinned ${OAUTH_REDIRECT_URL}. Nothing was attempted.`,
  };
}

/**
 * Throw before the OAuth flow opens, never after.
 *
 * Ordering is the whole point. Once `launchWebAuthFlow` has run against a
 * redirect GoTrue does not recognise, the user has already been sent to a
 * consent screen and bounced to the website, and there is no error to catch.
 */
export function assertRedirectPinned(): void {
  const failure = redirectPinFailure(api().runtime?.id, safeGetRedirectUrl());
  if (!failure) return;
  if (failure.level === "warn") {
    console.error(`[atlarix] ${failure.message}`);
    return;
  }
  throw new Error(failure.message);
}

/** `identity` may be absent on a build that has not requested it. */
function safeGetRedirectUrl(): string | undefined {
  try {
    return api().identity?.getRedirectURL();
  } catch {
    return undefined;
  }
}
