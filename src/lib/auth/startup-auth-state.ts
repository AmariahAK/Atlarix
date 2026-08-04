/**
 * Has the startup session restore finished yet?
 *
 * The window deliberately no longer waits for auth — on a black-hole network
 * (captive portal, hotel wifi, VPN) each request used to hang to the OS TCP
 * timeout, which meant minutes with no window at all. Deferring it fixed that.
 *
 * But the renderer then had no way to tell "signed out" apart from "we don't
 * know yet", so it rendered the SIGN-IN button on launch and flipped to the
 * account a few seconds later once the session resolved. A signed-in user
 * watching their app appear logged out, then log itself back in, reasonably
 * reads that as a bug — and older versions didn't do it, because they blocked
 * the window until auth was known.
 *
 * One flag closes the gap without giving back the fast start: the renderer
 * shows a neutral placeholder while this is false, and only commits to
 * "signed out" once it is true.
 */

let resolved = false;

/** Called once the deferred startup auth work has settled — success or failure. */
export function markStartupAuthResolved(): void {
  resolved = true;
}

/**
 * False only during the brief window between app launch and the session restore
 * settling. Never resets: a later sign-out is a KNOWN signed-out state, which is
 * exactly what the renderer should render.
 */
export function isStartupAuthResolved(): boolean {
  return resolved;
}

/** Test seam. */
export function __resetStartupAuthResolvedForTests(): void {
  resolved = false;
}
