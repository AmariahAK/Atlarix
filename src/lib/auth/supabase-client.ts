/**
 * Supabase Client - Auth & User Data
 * ==================================
 * Central Supabase client for authentication and user management.
 * All user data (diagrams, prompts) stays LOCAL in SQLite.
 * Supabase only stores: user_id, email, plan, lemon_customer_id
 *
 * Created: v1.0.0 (2026-01-14)
 */

import {
  createClient,
  SupabaseClient,
  Session,
  User,
  SupportedStorage,
} from "@supabase/supabase-js";
import log from "electron-log";
import { randomBytes } from "node:crypto";
import { clipboard, dialog, shell } from "electron";
import {
  createSecureSupabaseStorage,
  clearSupabaseSecureStorage,
} from "./supabase-secure-storage";
import { resolveOfflineEntitlement } from "./offline-entitlement";

const logger = log.scope("supabase");

// ============================================
// CONFIGURATION
// ============================================

// Deep link protocol for OAuth callback
export const DEEP_LINK_PROTOCOL = "atlarix";
// Inbound spelling: what `new URL(...).pathname` reads as when the OS hands us
// `atlarix://auth/callback` (hostname `auth`, pathname `/callback`) OR the
// three-slash `atlarix:///auth/callback` (empty hostname, pathname
// `/auth/callback`). main.ts accepts both.
export const AUTH_CALLBACK_PATH = "/auth/callback";
/**
 * OUTBOUND: the `redirectTo` handed to Supabase.
 *
 * This must be BYTE-IDENTICAL to an entry in the project's Auth → URL
 * Configuration → Redirect URLs list. GoTrue compiles each entry into a glob
 * and matches the requested redirect as a literal string; there is no URL
 * normalisation, so a slash count that differs is simply not a match.
 *
 * It used to be built as `${DEEP_LINK_PROTOCOL}://${AUTH_CALLBACK_PATH}`, which
 * concatenates to `atlarix:///auth/callback` — THREE slashes — and does not
 * match the allowlisted `atlarix://auth/callback`. A redirect that does not
 * match is not rejected: GoTrue silently substitutes the Site URL, so the
 * browser lands on https://www.atlarix.dev and the desktop app never receives
 * a deep link at all. The failure looks like "sign-in does nothing".
 */
export const AUTH_CALLBACK_URL = `${DEEP_LINK_PROTOCOL}://auth/callback`;

// ============================================
// SUPABASE CLIENT
// ============================================

let supabaseClient: SupabaseClient | null = null;
let fileStorage: SupportedStorage | null = null;

/**
 * Per-request ceiling for every Supabase HTTP call.
 *
 * Long enough that a slow-but-working connection still succeeds; short enough
 * that a dead one fails while the user is still looking at the screen. Realtime
 * websockets are NOT affected — they have their own lifecycle and the tuned
 * heartbeat below.
 */
export const SUPABASE_REQUEST_TIMEOUT_MS = 8_000;

/**
 * `fetch` with a hard deadline, respecting any caller-supplied AbortSignal.
 *
 * Exported for tests: the property that matters is that it REJECTS rather than
 * hanging, since every caller's error handling is already correct and was simply
 * unreachable before.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  // Injectable so tests don't have to wait the real 8s. `AbortSignal.timeout`
  // is a platform timer that vitest's fake timers do not drive, so this is the
  // only way to exercise the deadline quickly.
  timeoutMs: number = SUPABASE_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  // Don't discard a caller's own signal (supabase-js passes one for its own
  // cancellation); whichever aborts first wins.
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeout])
    : timeout;
  return fetch(input, { ...init, signal });
}

/**
 * Get or create Supabase client instance
 * Reads env vars at runtime (after dotenv.config is called in main.ts)
 * Falls back to embedded defaults for production builds where .env isn't bundled
 */
export function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    // Publishable key is the current Supabase API-key system; the legacy anon
    // JWT is kept only as a fallback for older local .env files.
    const supabaseAnonKey =
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      logger.warn(
        "[Supabase] Missing credentials - set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY in .env or CI",
      );
      throw new Error(
        "Supabase URL and anon key are required. Add them to .env (see .env.example).",
      );
    }

    // safeStorage-backed session persistence (see supabase-secure-storage.ts)
    fileStorage = createSecureSupabaseStorage();

    supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        storage: fileStorage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false, // We handle deep links manually
      },
      global: {
        // supabase-js sets NO default request timeout, so a black-hole
        // network (captive portal, VPN, hotel wifi — DNS resolves, TCP
        // never completes) hangs every call until the OS TCP timeout,
        // ~75s on macOS. Every caller below is written to degrade on a
        // FAILURE (`return 'free'`, `return null`), and none of them
        // degrade on a HANG — so bounding the request is what makes all
        // that existing error handling actually reachable.
        fetch: fetchWithTimeout,
      },
      // No `realtime` options: nothing subscribes to a channel any more, so
      // supabase-js never opens the socket those options would configure.
      // Tuning a keepalive for a connection that is never made is a setting
      // that reads as protection and provides none.
    });

    logger.log("[Supabase] Client initialized with secure storage");
  }

  return supabaseClient;
}

// ============================================
// OAUTH METHODS
// ============================================

// 60-second inbound deep-link timeout: if atlarix://auth/callback never arrives,
// show a fallback dialog so the user can copy the OAuth URL or register the handler.
let _oauthTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

// ── C4 (security review): auth-callback CSRF gate ──
// An `atlarix://auth/callback#access_token=…` deep link, if honored blindly,
// silently logs the desktop app into whatever account the tokens belong to
// (mailed-link login-CSRF → account takeover). We bind callback acceptance to a
// sign-in flow THIS app actually started, within a bounded window. A callback
// that arrives with no local flow pending is rejected. (A fully round-tripped
// state nonce is stronger but would need a query param on redirectTo, which must
// be confirmed against the Supabase redirect-URL allowlist first — tracked.)
let _authFlowStartedAt: number | null = null;
const AUTH_FLOW_MAX_AGE_MS = 10 * 60_000;

function markAuthFlowStarted(): void {
  _authFlowStartedAt = Date.now();
}
function consumeActiveAuthFlow(): boolean {
  const startedAt = _authFlowStartedAt;
  _authFlowStartedAt = null; // single-use: consume on any callback attempt
  if (startedAt == null) return false;
  return Date.now() - startedAt <= AUTH_FLOW_MAX_AGE_MS;
}

/**
 * Cancel the pending OAuth inbound timeout (called from main.ts when the
 * atlarix://auth/callback deep link is successfully received).
 */
export function cancelPendingOAuthTimeout(): void {
  if (_oauthTimeoutHandle !== null) {
    clearTimeout(_oauthTimeoutHandle);
    _oauthTimeoutHandle = null;
    logger.log(
      "[Supabase] OAuth inbound timeout cancelled — deep link received",
    );
  }
}

/**
 * Open a sign-in URL in the user's browser and arm the deep-link watchdog.
 *
 * Shared by OAuth and email sign-in: both finish on the same
 * `atlarix://auth/callback`, so both need the C4 flow marker, the 60s
 * "Sign-in not completing?" fallback and the Linux copy-the-link dialog.
 */
async function openSignInUrl(
  url: string,
  fallbackAfterMs = 60_000,
): Promise<void> {
  // A second click replaces the first flow; its watchdog must not fire later.
  cancelPendingOAuthTimeout();
  // C4: record that THIS app started a sign-in flow, so an unsolicited
  // auth callback (no flow pending) is rejected in handleAuthCallback.
  markAuthFlowStarted();
  // Open the OAuth URL in the user's default browser
  logger.log(`[Supabase] Opening OAuth URL in browser`);
  let browserOpened = false;
  try {
    await shell.openExternal(url);
    browserOpened = true;
    logger.log("[Supabase] shell.openExternal succeeded");
  } catch (openErr) {
    logger.error("[Supabase] shell.openExternal failed:", openErr);
  }

  // Inbound deep-link timeout: if atlarix://auth/callback is not received within
  // 60 seconds (e.g. deep link handler not registered on Linux / VM environments),
  // show a fallback dialog so the user can copy the OAuth URL manually.
  if (browserOpened) {
    const oauthUrlForFallback = url;
    _oauthTimeoutHandle = setTimeout(async () => {
      _oauthTimeoutHandle = null;
      logger.warn(
        `[Supabase] Sign-in inbound timeout — deep link not received after ${fallbackAfterMs / 1000}s`,
      );
      const linuxCommands =
        process.platform === "linux"
          ? "\n\nTo register the deep link handler on Linux, run in Terminal:\n  xdg-mime default atlarix.desktop x-scheme-handler/atlarix\n  update-desktop-database ~/.local/share/applications\n\nThen try signing in again."
          : "";
      const { response } = await dialog.showMessageBox({
        type: "info",
        title: "Sign-in not completing?",
        message:
          `Atlarix has been waiting ${fallbackAfterMs / 1000} seconds for the sign-in to come back.\n\nThe deep link handler may not be registered on your system.`,
        detail: `Sign-in URL (open this in your browser if the redirect didn't work):\n${oauthUrlForFallback}${linuxCommands}`,
        buttons: ["Copy Link", "Dismiss"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) {
        clipboard.writeText(oauthUrlForFallback);
        logger.log(
          "[Supabase] OAuth URL copied via 60s inbound timeout fallback",
        );
      }
    }, 60_000);
  }

  // Linux/AppImage fallback: allow the user to copy the URL manually if browser launch fails.
  if (!browserOpened && process.platform === "linux") {
    logger.warn(
      "[Supabase] Browser open failed on Linux — showing fallback dialog",
    );
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Open this link to sign in",
      message:
        "Atlarix could not open your browser automatically.\n\nCopy the link below and paste it into your browser:",
      detail: url,
      buttons: ["Copy Link", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      clipboard.writeText(url);
      logger.log(
        "[Supabase] OAuth URL copied to clipboard via fallback dialog",
      );
    }
  }
}

export type OAuthProvider = "google" | "github" | "discord";

/** Every way into an account: an OAuth provider, or email + password on atlarix.dev. */
export type SignInMethod = OAuthProvider | "email";

/**
 * Email + password happens on atlarix.dev, not here: Turnstile only renders on
 * a hostname registered to its site key, and Supabase refuses a password
 * sign-in without its token. The site signs in with a client that stores
 * nothing and redirects to `atlarix://auth/callback` with the tokens AND the
 * `state` we sent, which `handleAuthCallback` checks.
 */
const EMAIL_SIGN_IN_URL = "https://atlarix.dev/auth/app";

/**
 * The state nonce of the email sign-in in flight, or null. Unlike OAuth, this
 * flow round-trips a nonce: the site controls the redirect, so no Supabase
 * allowlist stands in the way.
 */
let _pendingAuthState: string | null = null;

export async function startEmailSignIn(): Promise<{ error: Error | null }> {
  const state = randomBytes(24).toString("base64url");
  _pendingAuthState = state;
  const url = `${EMAIL_SIGN_IN_URL}?client=desktop&state=${state}`;
  logger.log("[Supabase] Starting email sign-in via atlarix.dev");
  try {
    // Longer than OAuth's 60s: the user types an email and a password and
    // solves a check before anything comes back.
    await openSignInUrl(url, 180_000);
    return { error: null };
  } catch (err) {
    _pendingAuthState = null;
    return { error: err instanceof Error ? err : new Error("Unknown error") };
  }
}

/**
 * Start OAuth flow - opens browser for authentication
 * User will be redirected back to atlarix://auth/callback
 */
export async function signInWithOAuth(
  provider: OAuthProvider,
): Promise<{ error: Error | null }> {
  let supabase: SupabaseClient;
  try {
    supabase = getSupabaseClient();
  } catch (err) {
    logger.warn(
      "[Supabase] Cannot sign in: missing or invalid Supabase config.",
      err instanceof Error ? err.message : String(err),
    );
    return {
      error: new Error(
        "Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY to .env (see .env.example).",
      ),
    };
  }
  try {
    // Log the redirect we ask for. It is not a secret, and it is the one
    // value that makes an allowlist mismatch diagnosable: a redirect Supabase
    // does not recognise is silently REPLACED with the Site URL, so without
    // this line the failure has no fingerprint anywhere.
    logger.log(
      `[Supabase] Starting OAuth with ${provider}, redirectTo=${AUTH_CALLBACK_URL}`,
    );

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: AUTH_CALLBACK_URL,
        skipBrowserRedirect: true, // We'll open the browser ourselves
      },
    });

    if (error) {
      logger.error(`[Supabase] OAuth error:`, error);
      return { error };
    }

    if (data?.url) {
      // OAuth callbacks carry no state (the reverted PKCE/state attempt is in
      // the TODO); clear any left over from an abandoned email sign-in so its
      // check does not apply to this flow.
      _pendingAuthState = null;
      await openSignInUrl(data.url);
    }

    return { error: null };
  } catch (err) {
    logger.error(`[Supabase] OAuth exception:`, err);
    return { error: err instanceof Error ? err : new Error("Unknown error") };
  }
}

/**
 * Handle OAuth callback from deep link
 * Called when app receives atlarix://auth/callback?access_token=...
 */
export async function handleAuthCallback(url: string): Promise<{
  session: Session | null;
  user: User | null;
  error: Error | null;
}> {
  try {
    const supabase = getSupabaseClient();

    logger.log(`[Supabase] Handling auth callback`);

    // C4: reject callbacks that don't correspond to a sign-in this app just
    // started — defeats the mailed-link login-CSRF (account takeover).
    if (!consumeActiveAuthFlow()) {
      logger.warn(
        "[Supabase] Rejected auth callback — no sign-in flow was in progress (possible CSRF).",
      );
      return {
        session: null,
        user: null,
        error: new Error(
          "Unexpected sign-in link. No sign-in was in progress on this device — if you did not just start signing in, you can ignore this.",
        ),
      };
    }

    // Parse the URL to extract tokens
    const urlObj = new URL(url);
    const hashParams = new URLSearchParams(urlObj.hash.substring(1));

    // An email sign-in sent a nonce; its callback must return it. Single-use,
    // like the flow marker above.
    const expectedState = _pendingAuthState;
    _pendingAuthState = null;
    if (expectedState !== null && hashParams.get("state") !== expectedState) {
      logger.warn("[Supabase] Rejected auth callback — state mismatch.");
      return {
        session: null,
        user: null,
        error: new Error(
          "That sign-in link doesn't match the sign-in this app started. Start signing in again.",
        ),
      };
    }
    const accessToken = hashParams.get("access_token");
    const refreshToken = hashParams.get("refresh_token");

    if (!accessToken) {
      // Check for error in callback
      const error = hashParams.get("error");
      const errorDescription = hashParams.get("error_description");
      if (error) {
        return {
          session: null,
          user: null,
          error: new Error(errorDescription || error),
        };
      }
      return {
        session: null,
        user: null,
        error: new Error("No access token in callback"),
      };
    }

    // Set the session with the tokens
    const { data, error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken || "",
    });

    if (error) {
      logger.error(`[Supabase] Set session error:`, error);
      return { session: null, user: null, error };
    }

    // An account is keyed on its email — the users table, plan lookups, the
    // realtime plan channel and every billing path assume one. Discord only
    // releases an email when the account has VERIFIED one, so a provider can
    // hand back a session with no email at all. Letting that through creates
    // a half-account that signs in but can't be billed or plan-checked, and
    // fails later somewhere far from the cause. Refuse it here, and say why.
    if (!data.user?.email) {
      logger.warn(
        "[Supabase] Provider returned no email — refusing the session.",
      );
      try {
        // Local: only this just-created half-session, never the account's others.
        await supabase.auth.signOut({ scope: "local" });
      } catch {
        /* best-effort: don't leave a half-session behind */
      }
      return {
        session: null,
        user: null,
        error: new Error(
          "Your account didn't share an email address with Atlarix. On Discord this usually means the email isn't verified — verify it in Discord's settings, or sign in with Google or GitHub instead.",
        ),
      };
    }

    logger.log(`[Supabase] Session set successfully for ${data.user.email}`);

    // Ensure user exists in our users table
    await ensureUserExists(data.user);

    return {
      session: data.session,
      user: data.user,
      error: null,
    };
  } catch (err) {
    logger.error(`[Supabase] Callback exception:`, err);
    return {
      session: null,
      user: null,
      error: err instanceof Error ? err : new Error("Unknown error"),
    };
  }
}

/**
 * Get current session
 */
export async function getSession(): Promise<Session | null> {
  try {
    const supabase = getSupabaseClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return session;
  } catch {
    return null;
  }
}

/**
 * Get current user
 */
export async function getUser(): Promise<User | null> {
  try {
    const supabase = getSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user;
  } catch {
    return null;
  }
}

/**
 * Sign out
 */
export async function signOut(): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    // LOCAL, not supabase-js's default "global". Global revokes every session
    // the account has, so signing out of the app also signed the person out of
    // the Chrome extension, and would sign them out of the CLI. Each surface
    // holds its own session and ends only its own (the extension already works
    // this way: its sign-out just clears what it stored).
    await supabase.auth.signOut({ scope: "local" });
    await clearSupabaseSecureStorage();
    logger.log("[Supabase] Signed out");
  } catch (err) {
    logger.error("[Supabase] Sign out error:", err);
    try {
      await clearSupabaseSecureStorage();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Restore session on app startup: refresh if access token is expired or near expiry.
 * Call from main after app.ready, before showing the main window.
 *
 * Robustness (v13.9): the intermittent "reopen logs me out" bug came from two
 * transient conditions being treated as terminal — (1) `safeStorage`/keychain not
 * being ready the instant we read, so `getSession()` returns null even though a
 * valid session is on disk, and (2) a single `refreshSession()` failure (offline
 * at launch). We now retry the read once and the refresh with backoff, and we
 * NEVER clear the stored session on a transient failure — `autoRefreshToken`
 * recovers it once connectivity/keychain returns.
 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface RestoreAuthSessionOptions {
  /**
   * Fired the moment a stored session is in hand — BEFORE the expiry check and the
   * refresh backoff below.
   *
   * The account used to surface only after this whole function resolved, which meant
   * a signed-in user stared at a logged-out UI for up to ~4.4s on a cold launch
   * (400ms empty-read retry + `[0, 1000, 3000]` of refresh backoff + three network
   * round-trips). The stored session is already authoritative enough to render an
   * account; the refresh only rotates the token. Awaited, so the caller can finish
   * its own setup before the refresh starts competing for the network.
   */
  onStoredSession?: (session: Session) => void | Promise<void>;
}

export async function restoreAuthSessionOnStartup(
  opts?: RestoreAuthSessionOptions,
): Promise<void> {
  try {
    const supabase = getSupabaseClient();

    // (1) Read the stored session, retrying once if the first read comes back
    // empty — secure storage can be momentarily unavailable right at launch.
    let session = (await supabase.auth.getSession()).data.session;
    if (!session) {
      await sleep(400);
      session = (await supabase.auth.getSession()).data.session;
    }
    if (!session) {
      logger.log("[Supabase] No stored session on startup");
      return;
    }

    // Surface the account before spending anything on the network. A throw here
    // must not cost us the refresh below, so it's caught separately.
    try {
      await opts?.onStoredSession?.(session);
    } catch (cbErr) {
      logger.warn(
        "[Supabase] onStoredSession callback failed (non-fatal):",
        cbErr instanceof Error ? cbErr.message : cbErr,
      );
    }

    const exp = session.expires_at;
    if (!exp) return;
    const expiresMs = exp * 1000;
    const skewMs = 120_000;
    if (expiresMs >= Date.now() + skewMs) return; // still valid — nothing to do

    // (2) Refresh with bounded backoff. A transient failure must NOT drop the
    // session — keep it and let autoRefreshToken try again in the background.
    const delaysMs = [0, 1_000, 3_000];
    for (let attempt = 0; attempt < delaysMs.length; attempt++) {
      if (delaysMs[attempt]) await sleep(delaysMs[attempt]);
      const { data, error } = await supabase.auth.refreshSession();
      if (!error && data.session) {
        logger.log("[Supabase] Session refreshed on startup");
        return;
      }
      logger.warn(
        `[Supabase] Startup refresh attempt ${attempt + 1}/${delaysMs.length} failed:`,
        error?.message ?? "no session returned",
      );
    }
    logger.warn(
      "[Supabase] Startup refresh exhausted — keeping the stored session; autoRefreshToken will retry.",
    );
  } catch (err) {
    logger.warn(
      "[Supabase] restoreAuthSessionOnStartup skipped:",
      err instanceof Error ? err.message : err,
    );
  }
}

// ============================================
// USER DATA METHODS
// ============================================

export interface AtlarixUser {
  id: string;
  email: string;
  plan: "free" | "pro";
  lemonCustomerId: string | null;
  createdAt: string;
}

// ─── One read of the account's row, shared by every reader ───────────────────
//
// A signed-in launch read the SAME `users` row ~8 times (2026-10-17, measured in
// the Supabase edge logs): the plan, the ban flag, the subscription details, the
// onboarding flag, "does the row exist" and the plan snapshot each ran their own
// narrow query, and the session restore ran twice. They now share one read with
// every column they need: one in flight at a time, kept until something says the
// row changed (owner, 2026-10-20) — sign-in and sign-out, the focus refresh
// (SubscriptionManager.refreshPlanFromServer, which reads fresh and refills it),
// and every write here (`invalidatePlanCaches`). A few
// seconds' TTL made each later reader a read of its own.
//
// Each reader keeps its OWN query as the fallback when this one fails (a column
// not yet deployed, say), so a non-essential column can still never break the
// plan read — the rule the narrow queries below were written to keep.

const USER_ROW_SELECT =
  "id, email, plan, effective_tier, subscription_ends_at, subscription_status, lemon_subscription_id, lemon_variant_id, banned_at";

type UserRow = PlanRowInput & {
  id: string;
  email?: string | null;
};

/** The row last read, under every key it answers to (the id and the email it was asked by or carries). */
let _userRow: { keys: string[]; row: UserRow | null } | null = null;
const _userRowInFlight = new Map<string, Promise<UserRow | null | undefined>>();

/**
 * The account's row by id or email: the row, null when there is none, or
 * undefined when the read itself failed (the caller then runs its own query).
 * `fresh` skips the cache, for the paths whose job is to notice a change.
 */
async function readUserRow(
  by: { id?: string; email?: string },
  fresh = false,
): Promise<UserRow | null | undefined> {
  const key = by.id ? `id:${by.id}` : `email:${(by.email ?? "").toLowerCase()}`;
  const c = _userRow;
  if (!fresh && c && c.keys.includes(key)) return c.row;
  const pending = _userRowInFlight.get(key);
  if (pending) return pending;
  const p = (async () => {
    try {
      const q = getSupabaseClient().from("users").select(USER_ROW_SELECT);
      const { data, error } = await (by.id ? q.eq("id", by.id) : q.eq("email", by.email!)).maybeSingle();
      if (error) return undefined;
      const row = (data as UserRow | null) ?? null;
      const keys = [key];
      if (row?.id) keys.push(`id:${row.id}`);
      if (row?.email) keys.push(`email:${row.email.toLowerCase()}`);
      _userRow = { keys, row };
      return row;
    } catch {
      return undefined;
    } finally {
      _userRowInFlight.delete(key);
    }
  })();
  _userRowInFlight.set(key, p);
  return p;
}

/** Forget the shared row (a write, or an explicit refresh). */
function invalidateUserRow(): void {
  _userRow = null;
}

/** Test-only: forget the shared row and anything in flight. */
export function __resetUserRowForTests(): void {
  _userRow = null;
  _userRowInFlight.clear();
}

/**
 * Ensure user exists in our users table (create if not exists)
 */
async function ensureUserExists(user: User): Promise<void> {
  try {
    const supabase = getSupabaseClient();

    // Check if user exists (the shared row read; its own query if that failed)
    const shared = await readUserRow({ id: user.id });
    const existingUser =
      shared !== undefined
        ? shared
        : (await supabase.from("users").select("id").eq("id", user.id).single()).data;

    if (!existingUser) {
      const { error } = await supabase.from("users").insert({
        id: user.id,
        email: user.email,
        plan: "free",
      });
      invalidateUserRow();

      if (error) {
        logger.error("[Supabase] Failed to create user:", error);
      } else {
        logger.log(`[Supabase] Created user record for ${user.email}`);
      }
    }
  } catch (err) {
    logger.error("[Supabase] ensureUserExists error:", err);
  }
}

export type UserPlanDb = "free" | "pro";

type PlanRowInput = {
  plan: string;
  effective_tier?: string | null;
  subscription_ends_at?: string | null;
  subscription_status?: string | null;
  lemon_subscription_id?: string | null;
  lemon_variant_id?: string | null;
  banned_at?: string | null;
};

/**
 * When plan/effective_tier are still "free" but LemonSqueezy rows show a paid period,
 * infer Pro so the app matches billing (webhook may have updated status only).
 * For active/on_trial we do not require subscription_ends_at (renewal date is often null in DB).
 */
function inferPaidTierWhenStoredFree(row: PlanRowInput): UserPlanDb | null {
  const plan = (row.plan as UserPlanDb) || "free";
  const eff = (row.effective_tier as UserPlanDb) || plan;
  if (plan !== "free" || eff !== "free") return null;
  if (!row.lemon_subscription_id) return null;
  const st = (row.subscription_status || "").toLowerCase();
  const paidish = [
    "active",
    "on_trial",
    "cancelled",
    "paused",
    "past_due",
  ].includes(st);
  if (!paidish) return null;

  if (st === "active" || st === "on_trial") {
    return "pro";
  }

  const endsMs = row.subscription_ends_at
    ? new Date(row.subscription_ends_at).getTime()
    : 0;
  if (!endsMs || Number.isNaN(endsMs) || Date.now() >= endsMs) return null;
  return "pro";
}

/** Paid access: trust active/on_trial; otherwise use subscription_ends_at vs now. */
function computeEntitledPlan(row: PlanRowInput): UserPlanDb {
  const st = (row.subscription_status || "").toLowerCase();
  const activelyBilled = st === "active" || st === "on_trial";

  const inferred = inferPaidTierWhenStoredFree(row);
  if (inferred) {
    if (!activelyBilled) {
      const ends = row.subscription_ends_at
        ? new Date(row.subscription_ends_at).getTime()
        : 0;
      if (ends && Date.now() > ends) return "free";
    }
    return inferred;
  }

  const plan = (row.plan as UserPlanDb) || "free";
  const eff = (row.effective_tier as UserPlanDb) || plan;
  const tier: UserPlanDb = eff === "pro" ? eff : plan;
  if (tier === "free") return "free";
  const ends = row.subscription_ends_at
    ? new Date(row.subscription_ends_at).getTime()
    : 0;
  if (!activelyBilled && ends && Date.now() > ends) return "free";
  return tier;
}

/**
 * Columns this MUST NOT grow casually.
 *
 * `banned_at` was added here to make the ban check ride the plan read "at no
 * extra round-trip". It cost far more than a round-trip: the app ships
 * independently of the database, the migration creating that column had not been
 * applied, and PostgREST answers an unknown column with an error — so EVERY plan
 * read failed, `getUserPlan` fell back to `offlinePlanOr('free')`, and every user
 * silently became free. It failed as a `warn`, behind a graceful-looking
 * fallback.
 *
 * Naming a column here is a BREAKING CHANGE until its migration is deployed. Any
 * new column belongs in its own query that tolerates absence (see `isUserBanned`).
 */
const PLAN_ROW_SELECT_BASE =
  "plan, effective_tier, subscription_ends_at, subscription_status, lemon_subscription_id";
const PLAN_ROW_SELECT_WITH_VARIANT = `${PLAN_ROW_SELECT_BASE}, lemon_variant_id`;

async function fetchPlanRowForUser(
  supabase: ReturnType<typeof getSupabaseClient>,
  userId: string,
): Promise<{ data: PlanRowInput | null; error: Error | null }> {
  const shared = await readUserRow({ id: userId });
  if (shared !== undefined) return { data: shared, error: null };

  let data: PlanRowInput | null = null;
  let error: unknown = null;
  {
    const r1 = await supabase
      .from("users")
      .select(PLAN_ROW_SELECT_WITH_VARIANT)
      .eq("id", userId)
      .maybeSingle();
    data = r1.data as PlanRowInput | null;
    error = r1.error;
  }

  if (error) {
    const r2 = await supabase
      .from("users")
      .select(PLAN_ROW_SELECT_BASE)
      .eq("id", userId)
      .maybeSingle();
    data = r2.data as PlanRowInput | null;
    error = r2.error;
  }

  return { data, error: error as Error | null };
}

/**
 * Get user's plan from database
 */
export async function getUserPlan(userId: string): Promise<UserPlanDb> {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await fetchPlanRowForUser(supabase, userId);

    if (error) {
      logger.warn("[Supabase] getUserPlan error:", error.message);
      return offlinePlanOr("free", userId);
    }
    // A reachable server with no row genuinely means no entitlement — do NOT
    // fall back to the cache here, only when the request itself failed.
    if (!data) return "free";
    return computeEntitledPlan(data);
  } catch (err) {
    logger.warn("[Supabase] getUserPlan exception:", err);
    return offlinePlanOr("free", userId);
  }
}

/**
 * Is this account banned?
 *
 * Reads `users.banned_at` through the same JWT-scoped, RLS-backed path as the
 * plan. Runs once per real session change (updateSession), not per
 * `checkSession()` — the renderer's ~22 unshared useAuth consumers all read
 * main's cached session, and the realtime channel carries later flips, so there
 * is nothing to poll.
 *
 * FAILS OPEN on error, deliberately. This is a client-side UX gate; the
 * non-bypassable enforcement is the proxy's 403, which no client can talk its way
 * past. Failing closed here would lock a user out of their own API keys and local
 * models because Supabase blipped — punishing the wrong thing for the wrong
 * reason.
 */
export async function isUserBanned(userId: string): Promise<boolean> {
  try {
    // The shared row read first; it falls back to the narrow query below, so a
    // ban column problem still cannot break the plan read.
    const shared = await readUserRow({ id: userId });
    if (shared !== undefined) return !!shared?.banned_at;
    const supabase = getSupabaseClient();
    // Its OWN narrow query, deliberately not folded into the plan read. The
    // plan read is load-bearing for entitlement; this one is not, so it must
    // not be able to break it. Costs one extra round-trip per session
    // establish (updateSession, not per checkSession) — a price worth paying
    // to keep a non-essential column out of an essential query.
    const { data, error } = await supabase
      .from("users")
      .select("banned_at")
      .eq("id", userId)
      .maybeSingle();
    // Fails open on ANY error, including "column does not exist" before the
    // migration is deployed. A ban is enforced server-side by the proxy; this
    // is only the UX half, so a failure here must never lock anyone out.
    if (error || !data) return false;
    return !!(data as { banned_at?: string | null }).banned_at;
  } catch (err) {
    logger.warn("[Supabase] isUserBanned exception:", err);
    return false;
  }
}

/**
 * Server unreachable → honour the last plan the server confirmed, if it hasn't
 * expired. Always the fallback, never the first choice: a reachable server wins.
 */
function offlinePlanOr(fallback: UserPlanDb, userId: string): UserPlanDb {
  try {
    const { readSettings } = requireSettings();
    const cached = resolveOfflineEntitlement(
      readSettings().lastKnownEntitlement,
      userId,
    );
    if (cached) {
      logger.log(
        `[Supabase] offline — honouring last known plan: ${cached.plan}`,
      );
      return cached.plan;
    }
  } catch {
    /* settings unavailable (wrong process) — fall through */
  }
  return fallback;
}

/** Lazy require so this module stays importable from the renderer stub path. */
function requireSettings(): {
  readSettings: () => import("@/lib/schemas").UserSettings;
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/main/settings");
}

/**
 * Session-scoped effective-tier cache. `getEffectiveTier` is otherwise called
 * with 2–3 Supabase queries on EVERY auth event (incl. hourly token refresh)
 * and every plan-info fetch — for a single user that's a lot of redundant
 * round-trips. The cache dedupes them; correctness is preserved because the
 * realtime plan-change subscription invalidates on upgrade/downgrade and the
 * TTL bounds staleness for the rare missed event. Lazy refresh (re-fetch on
 * next access after TTL) — no polling timer is added, which would defeat the
 * purpose.
 */
// 30 min: long enough that the ~hourly auth refresh no longer always misses the
// cache and re-reads `users`, short enough to bound staleness for a rare missed
// realtime plan-change (the realtime sub + invalidatePlanCaches handle the common case).
const EFFECTIVE_TIER_TTL_MS = 30 * 60 * 1000;
let _tierCache: { userId: string; tier: UserPlanDb; at: number } | null = null;
let _subDetailCache: {
  email: string;
  status: string | null;
  endsAt: string | null;
  at: number;
} | null = null;

/** Drop cached plan state (on sign-out, realtime plan change, or forced refresh). */
export function invalidatePlanCaches(opts: { keepRow?: boolean } = {}): void {
  _tierCache = null;
  _subDetailCache = null;
  // keepRow: the caller has JUST read the row fresh (the plan refresh), so
  // dropping it would only make the next reader fetch the same thing again.
  if (!opts.keepRow) invalidateUserRow();
}

/**
 * Subscription status/end-date for the account, TTL-cached so repeated
 * `auth:get-plan-info` calls (app mount, OAuth success, UI refreshes) don't each
 * hit Supabase. The realtime plan-change subscription invalidates on change.
 */
export async function getSubscriptionDetails(
  email: string,
): Promise<{ status: string | null; endsAt: string | null }> {
  const c = _subDetailCache;
  if (c && c.email === email && Date.now() - c.at < EFFECTIVE_TIER_TTL_MS) {
    return { status: c.status, endsAt: c.endsAt };
  }
  try {
    const shared = await readUserRow({ email });
    const data =
      shared !== undefined
        ? shared
        : (
            await getSupabaseClient()
              .from("users")
              .select("subscription_status, subscription_ends_at")
              .eq("email", email)
              .single()
          ).data;
    const status = (data?.subscription_status as string | null) ?? null;
    const endsAt = (data?.subscription_ends_at as string | null) ?? null;
    _subDetailCache = { email, status, endsAt, at: Date.now() };
    return { status, endsAt };
  } catch (err) {
    logger.warn("[Supabase] getSubscriptionDetails error:", err);
    return { status: null, endsAt: null };
  }
}

/**
 * Effective tier from the user's own plan row. Equals the entitled plan now that
 * the Team tier is removed (kept as a function for API compatibility + caching).
 */
export async function getEffectiveTier(
  userId: string,
  ownPlan?: UserPlanDb,
): Promise<UserPlanDb> {
  const cached = _tierCache;
  if (
    cached &&
    cached.userId === userId &&
    Date.now() - cached.at < EFFECTIVE_TIER_TTL_MS
  ) {
    return cached.tier;
  }
  // The effective tier equals the entitled plan (Team tier removed). When the
  // caller already fetched + computed it (updateSession passes getUserPlan's
  // result as ownPlan), trust and cache it — avoids a SECOND read of the same
  // `users` row per auth event. Callers without ownPlan still fetch below.
  if (ownPlan) {
    _tierCache = { userId, tier: ownPlan, at: Date.now() };
    return ownPlan;
  }
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await fetchPlanRowForUser(supabase, userId);
    const tier: UserPlanDb =
      error || !data ? ownPlan || "free" : computeEntitledPlan(data);
    _tierCache = { userId, tier, at: Date.now() };
    return tier;
  } catch (err) {
    logger.warn("[Supabase] getEffectiveTier exception:", err);
    return ownPlan || offlinePlanOr("free", userId);
  }
}

/**
 * Listen for auth state changes
 */
export function onAuthStateChange(
  callback: (session: Session | null, event: string) => void,
): () => void {
  const supabase = getSupabaseClient();

  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((event, session) => {
    callback(session, event);
  });

  return () => subscription.unsubscribe();
}

// ============================================
// REALTIME SUBSCRIPTION FOR PLAN CHANGES
// ============================================

export interface SubscriptionData {
  plan: "free" | "pro";
  subscriptionStatus: "active" | "cancelled" | null;
  subscriptionEndsAt: string | null;
  effectiveTier?: "free" | "pro";
  /**
   * True when this account is banned.
   *
   * Carried on the realtime channel, which is what makes a ban take effect on a
   * SIGNED-IN client rather than only at the next sign-in — a ban that waits for
   * a re-login is not a ban. The reason is never included.
   */
  banned?: boolean;
}

/**
 * Read the plan row for an email, ONCE.
 *
 * WHY THIS REPLACED A REALTIME SUBSCRIPTION. The always-open plan-change channel cost
 * 93.5% of this project's total database execution time — 7.3M `realtime.list_changes`
 * calls polling the WAL — to deliver an event most accounts never fire. Measured
 * 2026-08-27 with `supabase inspect db calls`.
 *
 * The flow it existed for argues against it: a plan change happens in a BROWSER, on
 * atlarix.dev or Lemon Squeezy, so the user necessarily leaves the app and comes back.
 * A read on window focus catches that at least as well as a socket, and costs one query
 * per focus instead of a poller that never sleeps.
 *
 * The ban case is not weakened in the way it looks. A ban is enforced SERVER-SIDE on
 * every request (`entitlement.ts` maps `account_banned` to a hard stop), so the channel
 * was only ever updating the UI faster — it was never what stopped a banned account
 * spending.
 */
export async function fetchPlanSnapshot(
  userEmail: string,
  fresh = true,
): Promise<SubscriptionData | null> {
  try {
    // Fresh by default: this read's job is to NOTICE a change (focus), so it
    // does not answer from the shared row — but it refreshes it for the
    // others. Right after a sign-in read, `fresh: false` reuses that read.
    const shared = await readUserRow({ email: userEmail }, fresh);
    const { data, error } =
      shared !== undefined
        ? { data: shared, error: null }
        : await getSupabaseClient()
            .from("users")
            .select("plan, subscription_status, subscription_ends_at, effective_tier, banned_at")
            .eq("email", userEmail)
            .maybeSingle();
    if (error || !data) return null;
    const row = data as {
      plan?: string | null;
      subscription_status?: string | null;
      subscription_ends_at?: string | null;
      effective_tier?: string | null;
      banned_at?: string | null;
    };
    return {
      plan: (row.plan as "free" | "pro") ?? "free",
      subscriptionStatus:
        (row.subscription_status as "active" | "cancelled" | null) ?? null,
      subscriptionEndsAt: row.subscription_ends_at ?? null,
      effectiveTier: (row.effective_tier as "free" | "pro") || undefined,
      banned: Boolean(row.banned_at),
    };
  } catch {
    // Never throws. A failed read means "no news", and the 30-minute TTL on
    // `_tierCache` still bounds how stale the cached answer can get.
    return null;
  }
}
