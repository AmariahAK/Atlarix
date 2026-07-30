/**
 * Supabase Client - Auth & User Data
 * ==================================
 * Central Supabase client for authentication and user management.
 * All user data (diagrams, prompts) stays LOCAL in SQLite.
 * Supabase only stores: user_id, email, plan, lemon_customer_id
 * 
 * Created: v1.0.0 (2026-01-14)
 */

import { createClient, SupabaseClient, Session, User, SupportedStorage } from '@supabase/supabase-js';
import log from 'electron-log';
import { clipboard, dialog, shell } from 'electron';
import { createSecureSupabaseStorage, clearSupabaseSecureStorage } from './supabase-secure-storage';
import { resolveOfflineEntitlement } from './offline-entitlement';

const logger = log.scope('supabase');

// ============================================
// CONFIGURATION
// ============================================

// Deep link protocol for OAuth callback
export const DEEP_LINK_PROTOCOL = 'atlarix';
export const AUTH_CALLBACK_PATH = '/auth/callback';
export const AUTH_CALLBACK_URL = `${DEEP_LINK_PROTOCOL}://${AUTH_CALLBACK_PATH}`;

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
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ||
            process.env.SUPABASE_URL;
        // Publishable key is the current Supabase API-key system; the legacy anon
        // JWT is kept only as a fallback for older local .env files.
        const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ||
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

        if (!supabaseUrl || !supabaseAnonKey) {
            logger.warn('[Supabase] Missing credentials - set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY in .env or CI');
            throw new Error('Supabase URL and anon key are required. Add them to .env (see .env.example).');
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
            // Idle-chatter reduction: the always-open plan-change realtime channel
            // is the dominant background pinger. Halve its keepalive (default 25s →
            // 60s); it's ALSO closed on window-idle (SubscriptionManager.pauseRealtime).
            realtime: {
                heartbeatIntervalMs: 60_000,
            },
        });

        logger.log('[Supabase] Client initialized with secure storage');
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
        logger.log('[Supabase] OAuth inbound timeout cancelled — deep link received');
    }
}

export type OAuthProvider = 'google' | 'github' | 'discord';

/**
 * Start OAuth flow - opens browser for authentication
 * User will be redirected back to atlarix://auth/callback
 */
export async function signInWithOAuth(provider: OAuthProvider): Promise<{ error: Error | null }> {
    let supabase: SupabaseClient;
    try {
        supabase = getSupabaseClient();
    } catch (err) {
        logger.warn('[Supabase] Cannot sign in: missing or invalid Supabase config.', err instanceof Error ? err.message : String(err));
        return { error: new Error('Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY to .env (see .env.example).') };
    }
    try {
        logger.log(`[Supabase] Starting OAuth with ${provider}`);

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
            // C4: record that THIS app started a sign-in flow, so an unsolicited
            // auth callback (no flow pending) is rejected in handleAuthCallback.
            markAuthFlowStarted();
            // Open the OAuth URL in the user's default browser
            logger.log(`[Supabase] Opening OAuth URL in browser`);
            let browserOpened = false;
            try {
                await shell.openExternal(data.url);
                browserOpened = true;
                logger.log('[Supabase] shell.openExternal succeeded');
            } catch (openErr) {
                logger.error('[Supabase] shell.openExternal failed:', openErr);
            }

            // Inbound deep-link timeout: if atlarix://auth/callback is not received within
            // 60 seconds (e.g. deep link handler not registered on Linux / VM environments),
            // show a fallback dialog so the user can copy the OAuth URL manually.
            if (browserOpened) {
                const oauthUrlForFallback = data.url;
                _oauthTimeoutHandle = setTimeout(async () => {
                    _oauthTimeoutHandle = null;
                    logger.warn('[Supabase] OAuth inbound timeout — deep link not received after 60s');
                    const linuxCommands = process.platform === 'linux'
                        ? '\n\nTo register the deep link handler on Linux, run in Terminal:\n  xdg-mime default atlarix.desktop x-scheme-handler/atlarix\n  update-desktop-database ~/.local/share/applications\n\nThen try signing in again.'
                        : '';
                    const { response } = await dialog.showMessageBox({
                        type: 'info',
                        title: 'Sign-in not completing?',
                        message: 'Atlarix has been waiting 60 seconds for the OAuth callback.\n\nThe deep link handler may not be registered on your system.',
                        detail: `OAuth URL (open this in your browser if the redirect didn't work):\n${oauthUrlForFallback}${linuxCommands}`,
                        buttons: ['Copy Link', 'Dismiss'],
                        defaultId: 0,
                        cancelId: 1,
                    });
                    if (response === 0) {
                        clipboard.writeText(oauthUrlForFallback);
                        logger.log('[Supabase] OAuth URL copied via 60s inbound timeout fallback');
                    }
                }, 60_000);
            }

            // Linux/AppImage fallback: allow the user to copy the URL manually if browser launch fails.
            if (!browserOpened && process.platform === 'linux') {
                logger.warn('[Supabase] Browser open failed on Linux — showing fallback dialog');
                const { response } = await dialog.showMessageBox({
                    type: 'info',
                    title: 'Open this link to sign in',
                    message: 'Atlarix could not open your browser automatically.\n\nCopy the link below and paste it into your browser:',
                    detail: data.url,
                    buttons: ['Copy Link', 'Cancel'],
                    defaultId: 0,
                    cancelId: 1,
                });
                if (response === 0) {
                    clipboard.writeText(data.url);
                    logger.log('[Supabase] OAuth URL copied to clipboard via fallback dialog');
                }
            }
        }

        return { error: null };
    } catch (err) {
        logger.error(`[Supabase] OAuth exception:`, err);
        return { error: err instanceof Error ? err : new Error('Unknown error') };
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
            logger.warn('[Supabase] Rejected auth callback — no sign-in flow was in progress (possible CSRF).');
            return {
                session: null,
                user: null,
                error: new Error(
                    'Unexpected sign-in link. No sign-in was in progress on this device — if you did not just start signing in, you can ignore this.',
                ),
            };
        }

        // Parse the URL to extract tokens
        const urlObj = new URL(url);
        const hashParams = new URLSearchParams(urlObj.hash.substring(1));
        const accessToken = hashParams.get('access_token');
        const refreshToken = hashParams.get('refresh_token');

        if (!accessToken) {
            // Check for error in callback
            const error = hashParams.get('error');
            const errorDescription = hashParams.get('error_description');
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
                error: new Error('No access token in callback'),
            };
        }

        // Set the session with the tokens
        const { data, error } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken || '',
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
            logger.warn('[Supabase] Provider returned no email — refusing the session.');
            try {
                await supabase.auth.signOut();
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
            error: err instanceof Error ? err : new Error('Unknown error'),
        };
    }
}

/**
 * Get current session
 */
export async function getSession(): Promise<Session | null> {
    try {
        const supabase = getSupabaseClient();
        const { data: { session } } = await supabase.auth.getSession();
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
        const { data: { user } } = await supabase.auth.getUser();
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
        await supabase.auth.signOut();
        await clearSupabaseSecureStorage();
        logger.log('[Supabase] Signed out');
    } catch (err) {
        logger.error('[Supabase] Sign out error:', err);
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
            logger.log('[Supabase] No stored session on startup');
            return;
        }

        // Surface the account before spending anything on the network. A throw here
        // must not cost us the refresh below, so it's caught separately.
        try {
            await opts?.onStoredSession?.(session);
        } catch (cbErr) {
            logger.warn(
                '[Supabase] onStoredSession callback failed (non-fatal):',
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
                logger.log('[Supabase] Session refreshed on startup');
                return;
            }
            logger.warn(
                `[Supabase] Startup refresh attempt ${attempt + 1}/${delaysMs.length} failed:`,
                error?.message ?? 'no session returned',
            );
        }
        logger.warn(
            '[Supabase] Startup refresh exhausted — keeping the stored session; autoRefreshToken will retry.',
        );
    } catch (err) {
        logger.warn('[Supabase] restoreAuthSessionOnStartup skipped:', err instanceof Error ? err.message : err);
    }
}

// ============================================
// USER DATA METHODS
// ============================================

export interface AtlarixUser {
    id: string;
    email: string;
    plan: 'free' | 'pro';
    lemonCustomerId: string | null;
    createdAt: string;
}

/**
 * Ensure user exists in our users table (create if not exists)
 */
async function ensureUserExists(user: User): Promise<void> {
    try {
        const supabase = getSupabaseClient();

        // Check if user exists
        const { data: existingUser } = await supabase
            .from('users')
            .select('id')
            .eq('id', user.id)
            .single();

        if (!existingUser) {
            // Create user record (onboarding_completed false for new users)
            const { error } = await supabase
                .from('users')
                .insert({
                    id: user.id,
                    email: user.email,
                    plan: 'free',
                    onboarding_completed: false,
                });

            if (error) {
                logger.error('[Supabase] Failed to create user:', error);
            } else {
                logger.log(`[Supabase] Created user record for ${user.email}`);
            }
        }
    } catch (err) {
        logger.error('[Supabase] ensureUserExists error:', err);
    }
}

export type UserPlanDb = 'free' | 'pro';

type PlanRowInput = {
    plan: string;
    effective_tier?: string | null;
    subscription_ends_at?: string | null;
    subscription_status?: string | null;
    lemon_subscription_id?: string | null;
    lemon_variant_id?: string | null;
};


/**
 * When plan/effective_tier are still "free" but LemonSqueezy rows show a paid period,
 * infer Pro so the app matches billing (webhook may have updated status only).
 * For active/on_trial we do not require subscription_ends_at (renewal date is often null in DB).
 */
function inferPaidTierWhenStoredFree(row: PlanRowInput): UserPlanDb | null {
    const plan = (row.plan as UserPlanDb) || 'free';
    const eff = (row.effective_tier as UserPlanDb) || plan;
    if (plan !== 'free' || eff !== 'free') return null;
    if (!row.lemon_subscription_id) return null;
    const st = (row.subscription_status || '').toLowerCase();
    const paidish = ['active', 'on_trial', 'cancelled', 'paused', 'past_due'].includes(st);
    if (!paidish) return null;

    if (st === 'active' || st === 'on_trial') {
        return 'pro';
    }

    const endsMs = row.subscription_ends_at ? new Date(row.subscription_ends_at).getTime() : 0;
    if (!endsMs || Number.isNaN(endsMs) || Date.now() >= endsMs) return null;
    return 'pro';
}

/** Paid access: trust active/on_trial; otherwise use subscription_ends_at vs now. */
function computeEntitledPlan(row: PlanRowInput): UserPlanDb {
    const st = (row.subscription_status || '').toLowerCase();
    const activelyBilled = st === 'active' || st === 'on_trial';

    const inferred = inferPaidTierWhenStoredFree(row);
    if (inferred) {
        if (!activelyBilled) {
            const ends = row.subscription_ends_at ? new Date(row.subscription_ends_at).getTime() : 0;
            if (ends && Date.now() > ends) return 'free';
        }
        return inferred;
    }

    const plan = (row.plan as UserPlanDb) || 'free';
    const eff = (row.effective_tier as UserPlanDb) || plan;
    const tier: UserPlanDb = eff === 'pro' ? eff : plan;
    if (tier === 'free') return 'free';
    const ends = row.subscription_ends_at ? new Date(row.subscription_ends_at).getTime() : 0;
    if (!activelyBilled && ends && Date.now() > ends) return 'free';
    return tier;
}

const PLAN_ROW_SELECT_BASE =
    'plan, effective_tier, subscription_ends_at, subscription_status, lemon_subscription_id';
const PLAN_ROW_SELECT_WITH_VARIANT = `${PLAN_ROW_SELECT_BASE}, lemon_variant_id`;

async function fetchPlanRowForUser(
    supabase: ReturnType<typeof getSupabaseClient>,
    userId: string,
): Promise<{ data: PlanRowInput | null; error: Error | null }> {
    let data: PlanRowInput | null = null;
    let error: unknown = null;
    {
        const r1 = await supabase
            .from('users')
            .select(PLAN_ROW_SELECT_WITH_VARIANT)
            .eq('id', userId)
            .maybeSingle();
        data = r1.data as PlanRowInput | null;
        error = r1.error;
    }

    if (error) {
        const r2 = await supabase
            .from('users')
            .select(PLAN_ROW_SELECT_BASE)
            .eq('id', userId)
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
            logger.warn('[Supabase] getUserPlan error:', error.message);
            return offlinePlanOr('free', userId);
        }
        // A reachable server with no row genuinely means no entitlement — do NOT
        // fall back to the cache here, only when the request itself failed.
        if (!data) return 'free';
        return computeEntitledPlan(data);
    } catch (err) {
        logger.warn('[Supabase] getUserPlan exception:', err);
        return offlinePlanOr('free', userId);
    }
}

/**
 * Server unreachable → honour the last plan the server confirmed, if it hasn't
 * expired. Always the fallback, never the first choice: a reachable server wins.
 */
function offlinePlanOr(fallback: UserPlanDb, userId: string): UserPlanDb {
    try {
        const { readSettings } = requireSettings();
        const cached = resolveOfflineEntitlement(readSettings().lastKnownEntitlement, userId);
        if (cached) {
            logger.log(`[Supabase] offline — honouring last known plan: ${cached.plan}`);
            return cached.plan;
        }
    } catch {
        /* settings unavailable (wrong process) — fall through */
    }
    return fallback;
}

/** Lazy require so this module stays importable from the renderer stub path. */
function requireSettings(): { readSettings: () => import('@/lib/schemas').UserSettings } {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@/main/settings');
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
let _subDetailCache:
    | { email: string; status: string | null; endsAt: string | null; at: number }
    | null = null;

/** Drop cached plan state (on sign-out, realtime plan change, or forced refresh). */
export function invalidatePlanCaches(): void {
    _tierCache = null;
    _subDetailCache = null;
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
        const supabase = getSupabaseClient();
        const { data } = await supabase
            .from('users')
            .select('subscription_status, subscription_ends_at')
            .eq('email', email)
            .single();
        const status = (data?.subscription_status as string | null) ?? null;
        const endsAt = (data?.subscription_ends_at as string | null) ?? null;
        _subDetailCache = { email, status, endsAt, at: Date.now() };
        return { status, endsAt };
    } catch (err) {
        logger.warn('[Supabase] getSubscriptionDetails error:', err);
        return { status: null, endsAt: null };
    }
}

/**
 * Effective tier from the user's own plan row. Equals the entitled plan now that
 * the Team tier is removed (kept as a function for API compatibility + caching).
 */
export async function getEffectiveTier(userId: string, ownPlan?: UserPlanDb): Promise<UserPlanDb> {
    const cached = _tierCache;
    if (cached && cached.userId === userId && Date.now() - cached.at < EFFECTIVE_TIER_TTL_MS) {
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
        const tier: UserPlanDb = error || !data ? (ownPlan || 'free') : computeEntitledPlan(data);
        _tierCache = { userId, tier, at: Date.now() };
        return tier;
    } catch (err) {
        logger.warn('[Supabase] getEffectiveTier exception:', err);
        return ownPlan || offlinePlanOr('free', userId);
    }
}

/**
 * Get onboarding completed flag for a user (for first-run guided flow).
 * Returns false if no row or column missing.
 */
export async function getOnboardingCompleted(userId: string): Promise<boolean> {
    try {
        const supabase = getSupabaseClient();
        const { data, error } = await supabase
            .from('users')
            .select('onboarding_completed')
            .eq('id', userId)
            .maybeSingle();

        if (error) {
            logger.warn('[Supabase] getOnboardingCompleted error:', error.message);
            return false;
        }
        return data?.onboarding_completed === true;
    } catch (err) {
        logger.warn('[Supabase] getOnboardingCompleted exception:', err);
        return false;
    }
}

/**
 * Set onboarding completed for a user.
 */
export async function setOnboardingCompleted(userId: string, value: boolean): Promise<void> {
    try {
        const supabase = getSupabaseClient();
        const { error } = await supabase
            .from('users')
            .update({ onboarding_completed: value })
            .eq('id', userId);

        if (error) {
            logger.error('[Supabase] setOnboardingCompleted error:', error.message);
        } else {
            logger.log('[Supabase] onboarding_completed set to', value, 'for user', userId);
        }
    } catch (err) {
        logger.error('[Supabase] setOnboardingCompleted exception:', err);
    }
}

/**
 * Listen for auth state changes
 */
export function onAuthStateChange(
    callback: (session: Session | null, event: string) => void,
): () => void {
    const supabase = getSupabaseClient();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
        callback(session, event);
    });

    return () => subscription.unsubscribe();
}

// ============================================
// REALTIME SUBSCRIPTION FOR PLAN CHANGES
// ============================================

export interface SubscriptionData {
    plan: 'free' | 'pro';
    subscriptionStatus: 'active' | 'cancelled' | null;
    subscriptionEndsAt: string | null;
    effectiveTier?: 'free' | 'pro';
}

type SubscriptionChangeCallback = (newData: SubscriptionData, oldData: SubscriptionData) => void;
let planSubscription: any = null;

/**
 * Subscribe to realtime subscription changes for the current user
 * Called after user logs in to detect Pro upgrades AND cancellations
 */
export function subscribeToPlanChanges(userEmail: string, callback: SubscriptionChangeCallback): () => void {
    const supabase = getSupabaseClient();

    // Unsubscribe from any existing subscription
    if (planSubscription) {
        supabase.removeChannel(planSubscription);
    }

    const channelId = `user-plan-${Buffer.from(userEmail, "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
        .slice(0, 48)}`;
    logger.log(`[Supabase] Setting up realtime subscription for plan changes (${channelId})`);

    planSubscription = supabase
        .channel(channelId)
        .on(
            'postgres_changes',
            {
                event: 'UPDATE',
                schema: 'public',
                table: 'users',
                filter: `email=eq.${userEmail}`,
            },
            (payload) => {
                const newRow = payload.new as { plan: string; subscription_status: string | null; subscription_ends_at: string | null; effective_tier?: string };
                const oldRow = payload.old as { plan: string; subscription_status: string | null; subscription_ends_at: string | null; effective_tier?: string };

                const newData: SubscriptionData = {
                    plan: (newRow?.plan || 'free') as 'free' | 'pro',
                    subscriptionStatus: (newRow?.subscription_status || null) as 'active' | 'cancelled' | null,
                    subscriptionEndsAt: newRow?.subscription_ends_at || null,
                    effectiveTier: (newRow?.effective_tier as 'free' | 'pro') || undefined,
                };

                const oldData: SubscriptionData = {
                    plan: (oldRow?.plan || 'free') as 'free' | 'pro',
                    subscriptionStatus: (oldRow?.subscription_status || null) as 'active' | 'cancelled' | null,
                    subscriptionEndsAt: oldRow?.subscription_ends_at || null,
                    effectiveTier: (oldRow?.effective_tier as 'free' | 'pro') || undefined,
                };

                const materialChange =
                    newData.plan !== oldData.plan ||
                    newData.subscriptionStatus !== oldData.subscriptionStatus ||
                    newData.subscriptionEndsAt !== oldData.subscriptionEndsAt ||
                    newData.effectiveTier !== oldData.effectiveTier;

                if (materialChange) {
                    logger.log(`[Supabase] Realtime subscription update:`, {
                        plan: `${oldData.plan} → ${newData.plan}`,
                        status: `${oldData.subscriptionStatus} → ${newData.subscriptionStatus}`,
                        endsAt: newData.subscriptionEndsAt,
                    });
                    callback(newData, oldData);
                }
            }
        )
        .subscribe((status) => {
            logger.log(`[Supabase] Realtime subscription status: ${status}`);
        });

    return () => {
        if (planSubscription) {
            supabase.removeChannel(planSubscription);
            planSubscription = null;
            logger.log('[Supabase] Unsubscribed from plan changes');
        }
    };
}
