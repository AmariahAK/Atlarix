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
import { getSession, signIn, signOut } from "../auth/sign-in";
import type { OAuthProvider } from "../auth/gotrue";

const signedOut = document.querySelector<HTMLDivElement>("#signed-out");
const signedIn = document.querySelector<HTMLDivElement>("#signed-in");
const accountEmail =
  document.querySelector<HTMLParagraphElement>("#account-email");
const signOutButton = document.querySelector<HTMLButtonElement>("#sign-out");
const status = document.querySelector<HTMLParagraphElement>("#status");
const providerButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-provider]"),
);

function setStatus(message: string): void {
  if (status) status.textContent = message;
}

function setBusy(busy: boolean): void {
  for (const button of providerButtons) button.disabled = busy;
  if (signOutButton) signOutButton.disabled = busy;
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
  setStatus(
    missing.length > 0
      ? `This browser cannot support: ${missing.join(", ")}.`
      : "",
  );
}

/** Show whichever half matches the stored session — never before reading it. */
async function render(): Promise<void> {
  const session = await getSession();
  if (signedOut) signedOut.hidden = Boolean(session);
  if (signedIn) signedIn.hidden = !session;

  if (session) {
    if (accountEmail) {
      accountEmail.textContent = session.user?.email ?? session.user?.id ?? "—";
    }
    setStatus("");
  } else {
    reportCapabilities();
  }
  setBusy(false);
}

for (const button of providerButtons) {
  button.addEventListener("click", () => {
    const provider = button.dataset.provider as OAuthProvider | undefined;
    if (!provider) return;

    // Disable every provider for the round trip. A second click would start a
    // SECOND OAuth flow with its own verifier, and whichever finished last
    // would win — so the user could end up signed in as a different account
    // than the window they were looking at.
    setBusy(true);
    setStatus("Opening sign-in…");

    void signIn(provider)
      .then(async (result) => {
        // `render` owns the status line, so anything worth saying about the
        // attempt has to be said AFTER it — otherwise the message is written
        // and then immediately cleared, which looks like nothing happened.
        await render();
        if (result.kind === "cancelled") setStatus("Sign-in cancelled.");
        else if (result.kind === "error") setStatus(result.message);
      })
      .catch((err: unknown) => {
        // `signIn` throws only for a pinned-id mismatch, which is a build or
        // config fault rather than a user one — and the message says which end
        // to fix.
        setStatus(err instanceof Error ? err.message : String(err));
        setBusy(false);
      });
  });
}

signOutButton?.addEventListener("click", () => {
  setBusy(true);
  setStatus("Signing out…");
  void signOut()
    .then(render)
    .catch((err: unknown) => {
      setStatus(String(err));
      setBusy(false);
    });
});

void render();
