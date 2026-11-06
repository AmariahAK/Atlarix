/**
 * The sign-up decision, apart from Deno.serve and the Supabase client so it can
 * be tested (src/__tests__/signup-hook-every-path.test.ts). index.ts verifies
 * the hook's signature, builds the deps below, and returns what this decides.
 *
 * Every call leaves exactly one signup_attempts row, the hook's own failures
 * included (reason no_email / check_failed / check_error), so a gap between
 * accounts and rows always means a sign-up that never reached the hook.
 */
import { ageDaysFromRdap, judgeDomain } from "./judge.ts";

export const LIMITS = { ipPerHour: 5, domainPerDay: 20 };

export type Look = {
  mxHost: string | null;
  receivesMail: boolean | "unknown";
  hasWeb: boolean | null;
  ageDays: number | null;
};

export type CheckResult = {
  ok: boolean;
  disposable: boolean;
  major: boolean;
  ip_1h: number;
  domain_24h: number;
  ip_noweb_7d?: number;
  mx_known?: boolean;
  mx_shared?: boolean;
};

export type SignupDeps = {
  lookup(domain: string): Promise<Look>;
  /** signup_check_service; null when it errored or answered !ok. */
  check(args: { email: string; ipHash: string; provider: string; mxHost: string | null }): Promise<CheckResult | null>;
  record(row: { allowed: boolean; reason: string | null; domain: string; provider: string; ipHash: string; look: Look }): Promise<void>;
  learn(domain: string, mxHost: string | null, reason: string): Promise<void>;
};

export type Decision = { allow: true } | { allow: false; status: 403 | 429; message: string };

const MAJOR =
  /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|proton|protonmail|pm|hey|fastmail|yandex|mail|gmx|web|qq|163|126|aol|zoho|tutanota|tuta)\.(com|me|io|ru|de|net)$/;
const UNSEEN: Look = { mxHost: null, receivesMail: "unknown", hasWeb: null, ageDays: null };

export async function decideSignup(
  input: { email: string; provider: string; ipHash: string },
  deps: SignupDeps,
): Promise<Decision> {
  const email = input.email.trim().toLowerCase();
  const domain = email.split("@")[1] ?? "";
  const { provider, ipHash } = input;
  let look: Look = UNSEEN;
  const record = (allowed: boolean, reason: string | null) =>
    deps.record({ allowed, reason, domain, provider, ipHash, look }).catch(() => {});
  const no = async (status: 403 | 429, reason: string, message: string): Promise<Decision> => {
    await record(false, reason);
    return { allow: false, status, message };
  };

  if (!domain) {
    await record(true, "no_email");
    return { allow: true };
  }
  try {
    // A major provider (gmail, outlook, …) is never looked up or judged.
    look = MAJOR.test(domain) ? { mxHost: null, receivesMail: true, hasWeb: true, ageDays: null } : await deps.lookup(domain);
    const check = await deps.check({ email, ipHash, provider, mxHost: look.mxHost });
    if (!check) {
      await record(true, "check_failed");
      return { allow: true };
    }
    const judged = judgeDomain({
      listed: check.disposable,
      major: check.major,
      hasWeb: look.hasWeb,
      ageDays: look.ageDays,
      mxKnown: Boolean(check.mx_known),
      mxShared: Boolean(check.mx_shared),
      ipNoWebDomains7d: check.ip_noweb_7d ?? 0,
    });
    if (judged.verdict === "refuse") {
      if (judged.learn) await deps.learn(domain, look.mxHost, judged.reason).catch(() => {});
      return no(403, judged.reason, "Sign up with a regular email address. Temporary mailboxes aren't accepted.");
    }
    if (check.ip_1h >= LIMITS.ipPerHour) {
      return no(429, "ip_burst", "Too many sign-ups from this network in the last hour. Try again later.");
    }
    if (!check.major && check.domain_24h >= LIMITS.domainPerDay) {
      return no(429, "domain_burst", "Too many sign-ups for this email domain today. Try again tomorrow.");
    }
    // Email sign-ups only: an OAuth provider has already verified the address.
    if (provider === "email" && look.receivesMail === false) {
      return no(403, "no_mx", "That email domain can't receive mail. Check the address.");
    }
    // Allowed, with what was seen: a no-website or young domain is a flag, not
    // a refusal, until a second sign appears.
    await record(true, judged.verdict === "allow" ? judged.flag ?? null : null);
    return { allow: true };
  } catch {
    // Fails OPEN on our own errors: a broken check must never turn away real people.
    await record(true, "check_error");
    return { allow: true };
  }
}

/**
 * Resolves one record type: the answers' data, [] when the name has none (or
 * does not exist), null when the resolver could not answer. Over HTTPS
 * (1.1.1.1's JSON API) because a plain fetch is what the edge runtime is known
 * to allow; the hook's RPCs already go out the same way.
 */
export type Resolver = (name: string, type: "MX" | "A" | "AAAA") => Promise<string[] | null>;

const TYPE_CODE = { MX: 15, A: 1, AAAA: 28 } as const;

export function dohResolver(fetchFn: typeof fetch = fetch, endpoint = "https://cloudflare-dns.com/dns-query"): Resolver {
  return async (name, type) => {
    try {
      const url = `${endpoint}?name=${encodeURIComponent(name)}&type=${type}`;
      const res = await fetchFn(url, { headers: { Accept: "application/dns-json" } });
      if (!res.ok) return null;
      const doc = (await res.json()) as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
      if (doc.Status === 3) return []; // NXDOMAIN
      if (doc.Status !== 0) return null;
      return (doc.Answer ?? []).filter((a) => a.type === TYPE_CODE[type] && typeof a.data === "string").map((a) => a.data!);
    } catch {
      return null;
    }
  };
}

/** What DNS and RDAP say about a mail domain, each piece within its own short timeout. */
export async function lookDomainUp(
  domain: string,
  opts: { resolve?: Resolver; fetch?: typeof fetch; timeoutMs?: number; now?: number } = {},
): Promise<Look> {
  const resolve = opts.resolve ?? dohResolver();
  const fetchFn = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 1500;
  const within = <T>(p: Promise<T>, fallback: T): Promise<T> =>
    Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), timeoutMs))]);
  const [mx, a, aaaa, w, doc] = await Promise.all([
    within(resolve(domain, "MX"), null),
    within(resolve(domain, "A"), null),
    within(resolve(domain, "AAAA"), null),
    within(resolve(`www.${domain}`, "A"), null),
    within(
      fetchFn(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { headers: { Accept: "application/rdap+json" } }).then((r) =>
        r.ok ? r.json() : null,
      ),
      null as unknown,
    ),
  ]);
  const best = (mx ?? [])
    .map((d) => {
      const [pref, host] = d.trim().split(/\s+/);
      return { pref: Number(pref), host: (host ?? "").replace(/\.$/, "").toLowerCase() };
    })
    .filter((m) => m.host && Number.isFinite(m.pref))
    .sort((x, y) => x.pref - y.pref)[0];
  const mxHost = best ? best.host : null;
  const anyAnswer = a !== null || aaaa !== null || w !== null;
  const hasWeb = !anyAnswer ? null : Boolean(a?.length || aaaa?.length || w?.length);
  // No MX falls back to an address (RFC 5321); an MX lookup that could not
  // answer never counts as "cannot receive mail".
  const receivesMail: boolean | "unknown" = mxHost || hasWeb ? true : mx === null || hasWeb === null ? "unknown" : false;
  return { mxHost, receivesMail, hasWeb, ageDays: ageDaysFromRdap(doc, opts.now) };
}
