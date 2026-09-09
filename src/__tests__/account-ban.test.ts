/**
 * Ban plumbing, main side.
 *
 * SCOPE, stated once because the tests encode it: the hard stop is the proxy's 403,
 * which is server-side and cannot be talked past; everything here is the UX half.
 *
 * The IN-TURN message (accountBannedUserMessage, shown when a Core request 403s)
 * does correctly say BYOK and local models still work, and the tests below hold it
 * to that. The LAUNCHER gate is broader — it blocks opening a workspace at all, so
 * nothing in the client works while banned. Corrected 2026-08-20 after seeing it
 * live; see docs/BAN_RUNBOOK.md and src/__tests__/renderer/banned-sign-out.test.tsx.
 *
 * The two things that would quietly break the feature:
 *   - the realtime fingerprint deduping a ban flip away (a ban landing within 2s
 *     of any other plan write would never reach the session)
 *   - the reason leaking to a client, which is why it is not on `users` at all
 */
import { describe, it, expect } from "vitest";
import { buildAuthResolvedPayload } from "@/lib/SubscriptionManager";
import { accountBannedUserMessage } from "@/ipc/shared/compass_constants";

const session = (over: Record<string, unknown> = {}) => ({
  id: "u-1",
  email: "someone@example.com",
  name: "Someone",
  plan: "free" as const,
  effectiveTier: "free" as const,
  ...over,
});

describe("buildAuthResolvedPayload carries the ban", () => {
  it("reports banned:true so a live client can react without re-querying", () => {
    // auth:resolved is the payload the renderer applies DIRECTLY — useAuth is
    // unshared across ~22 consumers, so re-invoking checkSession would cost 22
    // round-trips. This is why a ban flip rides this event.
    const payload = buildAuthResolvedPayload(session({ banned: true }));
    expect(payload.user?.banned).toBe(true);
  });

  it("reports banned:false for a normal account", () => {
    expect(buildAuthResolvedPayload(session()).user?.banned).toBe(false);
  });

  it("still answers for a null session — an empty restore must not go silent", () => {
    const payload = buildAuthResolvedPayload(null);
    expect(payload.user).toBeNull();
  });

  it("never carries a reason field", () => {
    // The reason lives in public.user_bans (service-role only) precisely because
    // this row is also delivered to the client by the realtime subscription.
    const payload = buildAuthResolvedPayload(
      session({ banned: true, ban_reason: "tos: abuse" }),
    );
    expect(JSON.stringify(payload)).not.toContain("abuse");
    expect(JSON.stringify(payload)).not.toContain("reason");
  });
});

describe("accountBannedUserMessage", () => {
  it("gives a route back rather than a dead end", () => {
    expect(accountBannedUserMessage()).toContain("support@atlarix.dev");
  });

  it("does not claim to block BYOK or local models, because it cannot", () => {
    const msg = accountBannedUserMessage();
    expect(msg).toMatch(/own API keys|local models/i);
  });

  it("does not tell the user to sign in again — that fixes nothing", () => {
    expect(accountBannedUserMessage()).not.toMatch(
      /sign in again|session expired/i,
    );
  });
});
