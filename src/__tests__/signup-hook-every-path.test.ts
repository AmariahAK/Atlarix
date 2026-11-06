/**
 * Every sign-up is checked and leaves a row, and the domain lookups give the
 * judge something to judge (owner, 2026-11-06: "43 accounts created in 14 days
 * but only 24 signup checks logged").
 *
 * What the data showed:
 *  - Every account since the hook went live (10-30) has its row, Google, GitHub
 *    and email alike. The 20 without one were created 10-23 → 10-29, before it.
 *  - The deployed hook was the 10-29 build: the 10-30 "learned, not only
 *    listed" change was never deployed, so all 39 rows have no mail host, no
 *    website and no age. chapter.lat (10-31) was allowed on an empty judgement.
 *  - The hook's own failures (no email, the check RPC down, a throw) allowed
 *    the account and wrote nothing, so a gap could not be seen.
 */
import { describe, expect, it } from "vitest";
import {
  decideSignup,
  dohResolver,
  lookDomainUp,
  type SignupDeps,
} from "../../supabase/functions/auth-before-user-created/decide";

type Row = { allowed: boolean; reason: string | null; domain: string; mxHost: string | null; hasWeb: boolean | null };

function deps(over: Partial<SignupDeps> = {}): SignupDeps & { rows: Row[]; learned: string[] } {
  const rows: Row[] = [];
  const learned: string[] = [];
  return {
    rows,
    learned,
    lookup: async () => ({ mxHost: "mx.example.net", receivesMail: true, hasWeb: true, ageDays: 900 }),
    check: async () => ({
      ok: true,
      disposable: false,
      major: false,
      ip_1h: 0,
      domain_24h: 0,
      ip_noweb_7d: 0,
      mx_known: false,
      mx_shared: false,
    }),
    record: async (r) => {
      rows.push({ allowed: r.allowed, reason: r.reason, domain: r.domain, mxHost: r.look.mxHost, hasWeb: r.look.hasWeb });
    },
    learn: async (d) => {
      learned.push(d);
    },
    ...over,
  };
}

const signup = { email: "someone@example.net", provider: "google", ipHash: "h" };

describe("every sign-up leaves a row", () => {
  it("an allowed OAuth sign-up records what the lookup saw", async () => {
    const d = deps();
    expect(await decideSignup(signup, d)).toEqual({ allow: true });
    expect(d.rows).toEqual([{ allowed: true, reason: null, domain: "example.net", mxHost: "mx.example.net", hasWeb: true }]);
  });

  it("no email (a provider that gave none): allowed, and recorded", async () => {
    const d = deps();
    expect(await decideSignup({ ...signup, email: "" }, d)).toEqual({ allow: true });
    expect(d.rows).toEqual([expect.objectContaining({ allowed: true, reason: "no_email", domain: "" })]);
  });

  it("the check itself failing: allowed (fails open), and recorded", async () => {
    const d = deps({ check: async () => null });
    expect(await decideSignup(signup, d)).toEqual({ allow: true });
    expect(d.rows).toEqual([expect.objectContaining({ allowed: true, reason: "check_failed" })]);
  });

  it("a throw inside the hook: allowed, and recorded", async () => {
    const d = deps({
      check: async () => {
        throw new Error("boom");
      },
    });
    expect(await decideSignup(signup, d)).toEqual({ allow: true });
    expect(d.rows).toEqual([expect.objectContaining({ allowed: true, reason: "check_error" })]);
  });

  it("a listed domain is refused on every provider, OAuth included", async () => {
    for (const provider of ["email", "google", "github", "discord"]) {
      const d = deps({ check: async () => ({ ...(await deps().check(signup))!, disposable: true }) });
      const out = await decideSignup({ ...signup, provider }, d);
      expect(out).toEqual(expect.objectContaining({ allow: false, status: 403 }));
      expect(d.rows).toEqual([expect.objectContaining({ allowed: false, reason: "disposable_domain" })]);
    }
  });

  it("a fresh domain with no website, registered weeks ago, is refused and learned (chapter.lat, 10-31)", async () => {
    const d = deps({ lookup: async () => ({ mxHost: "mx.burner.example", receivesMail: true, hasWeb: false, ageDays: 9 }) });
    expect(await decideSignup({ ...signup, email: "x@chapter.lat", provider: "email" }, d)).toEqual(
      expect.objectContaining({ allow: false, status: 403 }),
    );
    expect(d.learned).toEqual(["chapter.lat"]);
    expect(d.rows).toEqual([expect.objectContaining({ allowed: false, reason: "young_no_web", hasWeb: false })]);
  });

  it("a major provider is never looked up", async () => {
    let looked = 0;
    const d = deps({
      lookup: async () => {
        looked++;
        return { mxHost: null, receivesMail: true, hasWeb: true, ageDays: null };
      },
    });
    await decideSignup({ ...signup, email: "a@gmail.com" }, d);
    expect(looked).toBe(0);
  });
});

/** A DNS-over-HTTPS answer in the JSON shape (RFC 8427-style, as 1.1.1.1 serves it). */
function dohFetch(answers: Record<string, { Status: number; Answer?: Array<{ type: number; data: string }> }>) {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "rdap.org") {
      return new Response(JSON.stringify({ events: [{ eventAction: "registration", eventDate: "2026-10-20T00:00:00Z" }] }), { status: 200 });
    }
    const key = `${url.searchParams.get("name")}/${url.searchParams.get("type")}`;
    const a = answers[key];
    if (!a) return new Response("", { status: 502 });
    return new Response(JSON.stringify(a), { status: 200, headers: { "content-type": "application/dns-json" } });
  }) as typeof fetch;
}

describe("domain lookups over HTTPS", () => {
  it("reads the lowest-preference mail host, the website and the age", async () => {
    const f = dohFetch({
      "milbox.example/MX": { Status: 0, Answer: [{ type: 15, data: "58 route2.mx.example." }, { type: 15, data: "3 route1.mx.example." }] },
      "milbox.example/A": { Status: 0, Answer: [{ type: 1, data: "104.21.86.165" }] },
      "milbox.example/AAAA": { Status: 0 },
      "www.milbox.example/A": { Status: 0, Answer: [{ type: 1, data: "104.21.86.165" }] },
    });
    const look = await lookDomainUp("milbox.example", { resolve: dohResolver(f), fetch: f, now: Date.parse("2026-10-31T00:00:00Z") });
    expect(look).toEqual({ mxHost: "route1.mx.example", receivesMail: true, hasWeb: true, ageDays: 11 });
  });

  it("a domain that does not exist has no mail and no website (not 'unknown')", async () => {
    const nx = { Status: 3 };
    const f = dohFetch({ "gone.example/MX": nx, "gone.example/A": nx, "gone.example/AAAA": nx, "www.gone.example/A": nx });
    const look = await lookDomainUp("gone.example", { resolve: dohResolver(f), fetch: f });
    expect(look.mxHost).toBeNull();
    expect(look.hasWeb).toBe(false);
    expect(look.receivesMail).toBe(false);
  });

  it("a resolver that cannot answer leaves everything unknown, so nothing is refused for it", async () => {
    const f = dohFetch({});
    const look = await lookDomainUp("x.example", { resolve: dohResolver(f), fetch: f });
    expect(look).toEqual({ mxHost: null, receivesMail: "unknown", hasWeb: null, ageDays: expect.anything() });
  });

  it("a CNAME in the answer is not taken for an address", async () => {
    const f = dohFetch({
      "c.example/MX": { Status: 0 },
      "c.example/A": { Status: 0, Answer: [{ type: 5, data: "elsewhere.example." }] },
      "c.example/AAAA": { Status: 0 },
      "www.c.example/A": { Status: 0 },
    });
    expect((await lookDomainUp("c.example", { resolve: dohResolver(f), fetch: f })).hasWeb).toBe(false);
  });
});
