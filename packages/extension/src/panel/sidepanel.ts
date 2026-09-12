/**
 * The side panel — the extension's UI, and the only context with a user gesture.
 *
 * TWO THINGS MUST HAPPEN HERE AND NOWHERE ELSE, for the same underlying reason:
 *
 *   1. **Sign-in.** `chrome.identity.launchWebAuthFlow` holds one promise open
 *      while the user reads a consent screen. The service worker dies after
 *      ~30s idle; this document does not.
 *   2. **Host grants.** `chrome.permissions.request()` must be called from
 *      inside a user gesture and cannot be called from a service worker at all.
 *      A button click here is the gesture.
 *
 * The second one is a containment property worth stating plainly: the agent
 * loop cannot widen its own reach, because the API that widens it is
 * unreachable from where the loop runs. That is stronger than a policy.
 */

import { detectCapabilities, missingCapabilities } from "../shared/browser-api";

const signInButton = document.querySelector<HTMLButtonElement>("#sign-in");
const status = document.querySelector<HTMLParagraphElement>("#status");

function setStatus(message: string): void {
  if (status) status.textContent = message;
}

/**
 * Report a browser that cannot deliver the full tool contract.
 *
 * Degrading LOUDLY is the rule this package is built on: a missing capability
 * must say so, never be worked around with a synthetic substitute that looks
 * like it worked. See `shared/browser-api.ts` for what each one costs.
 *
 * LOUD IS ONLY A VIRTUE WHEN IT IS TRUE. The first version of this said "This
 * browser is missing: trustedInput, tabGroups, offscreenDocument" on a healthy
 * Chrome, because those namespaces do not exist until the manifest asks for the
 * permission and this build deliberately has not yet. It sent the reader to
 * debug their browser over our own staging. `missingCapabilities` now excludes
 * anything merely un-requested, so silence here means there is nothing wrong.
 */
function reportCapabilities(): void {
  const missing = missingCapabilities(detectCapabilities());
  if (missing.length > 0) {
    setStatus(`This browser cannot support: ${missing.join(", ")}.`);
  }
}

reportCapabilities();

// Wired for real when `src/auth/` lands. Until then the button is disabled in
// the markup and this listener only exists so the shell is demonstrably alive.
signInButton?.addEventListener("click", () => {
  setStatus("Sign-in is not wired up yet.");
});
