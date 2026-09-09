import { describe, it, expect, beforeEach } from "vitest";
import {
  isStartupAuthResolved,
  markStartupAuthResolved,
  __resetStartupAuthResolvedForTests,
} from "@/lib/auth/startup-auth-state";

/**
 * "Signed out" and "not known yet" are different answers, and the UI must not
 * confuse them.
 *
 * The window stopped waiting for the session restore because on a black-hole
 * network (captive portal, hotel wifi, VPN) every request hung to the OS TCP
 * timeout — minutes with no window at all, reported as "the app doesn't open".
 * Deferring it fixed that, but left the renderer unable to tell the two states
 * apart: it mounted with `user: null`, rendered the sign-in screen, and flipped
 * to the account seconds later. A signed-in user watched their app log them out
 * and back in on every launch — which older builds never did, because they
 * blocked the window until auth was known.
 *
 * The flag closes that gap WITHOUT giving back the slow start.
 */

beforeEach(() => __resetStartupAuthResolvedForTests());

describe("startup auth resolution flag", () => {
  it("starts unresolved — launch has no answer yet", () => {
    expect(isStartupAuthResolved()).toBe(false);
  });

  it("is set once the restore settles", () => {
    markStartupAuthResolved();
    expect(isStartupAuthResolved()).toBe(true);
  });

  it("is idempotent", () => {
    markStartupAuthResolved();
    markStartupAuthResolved();
    expect(isStartupAuthResolved()).toBe(true);
  });

  // Set from a `finally`, so a restore that THREW still produces an answer.
  // Leaving the UI in limbo forever would be worse than showing signed out.
  it("stays true after being set — a later sign-out is a KNOWN state", () => {
    markStartupAuthResolved();
    expect(isStartupAuthResolved()).toBe(true);
    // Nothing in the module resets it outside the test seam.
    expect(isStartupAuthResolved()).toBe(true);
  });
});

/**
 * The renderer's rule, stated as the predicate the components use. Getting this
 * inverted is precisely the bug, so it is worth pinning in isolation.
 */
function showsNeutralPlaceholder(opts: {
  authResolved: boolean;
  isAuthenticated: boolean;
}): boolean {
  return !opts.authResolved && !opts.isAuthenticated;
}

describe("what the UI shows during launch", () => {
  it("holds a neutral slot while unresolved and not yet authenticated", () => {
    expect(
      showsNeutralPlaceholder({ authResolved: false, isAuthenticated: false }),
    ).toBe(true);
  });

  it("shows the account immediately if the session was already restored", () => {
    expect(
      showsNeutralPlaceholder({ authResolved: false, isAuthenticated: true }),
    ).toBe(false);
    expect(
      showsNeutralPlaceholder({ authResolved: true, isAuthenticated: true }),
    ).toBe(false);
  });

  it("commits to signed-out only once main has answered", () => {
    expect(
      showsNeutralPlaceholder({ authResolved: true, isAuthenticated: false }),
    ).toBe(false);
  });
});
