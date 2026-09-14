/**
 * Publish this browser's site grants to the account, and apply what the website
 * has asked this browser to revoke.
 *
 * ══ THIS DOES NOT MAKE A GRANT AN ACCOUNT THING ══
 *
 * `site-grants.ts` explains why grants live in `storage.sync` and not in the
 * account: a grant is a statement about ONE BROWSER PROFILE, and pushing one to
 * every device the user signs into would widen the agent's reach on machines
 * they never approved it on. That still holds. Nothing here creates a grant.
 * The browser remains the only place one is made, behind a user gesture that
 * the agent loop structurally cannot reach.
 *
 * WHAT THIS IS IS A MIRROR AND A ONE-WAY VALVE. We publish the list the panel's
 * own drawer already shows, and the website may mark a row revoked. Every flow
 * NARROWS what the agent may touch. There is no path here that widens it, which
 * is why the pull returns origins to REMOVE and never origins to add — a list
 * of origins arriving from the network and being granted is precisely the hole
 * this shape does not have.
 *
 * ORDER MATTERS ON THE WAY OUT. `revokeHostAccess()` removes Chrome's
 * permission and then the record, and this module calls it rather than
 * `revokeSite()` — a record dropped without the permission leaves the browser
 * still allowing what the user just revoked on the website.
 *
 * FAILURE IS SILENT, and here that convention is right: the grant list in the
 * panel is authoritative for this browser, the website's copy is a mirror, and
 * a mirror that is briefly stale costs nothing. Nothing in this file throws and
 * nothing in it is allowed to block the panel opening.
 */

import { GOTRUE } from "../auth/config";
import { getAccessToken } from "../auth/sign-in";
import { api } from "../shared/browser-api";
import { listGrants } from "./site-grants";
import { revokeHostAccess } from "./host-access";

/** Where this profile's id lives. `local`, NEVER `sync`. */
const DEVICE_KEY = "atlarix.deviceId.v1";

/**
 * A stable id for this browser profile.
 *
 * `storage.local` and not `storage.sync`, which is the whole point of having
 * one: a synced id would be the same value in every browser the user signs
 * into, and the column exists precisely so a work laptop's grants and a home
 * machine's do not merge into one list.
 *
 * Opaque and random. It is never rendered — `device_label` is what the user
 * reads — and it identifies a browser, not a person.
 */
export async function deviceId(): Promise<string> {
  const stored = await api().storage.local.get(DEVICE_KEY);
  const existing = stored?.[DEVICE_KEY];
  if (typeof existing === "string" && /^[A-Za-z0-9-]{8,64}$/.test(existing)) {
    return existing;
  }
  const fresh = crypto.randomUUID();
  await api().storage.local.set({ [DEVICE_KEY]: fresh });
  return fresh;
}

/**
 * What the user reads in the account page's list: "Chrome on macOS".
 *
 * Derived, not stored, and replaced on every push — a browser that updates its
 * platform string just re-labels itself rather than keeping a stale name
 * forever. Deliberately coarse: this is a label to tell two browsers apart, and
 * a full user-agent string on a web page is a fingerprint we have no use for.
 */
export function deviceLabel(ua: string = navigator.userAgent): string {
  const browser = /\bEdg\//.test(ua)
    ? "Edge"
    : /\bOPR\//.test(ua)
      ? "Opera"
      : /\bBrave\//.test(ua)
        ? "Brave"
        : /\bVivaldi\//.test(ua)
          ? "Vivaldi"
          : "Chrome";
  const os = /Mac OS X|Macintosh/.test(ua)
    ? "macOS"
    : /Windows/.test(ua)
      ? "Windows"
      : /CrOS/.test(ua)
        ? "ChromeOS"
        : /Android/.test(ua)
          ? "Android"
          : /Linux/.test(ua)
            ? "Linux"
            : "this device";
  return `${browser} on ${os}`.slice(0, 64);
}

function rpcUrl(fn: string): string {
  return `${GOTRUE.url.replace(/\/+$/, "")}/rest/v1/rpc/${fn}`;
}

/** One RPC round trip. `null` on anything at all going wrong. */
async function callSync(
  origins: string[],
): Promise<{ revoke: string[] } | null> {
  const token = await getAccessToken();
  if (!token) return null;
  const res = await fetch(rpcUrl("sync_extension_site_grants"), {
    method: "POST",
    headers: {
      apikey: GOTRUE.anonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_input: {
        device_id: await deviceId(),
        device_label: deviceLabel(),
        origins,
      },
    }),
  });
  if (!res.ok) return null;
  const out = (await res.json()) as { ok?: boolean; revoke?: unknown };
  if (!out.ok) return null;
  const revoke = Array.isArray(out.revoke)
    ? out.revoke.filter((o): o is string => typeof o === "string")
    : [];
  return { revoke };
}

/**
 * Push, apply, push again.
 *
 * The second push is not belt-and-braces: it is what CLEARS an applied
 * revocation. The server keeps a revoked row until the browser stops listing
 * the origin, so without the second call the website would keep showing the
 * site as "revoking" until the next time the panel opened.
 *
 * Call AFTER `pruneRevokedGrants`, so what gets published is a list Chrome has
 * already agreed with rather than one we only believe.
 */
export async function syncSiteGrants(): Promise<{ revoked: string[] }> {
  try {
    const origins = (await listGrants()).map((g) => g.origin);
    const first = await callSync(origins);
    if (!first || first.revoke.length === 0) return { revoked: [] };

    // A revoked origin may already be gone locally — the user removed it in the
    // panel before the panel pushed. Applying it again is harmless; both halves
    // of `revokeHostAccess` are idempotent.
    for (const origin of first.revoke) {
      await revokeHostAccess(origin);
    }

    const remaining = (await listGrants()).map((g) => g.origin);
    await callSync(remaining);
    return { revoked: first.revoke };
  } catch {
    return { revoked: [] };
  }
}
