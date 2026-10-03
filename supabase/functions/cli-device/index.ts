import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, getAuthedUser, json } from "../_shared/auth.ts";
import { normalizeUserCode, randomUserCode } from "../_shared/device-codes.ts";
import { isValidPublicKey, sealFor } from "../_shared/device-seal.ts";

/**
 * Device-code sign-in for the CLI (`atlarix login --device`), RFC 8628's shape.
 *
 *   start    (the CLI, no account)  → device_code (secret, kept by the CLI),
 *                                     user_code (shown to the user), interval
 *   describe (signed-in user)       → what is waiting under a user_code, so the
 *                                     page can show it before anything is approved
 *   approve  (signed-in user)       → seals THIS fresh session to the CLI's key
 *   deny     (signed-in user)       → the CLI's poll ends with access_denied
 *   poll     (the CLI)              → authorization_pending | slow_down |
 *                                     access_denied | expired_token | the sealed
 *                                     session (exactly once; the row goes with it)
 *
 * THREATS, AND WHAT ANSWERS EACH
 *
 * * Phishing ("approve this code for me"). The weakness of every device flow.
 *   The page never takes the code from a link: the user types the code their
 *   OWN terminal shows, and the page says plainly to approve only a sign-in they
 *   started, with when it started. There is no verification_uri_complete.
 * * A database read. The device code is stored only as SHA-256, and the session
 *   only sealed to the CLI's one-time key (_shared/device-seal.ts). A dump yields
 *   neither a pollable code nor a usable session.
 * * Guessing user codes. 20^8 ≈ 2.6e10 codes, each alive 10 minutes; a hit
 *   would sign the VICTIM's CLI into the GUESSER's account (they approve with
 *   their own session), which the CLI shows by email straight away.
 * * Flooding `start`. At most PENDING_PER_IP pending codes per address (keyed
 *   by an HMAC of the address, never the address itself); expired rows are
 *   swept on every start.
 * * Fast polling. Faster than the interval earns slow_down (RFC 8628 §3.5).
 *
 * The approving session is a FRESH one: the page signs in with a client that
 * stores nothing (as /auth/app does) and hands that session over whole. The
 * browser keeps no copy, and signing out the CLI later ends only the CLI.
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("NEXT_PUBLIC_SUPABASE_SECRET_KEY");

const VERIFICATION_URI = "https://www.atlarix.dev/auth/cli";
const LIFETIME_S = 600;
const INTERVAL_S = 5;
const PENDING_PER_IP = 5;

const enc = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomDeviceCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || "unknown";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("[cli-device] Supabase service credentials missing");
    return json({ error: "server_misconfigured" }, 500);
  }
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const str = (k: string, max = 4096) => (typeof body[k] === "string" && (body[k] as string).length <= max ? (body[k] as string) : "");
  const nowIso = new Date().toISOString();

  switch (body.action) {
    case "start": {
      const publicKey = str("public_key", 200);
      if (!(await isValidPublicKey(publicKey))) return json({ error: "invalid_request" }, 400);
      await admin.from("cli_device_codes").delete().lt("expires_at", nowIso);
      const ipHash = await hmacHex(SERVICE_KEY, clientIp(req));
      const { count } = await admin
        .from("cli_device_codes")
        .select("id", { count: "exact", head: true })
        .eq("client_ip_hash", ipHash)
        .eq("status", "pending");
      if ((count ?? 0) >= PENDING_PER_IP) return json({ error: "too_many_requests" }, 429);

      const deviceCode = randomDeviceCode();
      const label = str("label", 120).replace(/[^\p{L}\p{N} ·._()-]/gu, "").slice(0, 80) || null;
      // A user-code collision is ~1 in 10^10; retry rather than reason about it.
      for (let attempt = 0; attempt < 3; attempt++) {
        const userCode = randomUserCode();
        const { error } = await admin.from("cli_device_codes").insert({
          device_code_hash: await sha256Hex(deviceCode),
          user_code: userCode,
          client_public_key: publicKey,
          client_label: label,
          client_ip_hash: ipHash,
          expires_at: new Date(Date.now() + LIFETIME_S * 1000).toISOString(),
        });
        if (!error) {
          return json({
            device_code: deviceCode,
            user_code: userCode,
            verification_uri: VERIFICATION_URI,
            expires_in: LIFETIME_S,
            interval: INTERVAL_S,
          });
        }
        if (error.code !== "23505") {
          console.error("[cli-device] start insert failed", error.code);
          return json({ error: "server_error" }, 500);
        }
      }
      return json({ error: "server_error" }, 500);
    }

    case "poll": {
      const deviceCode = str("device_code", 100);
      if (!deviceCode) return json({ error: "invalid_request" }, 400);
      const hash = await sha256Hex(deviceCode);
      // Approved: collect and delete in ONE statement, so a session is handed out once.
      const { data: taken } = await admin
        .from("cli_device_codes")
        .delete()
        .eq("device_code_hash", hash)
        .eq("status", "approved")
        .gt("expires_at", nowIso)
        .select("sealed_session")
        .maybeSingle();
      if (taken?.sealed_session) return json({ sealed_session: taken.sealed_session });

      const { data: row } = await admin
        .from("cli_device_codes")
        .select("id, status, expires_at, last_polled_at")
        .eq("device_code_hash", hash)
        .maybeSingle();
      if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
        if (row) await admin.from("cli_device_codes").delete().eq("id", row.id);
        return json({ error: "expired_token" }, 400);
      }
      if (row.status === "denied") {
        await admin.from("cli_device_codes").delete().eq("id", row.id);
        return json({ error: "access_denied" }, 400);
      }
      const tooSoon = row.last_polled_at && Date.now() - new Date(row.last_polled_at).getTime() < (INTERVAL_S - 1) * 1000;
      await admin.from("cli_device_codes").update({ last_polled_at: nowIso }).eq("id", row.id);
      return json({ error: tooSoon ? "slow_down" : "authorization_pending" }, 400);
    }

    case "describe":
    case "approve":
    case "deny": {
      const user = await getAuthedUser(req);
      if (!user) return json({ error: "unauthorized" }, 401);
      const userCode = normalizeUserCode(str("user_code", 32));
      if (!userCode) return json({ error: "invalid_code" }, 400);
      const { data: row } = await admin
        .from("cli_device_codes")
        .select("id, status, client_label, client_public_key, created_at, expires_at")
        .eq("user_code", userCode)
        .eq("status", "pending")
        .gt("expires_at", nowIso)
        .maybeSingle();
      // One answer for "no such code", "expired" and "already used": the page
      // learns nothing about codes it does not hold.
      if (!row) return json({ error: "invalid_code" }, 404);

      if (body.action === "describe") {
        return json({ label: row.client_label, created_at: row.created_at, expires_at: row.expires_at });
      }
      if (body.action === "deny") {
        await admin.from("cli_device_codes").update({ status: "denied" }).eq("id", row.id).eq("status", "pending");
        return json({ ok: true });
      }

      const accessToken = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      const refreshToken = str("refresh_token", 512);
      if (!refreshToken) return json({ error: "invalid_request" }, 400);
      const sealed = await sealFor(
        row.client_public_key,
        JSON.stringify({ access_token: accessToken, refresh_token: refreshToken }),
      );
      const { data: updated } = await admin
        .from("cli_device_codes")
        .update({ status: "approved", sealed_session: sealed, approved_by: user.id })
        .eq("id", row.id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();
      if (!updated) return json({ error: "invalid_code" }, 404);
      return json({ ok: true, email: user.email });
    }

    default:
      return json({ error: "invalid_request" }, 400);
  }
});
