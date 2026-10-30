/**
 * Is this sign-up's mail domain a throwaway? Decided from what can be seen about
 * the domain at sign-up time, so new burner domains are caught without anyone
 * adding them to a list (owner, 2026-10-30). Pure: no I/O, tested on its own.
 *
 * Signals (each may be unknown):
 *  - listed:       on the blocklist already (seeded list, hand-added, or learned)
 *  - major:        gmail, outlook, … (never judged)
 *  - hasWeb:       the domain or www.<domain> resolves to an address
 *  - ageDays:      days since registration, when RDAP answered
 *  - mxKnown:      its mail host already served a domain we listed
 *  - mxShared:     its mail host is one many legitimate domains share
 *  - ipNoWebDomains7d: other no-website domains this network signed up with this week
 *
 * The rule needs TWO signs of a burner, never one: no website alone is a small
 * company's mail-only domain; a young domain alone is a new company.
 */
export type DomainSignals = {
  listed: boolean;
  major: boolean;
  hasWeb: boolean | null;
  ageDays: number | null;
  mxKnown: boolean;
  mxShared: boolean;
  ipNoWebDomains7d: number;
};

export type Judgement =
  | { verdict: "allow"; flag?: "no_web" | "young" }
  | { verdict: "refuse"; reason: "disposable_domain" | "throwaway_mx" | "young_no_web" | "burner_pattern"; learn: boolean };

export const YOUNG_DAYS = 60;

export function judgeDomain(s: DomainSignals): Judgement {
  if (s.major) return { verdict: "allow" };
  if (s.listed) return { verdict: "refuse", reason: "disposable_domain", learn: false };
  const noWeb = s.hasWeb === false;
  const young = s.ageDays !== null && s.ageDays < YOUNG_DAYS;
  // Its mail host already served a listed throwaway, and this domain has no site either.
  if (s.mxKnown && !s.mxShared && noWeb) return { verdict: "refuse", reason: "throwaway_mx", learn: true };
  // Registered weeks ago, nothing on the web, and not on shared hosting: a burner.
  if (noWeb && young) return { verdict: "refuse", reason: "young_no_web", learn: true };
  // The same network already signed up on another no-website domain this week.
  if (noWeb && s.ipNoWebDomains7d >= 1) return { verdict: "refuse", reason: "burner_pattern", learn: true };
  if (noWeb) return { verdict: "allow", flag: "no_web" };
  if (young) return { verdict: "allow", flag: "young" };
  return { verdict: "allow" };
}

/** Days between an RDAP registration event and now, or null when it cannot be read. */
export function ageDaysFromRdap(doc: unknown, nowMs = Date.now()): number | null {
  const events = (doc as { events?: Array<{ eventAction?: string; eventDate?: string }> } | null)?.events;
  if (!Array.isArray(events)) return null;
  const reg = events.find((e) => e.eventAction === "registration")?.eventDate;
  if (!reg) return null;
  const t = Date.parse(reg);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 86_400_000));
}
