/**
 * REGRESSION: the restore-settled announcement must carry an answer even when
 * there is NO session.
 *
 * A user upgrading from a very old build sat on "Restoring your session…"
 * forever. Main behaved correctly — `markStartupAuthResolved()` runs in a
 * `finally`, so even a failed restore settles — but the only thing that TOLD the
 * renderer, `broadcastSessionState()`, opens with `if (!s) return;`. No session
 * meant no message, and a renderer that had asked before the restore finished
 * never heard anything again: no sign-in button, no error, no retry.
 *
 * The empty/failed restore is precisely the case that stranded the UI, so it is
 * precisely the case worth pinning.
 */

import { describe, expect, it } from "vitest";
import {
  buildAuthResolvedPayload,
  type UserSession,
} from "@/lib/SubscriptionManager";

describe("auth:resolved payload", () => {
  it("still produces an answer when there is no session — THE BUG", () => {
    // The old behaviour was to emit NOTHING here. `user: null` is information:
    // signed out, render the sign-in affordance.
    expect(buildAuthResolvedPayload(null)).toEqual({
      user: null,
      plan: "free",
    });
    expect(buildAuthResolvedPayload(undefined)).toEqual({
      user: null,
      plan: "free",
    });
  });

  it("carries the account so the renderer needn't re-invoke IPC", () => {
    // Re-invoking would mean ~22 IPC round-trips per launch, one per useAuth()
    // consumer, which is why the payload is self-sufficient.
    const session: UserSession = {
      id: "u1",
      email: "victor@example.com",
      name: "Victor",
      plan: "pro",
      effectiveTier: "pro",
    };

    expect(buildAuthResolvedPayload(session)).toEqual({
      user: {
        id: "u1",
        email: "victor@example.com",
        name: "Victor",
        avatar: undefined,
        plan: "pro",
        effectiveTier: "pro",
        // Ban state rides this payload: it is what a live client applies directly
        // when an account is banned mid-session, rather than at next sign-in.
        banned: false,
      },
      plan: "pro",
    });
  });

  it("falls back to plan when effectiveTier is absent", () => {
    const session: UserSession = {
      id: "u2",
      email: "a@b.c",
      plan: "free",
    };
    expect(buildAuthResolvedPayload(session).user?.effectiveTier).toBe("free");
  });
});
