/**
 * Throwaway mail domains are judged from what the sign-up shows, two signs at a
 * time, so new burner domains are refused and learned without a hand edit.
 */
import { describe, expect, it } from "vitest";
import { ageDaysFromRdap, judgeDomain } from "../../supabase/functions/auth-before-user-created/judge";

const base = { listed: false, major: false, hasWeb: true, ageDays: 900, mxKnown: false, mxShared: false, ipNoWebDomains7d: 0 };

describe("judgeDomain", () => {
  it("a major provider is never judged; a listed domain is refused without learning", () => {
    expect(judgeDomain({ ...base, major: true, listed: true })).toEqual({ verdict: "allow" });
    expect(judgeDomain({ ...base, listed: true })).toEqual({ verdict: "refuse", reason: "disposable_domain", learn: false });
  });
  it("the mail host of an earlier burner plus no website: refused and learned (parcel.lat → fieldwork.lat)", () => {
    expect(judgeDomain({ ...base, hasWeb: false, ageDays: null, mxKnown: true })).toEqual({ verdict: "refuse", reason: "throwaway_mx", learn: true });
  });
  it("a shared mail host teaches nothing, even with no website", () => {
    expect(judgeDomain({ ...base, hasWeb: false, ageDays: null, mxKnown: true, mxShared: true })).toEqual({ verdict: "allow", flag: "no_web" });
  });
  it("young and no website is a burner; young with a website is a new company", () => {
    expect(judgeDomain({ ...base, hasWeb: false, ageDays: 12 })).toEqual({ verdict: "refuse", reason: "young_no_web", learn: true });
    expect(judgeDomain({ ...base, hasWeb: true, ageDays: 12 })).toEqual({ verdict: "allow", flag: "young" });
  });
  it("the same network on a second no-website domain this week is the burner pattern", () => {
    expect(judgeDomain({ ...base, hasWeb: false, ageDays: null, ipNoWebDomains7d: 1 })).toEqual({ verdict: "refuse", reason: "burner_pattern", learn: true });
  });
  it("one sign alone allows: a mail-only company domain, or an unknown age", () => {
    expect(judgeDomain({ ...base, hasWeb: false, ageDays: 3000 })).toEqual({ verdict: "allow", flag: "no_web" });
    expect(judgeDomain({ ...base, hasWeb: false, ageDays: null })).toEqual({ verdict: "allow", flag: "no_web" });
    expect(judgeDomain({ ...base, hasWeb: null, ageDays: 3 })).toEqual({ verdict: "allow", flag: "young" });
  });
});

describe("ageDaysFromRdap", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  it("reads the registration event", () => {
    expect(ageDaysFromRdap({ events: [{ eventAction: "registration", eventDate: "2026-10-01T00:00:00Z" }] }, now)).toBe(29);
  });
  it("null when RDAP said nothing usable", () => {
    expect(ageDaysFromRdap(null, now)).toBeNull();
    expect(ageDaysFromRdap({ events: [{ eventAction: "expiration", eventDate: "2027-01-01T00:00:00Z" }] }, now)).toBeNull();
    expect(ageDaysFromRdap({ events: [{ eventAction: "registration", eventDate: "garbage" }] }, now)).toBeNull();
  });
});
