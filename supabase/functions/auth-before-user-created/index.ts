import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Supabase Auth "before user created" hook (HTTPS). Every sign-up, on every
 * surface (the site, the app, the CLI, OAuth included), passes through here
 * before the account exists. Enabled by the owner in the dashboard
 * (Authentication → Hooks → Before user created → HTTPS → this function's URL),
 * which also issues the signing secret this function checks.
 *
 * Refuses: a disposable mail domain (the 2026-10-28 attacker's was one), an
 * email domain that cannot receive mail (no MX; checked for email sign-ups
 * only, an OAuth provider has already verified the address), too many sign-ups
 * from one network in an hour, too many for one small domain in a day. Every
 * decision is recorded (signup_attempts) for the abuse watcher.
 *
 * Fails OPEN on our own errors (RPC down, DNS timeout): a broken check must
 * never turn away real people; the refusals above are the only "no".
 */

import { ageDaysFromRdap, judgeDomain } from "./judge.ts";

const IP_SALT = Deno.env.get("IP_HASH_SALT") ?? "atlarix-rl";
const HOOK_SECRET = Deno.env.get("BEFORE_USER_CREATED_HOOK_SECRET") ?? "";
const LIMITS = { ipPerHour: 5, domainPerDay: 20 };

type HookPayload = {
  metadata?: { uuid?: string; time?: string; name?: string; ip_address?: string };
  user?: { id?: string; email?: string; app_metadata?: { provider?: string; providers?: string[] } };
};

const encoder = new TextEncoder();

async function hmacBase64(secret: Uint8Array, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret as unknown as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** Standard Webhooks: `webhook-signature: v1,<base64>` over `${id}.${timestamp}.${body}`, secret `v1,whsec_<base64>`. */
export async function verifySignature(req: Request, body: string, secret: string): Promise<boolean> {
  if (!secret) return false;
  const id = req.headers.get("webhook-id") ?? "";
  const ts = req.headers.get("webhook-timestamp") ?? "";
  const sigHeader = req.headers.get("webhook-signature") ?? "";
  if (!id || !ts || !sigHeader) return false;
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;
  const raw = secret.replace(/^v1,/, "").replace(/^whsec_/, "");
  const key = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0));
  const expected = await hmacBase64(key, `${id}.${ts}.${body}`);
  return sigHeader.split(" ").some((part) => {
    const [version, value] = part.split(",");
    return version === "v1" && value && timingSafeEqual(value, expected);
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", encoder.encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What DNS and RDAP say about a mail domain, each piece within its own short timeout. */
export async function lookDomainUp(domain: string, timeoutMs = 1500): Promise<{
  mxHost: string | null;
  receivesMail: boolean | "unknown";
  hasWeb: boolean | null;
  ageDays: number | null;
}> {
  const within = <T>(p: Promise<T>, fallback: T): Promise<T> =>
    Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), timeoutMs))]);
  const mx = await within(Deno.resolveDns(domain, "MX"), null as Deno.MxRecord[] | null);
  const mxHost = mx && mx.length ? [...mx].sort((a, b) => a.preference - b.preference)[0]!.exchange.replace(/\.$/, "").toLowerCase() : null;
  const apexA = within(Deno.resolveDns(domain, "A"), null as string[] | null);
  const apexAAAA = within(Deno.resolveDns(domain, "AAAA"), null as string[] | null);
  const wwwA = within(Deno.resolveDns(`www.${domain}`, "A"), null as string[] | null);
  const rdap = within(
    fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { headers: { Accept: "application/rdap+json" } })
      .then((r) => (r.ok ? r.json() : null)),
    null as unknown,
  );
  const [a, aaaa, w, doc] = await Promise.all([apexA, apexAAAA, wwwA, rdap]);
  const anyAnswer = a !== null || aaaa !== null || w !== null;
  const hasWeb = !anyAnswer ? null : Boolean((a && a.length) || (aaaa && aaaa.length) || (w && w.length));
  const receivesMail: boolean | "unknown" = mxHost ? true : mx === null ? (hasWeb === null ? "unknown" : hasWeb) : hasWeb === null ? "unknown" : hasWeb;
  return { mxHost, receivesMail, hasWeb, ageDays: ageDaysFromRdap(doc) };
}

/** Kept for callers of the old name: an MX, or failing that an address. */
export async function domainReceivesMail(domain: string, timeoutMs = 1500): Promise<boolean | "unknown"> {
  return (await lookDomainUp(domain, timeoutMs)).receivesMail;
}

const allow = () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
const refuse = (code: 403 | 429, message: string) =>
  new Response(JSON.stringify({ error: { http_code: code, message } }), {
    status: code,
    headers: { "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });
  const body = await req.text();
  if (!(await verifySignature(req, body, HOOK_SECRET))) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  let payload: HookPayload;
  try {
    payload = JSON.parse(body) as HookPayload;
  } catch {
    return allow();
  }
  const email = (payload.user?.email ?? "").trim().toLowerCase();
  const domain = email.split("@")[1] ?? "";
  const provider = payload.user?.app_metadata?.provider ?? "email";
  const ip = payload.metadata?.ip_address ?? "";
  const ipHash = ip ? await sha256Hex(`${IP_SALT}:${ip}`) : "";
  if (!domain) return allow();

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return allow();
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // DNS and RDAP first, so the check can use the mail host; a major provider
  // (gmail, outlook, …) is never looked up or judged.
  const MAJOR = /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|proton|protonmail|pm|hey|fastmail|yandex|mail|gmx|web|qq|163|126|aol|zoho|tutanota|tuta)\.(com|me|io|ru|de|net)$/;
  const look = MAJOR.test(domain)
    ? { mxHost: null, receivesMail: true as const, hasWeb: true, ageDays: null }
    : await lookDomainUp(domain);

  const record = async (allowed: boolean, reason: string | null) => {
    await db
      .rpc("record_signup_attempt_service", {
        p_ip_hash: ipHash,
        p_domain: domain,
        p_provider: provider,
        p_allowed: allowed,
        p_reason: reason,
        p_mx_host: look.mxHost,
        p_has_web: look.hasWeb,
        p_domain_age_days: look.ageDays,
      })
      .then(({ error }) => error && console.error("[hook] record failed:", error.message));
  };
  const learn = async (reason: string) => {
    await db
      .rpc("learn_throwaway_domain_service", { p_domain: domain, p_mx_host: look.mxHost, p_reason: reason })
      .then(({ error }) => error && console.error("[hook] learn failed:", error.message));
  };

  try {
    const { data, error } = await db.rpc("signup_check_service", {
      p_email: email,
      p_ip_hash: ipHash,
      p_provider: provider,
      p_mx_host: look.mxHost,
    });
    if (error || !data?.ok) {
      console.error("[hook] signup_check failed:", error?.message ?? data?.error);
      return allow();
    }
    const check = data as {
      disposable: boolean; major: boolean; ip_1h: number; domain_24h: number;
      ip_noweb_7d?: number; mx_known?: boolean; mx_shared?: boolean;
    };

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
      if (judged.learn) await learn(judged.reason);
      await record(false, judged.reason);
      return refuse(403, "Sign up with a regular email address. Temporary mailboxes aren't accepted.");
    }
    if (check.ip_1h >= LIMITS.ipPerHour) {
      await record(false, "ip_burst");
      return refuse(429, "Too many sign-ups from this network in the last hour. Try again later.");
    }
    if (!check.major && check.domain_24h >= LIMITS.domainPerDay) {
      await record(false, "domain_burst");
      return refuse(429, "Too many sign-ups for this email domain today. Try again tomorrow.");
    }
    if (provider === "email" && look.receivesMail === false) {
      await record(false, "no_mx");
      return refuse(403, "That email domain can't receive mail. Check the address.");
    }
    // Allowed, with what was seen on record (the watcher reads it): a no-website
    // or young domain is a flag, not a refusal, until a second sign appears.
    await record(true, judged.flag ?? null);
    return allow();
  } catch (e) {
    console.error("[hook] error, allowing:", e instanceof Error ? e.message : e);
    return allow();
  }
});
