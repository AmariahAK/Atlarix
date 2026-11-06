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

import { type CheckResult, decideSignup, lookDomainUp } from "./decide.ts";

const IP_SALT = Deno.env.get("IP_HASH_SALT") ?? "atlarix-rl";
const HOOK_SECRET = Deno.env.get("BEFORE_USER_CREATED_HOOK_SECRET") ?? "";

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
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    console.error("[hook] no SUPABASE_URL / service key: sign-up allowed unchecked");
    return allow();
  }
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const ip = payload.metadata?.ip_address ?? "";

  const decision = await decideSignup(
    {
      email: payload.user?.email ?? "",
      provider: payload.user?.app_metadata?.provider ?? "email",
      ipHash: ip ? await sha256Hex(`${IP_SALT}:${ip}`) : "",
    },
    {
      lookup: (domain) => lookDomainUp(domain),
      check: async ({ email, ipHash, provider, mxHost }) => {
        const { data, error } = await db.rpc("signup_check_service", {
          p_email: email,
          p_ip_hash: ipHash,
          p_provider: provider,
          p_mx_host: mxHost,
        });
        if (error || !data?.ok) {
          console.error("[hook] signup_check failed:", error?.message ?? data?.error);
          return null;
        }
        return data as CheckResult;
      },
      record: async (r) => {
        const { error } = await db.rpc("record_signup_attempt_service", {
          p_ip_hash: r.ipHash,
          p_domain: r.domain,
          p_provider: r.provider,
          p_allowed: r.allowed,
          p_reason: r.reason,
          p_mx_host: r.look.mxHost,
          p_has_web: r.look.hasWeb,
          p_domain_age_days: r.look.ageDays,
        });
        if (error) console.error("[hook] record failed:", error.message);
      },
      learn: async (domain, mxHost, reason) => {
        const { error } = await db.rpc("learn_throwaway_domain_service", { p_domain: domain, p_mx_host: mxHost, p_reason: reason });
        if (error) console.error("[hook] learn failed:", error.message);
      },
    },
  );
  return decision.allow ? allow() : refuse(decision.status, decision.message);
});
