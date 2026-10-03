/**
 * The short-lived token that lets a browser view one relic.
 *
 * The `relics` edge function decides WHO may view (the owner, or anyone for a
 * relic shared by link) and mints this; the relics.atlarix.dev Worker only
 * checks it — it never sees a Supabase session or the database. So relic files
 * are served from a different SITE than atlarix.dev, with no cookies.
 *
 *   token = base64url(JSON {r: relicId, e: expiry-seconds}) "." base64url(HMAC-SHA256)
 *
 * Web Crypto only: the same code runs in Deno (edge function), Workers and Bun.
 * The Worker keeps a copy (atlarix-launchpad/workers/relics/token.js); both are
 * tested against the same vector.
 */
const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** A token for `relicId`, good for `ttlSeconds` from `now` (seconds). */
export async function signRelicToken(
  secret: string,
  relicId: string,
  ttlSeconds = 15 * 60,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ r: relicId, e: now + ttlSeconds })));
  return `${payload}.${b64url(await hmac(secret, payload))}`;
}

/** The relic id the token is good for, or null (forged, malformed or expired). */
export async function verifyRelicToken(
  secret: string,
  token: string,
  now = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  const want = await hmac(secret, payload);
  let got: Uint8Array;
  try {
    got = fromB64url(sig);
  } catch {
    return null;
  }
  if (got.length !== want.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want[i]! ^ got[i]!;
  if (diff !== 0) return null;
  try {
    const { r, e } = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { r?: unknown; e?: unknown };
    if (typeof r !== "string" || typeof e !== "number" || e < now) return null;
    return r;
  } catch {
    return null;
  }
}
