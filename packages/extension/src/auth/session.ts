/**
 * The stored Supabase session.
 *
 * WHERE IT LIVES, AND THE COST OF THAT. `chrome.storage.local` is a plain
 * LevelDB file on disk. Any local process running as the user can read it, so
 * the refresh token sits there in clear — where the desktop app wraps the same
 * data in Electron `safeStorage`. That is inherent to the platform rather than
 * a decision we could make differently: MV3 offers no keychain, and an
 * encryption key the extension can reach is a key that process can reach too.
 *
 * It is recorded here, at the module someone will open when they reach for the
 * refresh token, rather than only in a design doc. The mitigation is scope: this
 * session grants Atlarix Core and nothing else, and every action it can drive
 * still passes the per-site grant and the always-ask classifier.
 *
 * `storage.local` and not `storage.sync`: a session is device state, and
 * `sync` replicates to every profile the user signs into — the exact opposite
 * of what a credential wants. (Site grants go the other way for the same
 * reason, and `site-grants.ts` explains that side of it.)
 */

import { api } from "../shared/browser-api";

/** Where the session lives. Versioned, matching `atlarix.siteGrants.v1`. */
const STORAGE_KEY = "atlarix.session.v1";

/** 60s of slack, so a token is never spent in the instant before it expires. */
const DEFAULT_SKEW_MS = 60_000;

export interface StoredSession {
  access_token: string;
  refresh_token: string;
  /**
   * Epoch SECONDS, computed by us from `expires_in` at the moment of receipt.
   *
   * Not read from GoTrue's own `expires_at`: that field is absent from some
   * response shapes while `expires_in` is always present, and a missing absolute
   * expiry silently becomes `NaN`, which compares false against everything and
   * makes a dead token look permanently fresh.
   */
  expires_at: number;
  token_type: string;
  user: { id: string; email?: string } | null;
}

/** What GoTrue's `/token` endpoints return, in the parts we use. */
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
  user?: { id: string; email?: string } | null;
}

/** Build a `StoredSession` from a GoTrue token response. */
export function sessionFromTokenResponse(body: TokenResponse): StoredSession {
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + body.expires_in,
    token_type: body.token_type ?? "bearer",
    user: body.user ?? null,
  };
}

/**
 * True when the record is the shape we wrote.
 *
 * `chrome.storage.local` is a file any local process can rewrite, so what comes
 * back is untrusted input, not a value we stored. Validating here turns a
 * corrupt or tampered record into a clean signed-out state instead of a
 * `TypeError` six frames down inside a fetch.
 */
function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.access_token === "string" &&
    s.access_token.length > 0 &&
    typeof s.refresh_token === "string" &&
    s.refresh_token.length > 0 &&
    typeof s.expires_at === "number" &&
    Number.isFinite(s.expires_at)
  );
}

/** The stored session, or null if there is none or it is malformed. */
export async function readSession(): Promise<StoredSession | null> {
  const bag = await api().storage.local.get(STORAGE_KEY);
  const raw = (bag as Record<string, unknown>)[STORAGE_KEY];
  return isStoredSession(raw) ? raw : null;
}

export async function writeSession(session: StoredSession): Promise<void> {
  await api().storage.local.set({ [STORAGE_KEY]: session });
}

export async function clearSession(): Promise<void> {
  await api().storage.local.remove(STORAGE_KEY);
}

/** Whether the access token is spent, counting the skew as already spent. */
export function isExpired(
  session: StoredSession,
  nowMs: number = Date.now(),
  skewMs: number = DEFAULT_SKEW_MS,
): boolean {
  return session.expires_at * 1000 <= nowMs + skewMs;
}
