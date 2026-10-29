import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * The one-tap "lift this ban" link in the abuse watcher's message to the
 * owner. GET shows one button; POST checks the signature and the expiry, lifts
 * the ban at both levels (lift_ban_service) and tells Discord.
 *
 * The link is `?uid=<uuid>&exp=<unix seconds>&sig=<hex hmac>` where
 * sig = HMAC-SHA256(LIFT_LINK_SECRET, `${uid}.${exp}`). Only the watcher holds
 * the secret, so only a message it sent can carry a working link; a link is
 * good for 48 h. No login, because the owner taps it on a phone: the secret
 * and the expiry are the whole authorisation, which is why it does nothing
 * but lift one named ban.
 */

const SECRET = Deno.env.get("LIFT_LINK_SECRET") ?? "";
const WEBHOOK = Deno.env.get("ALERT_WEBHOOK_URL") ?? "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

export async function expectedSig(secret: string, uid: string, exp: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`${uid}.${exp}`));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function valid(url: URL): Promise<{ ok: true; uid: string } | { ok: false; why: string }> {
  const uid = url.searchParams.get("uid") ?? "";
  const exp = url.searchParams.get("exp") ?? "";
  const sig = url.searchParams.get("sig") ?? "";
  if (!SECRET) return { ok: false, why: "not configured" };
  if (!UUID.test(uid) || !/^\d{1,12}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, why: "malformed link" };
  if (Number(exp) * 1000 < Date.now()) return { ok: false, why: "this link has expired" };
  if (!same(sig, await expectedSig(SECRET, uid, exp))) return { ok: false, why: "bad signature" };
  return { ok: true, uid };
}

const page = (title: string, body: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font:16px system-ui;background:#0a0e0d;color:#cfe8dd;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="max-width:420px;padding:28px;border:1px solid #35413b;border-radius:14px;background:#111715;text-align:center">
<h1 style="font-size:18px;margin:0 0 12px">${title}</h1>${body}</main>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const v = await valid(url);
  if (!v.ok) return page("Can't lift this ban", `<p>${v.why}.</p>`);

  if (req.method === "GET") {
    return page(
      "Lift the ban?",
      `<p style="color:#7c948a;font-size:14px">Account <code>${v.uid.slice(0, 8)}…</code> was banned automatically.</p>
<form method="post"><button style="margin-top:14px;padding:10px 18px;border-radius:8px;border:0;background:#3ddc97;color:#06130d;font-weight:600">Lift the ban</button></form>`,
    );
  }
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });

  const dbUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!dbUrl || !serviceKey) return page("Can't lift this ban", "<p>not configured.</p>");
  const db = createClient(dbUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await db.rpc("lift_ban_service", { p_user_id: v.uid, p_by: "owner-link" });
  if (error || !data?.ok) return page("Can't lift this ban", `<p>${error?.message ?? data?.error ?? "unknown error"}</p>`);

  if (WEBHOOK) {
    await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `✅ **Ban lifted** by the owner's link: account \`${v.uid.slice(0, 8)}…\` (${data.lifted} ban record${data.lifted === 1 ? "" : "s"})` }),
    }).catch(() => {});
  }
  return page("Ban lifted", `<p>Account <code>${v.uid.slice(0, 8)}…</code> can sign in again.</p>`);
});
