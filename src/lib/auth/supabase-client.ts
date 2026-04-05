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
 * Get or create Supabase client instance
 * Reads env vars at runtime (after dotenv.config is called in main.ts)
 * Falls back to embedded defaults for production builds where .env isn't bundled
 */
export function getSupabaseClient(): SupabaseClient {
    if (!supabaseClient) {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ||
            process.env.SUPABASE_URL;
        const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
            process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;

        if (!supabaseUrl || !supabaseAnonKey) {
            logger.warn('[Supabase] Missing credentials - set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env or CI');
            throw new Error('Supabase URL and anon key are required. Add them to .env (see .env.example).');
        }

        // Keychain / safeStorage-backed session persistence (see supabase-secure-storage.ts)
        fileStorage = createSecureSupabaseStorage();

        supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
            auth: {
                storage: fileStorage,
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: false, // We handle deep links manually
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

export type OAuthProvider = 'google' | 'github';

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
        return { error: new Error('Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to .env (see .env.example).') };
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

        logger.log(`[Supabase] Session set successfully for ${data.user?.email}`);

        // Ensure user exists in our users table
        if (data.user) {
            await ensureUserExists(data.user);
        }

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
 */
export async function restoreAuthSessionOnStartup(): Promise<void> {
    try {
        const supabase = getSupabaseClient();
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            logger.log('[Supabase] No stored session on startup');
            return;
        }
        const exp = session.expires_at;
        if (exp) {
            const expiresMs = exp * 1000;
            const skewMs = 120_000;
            if (expiresMs < Date.now() + skewMs) {
                const { data, error } = await supabase.auth.refreshSession();
                if (error) {
                    logger.warn('[Supabase] Startup refresh failed (user may need to sign in again):', error.message);
                } else if (data.session) {
                    logger.log('[Supabase] Session refreshed on startup');
                }
            }
        }
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

export type UserPlanDb = 'free' | 'pro' | 'workforce';

type PlanRowInput = {
    plan: string;
    effective_tier?: string | null;
    subscription_ends_at?: string | null;
    subscription_status?: string | null;
    lemon_subscription_id?: string | null;
    lemon_variant_id?: string | null;
};

function trimEnv(key: string): string {
    const v = process.env[key];
    return typeof v === 'string' ? v.trim() : '';
}

/**
 * When plan/effective_tier are still "free" but LemonSqueezy rows show a paid period,
 * infer Pro or Workforce so the app matches billing (webhook may have updated status only).
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

    const wf = trimEnv('LEMONSQUEEZY_WORKFORCE_VARIANT_ID');
    const tierFromVariant =
        row.lemon_variant_id && wf && row.lemon_variant_id === wf ? ('workforce' as const) : ('pro' as const);

    if (st === 'active' || st === 'on_trial') {
        return tierFromVariant;
    }

    const endsMs = row.subscription_ends_at ? new Date(row.subscription_ends_at).getTime() : 0;
    if (!endsMs || Number.isNaN(endsMs) || Date.now() >= endsMs) return null;
    return tierFromVariant;
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
    const tier: UserPlanDb = eff === 'workforce' || eff === 'pro' ? eff : plan;
    if (tier === 'free') return 'free';
    const ends = row.subscription_ends_at ? new Date(row.subscription_ends_at).getTime() : 0;
    if (!activelyBilled && ends && Date.now() > ends) return 'free';
    return tier;
}

const PLAN_ROW_SELECT_BASE =
    'plan, effective_tier, subscription_ends_at, subscription_status, lemon_subscription_id';
const PLAN_ROW_SELECT_WITH_VARIANT = `${PLAN_ROW_SELECT_BASE}, lemon_variant_id`;

const TIER_RANK: Record<UserPlanDb, number> = { free: 0, pro: 1, workforce: 2 };

function maxUserPlan(a: UserPlanDb, b: UserPlanDb): UserPlanDb {
    return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/**
 * If the user is an active member of someone else's team, inherit the team owner's entitled tier
 * (e.g. Workforce subscriber's members get workforce) even when users.effective_tier was not updated.
 */
async function tierFromActiveTeamMembership(
    supabase: ReturnType<typeof getSupabaseClient>,
    userId: string,
): Promise<UserPlanDb | null> {
    const { data: memberRow, error: mErr } = await supabase
        .from("team_members")
        .select("team_id")
        .eq("user_id", userId)
        .eq("status", "active")
        .maybeSingle();
    if (mErr || !memberRow?.team_id) return null;

    const { data: team, error: tErr } = await supabase
        .from("teams")
        .select("owner_user_id, active")
        .eq("id", memberRow.team_id)
        .maybeSingle();
    if (tErr || !team?.active || !team.owner_user_id) return null;
    if (team.owner_user_id === userId) return null;

    const { data: ownerData, error: oErr } = await fetchPlanRowForUser(supabase, team.owner_user_id);
    if (oErr || !ownerData) return null;
    const ownerTier = computeEntitledPlan(ownerData);
    if (ownerTier === "free") return null;
    return ownerTier;
}

async function fetchPlanRowForUser(
    supabase: ReturnType<typeof getSupabaseClient>,
    userId: string,
): Promise<{ data: PlanRowInput | null; error: Error | null }> {
    let data: PlanRowInput | null = null;
    let { data: row1, error } = await supabase
        .from('users')
        .select(PLAN_ROW_SELECT_WITH_VARIANT)
        .eq('id', userId)
        .maybeSingle();

    data = row1 as PlanRowInput | null;

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
            return 'free';
        }
        if (!data) return 'free';
        return computeEntitledPlan(data);
    } catch (err) {
        logger.warn('[Supabase] getUserPlan exception:', err);
        return 'free';
    }
}

/**
 * v4.0: Get effective tier (max of own plan, users row, or active team owner's plan).
 */
export async function getEffectiveTier(userId: string, ownPlan?: UserPlanDb): Promise<UserPlanDb> {
    try {
        const supabase = getSupabaseClient();
        const { data, error } = await fetchPlanRowForUser(supabase, userId);

        if (error || !data) {
            const fallback = ownPlan || 'free';
            const fromTeam = await tierFromActiveTeamMembership(supabase, userId);
            return fromTeam ? maxUserPlan(fallback, fromTeam) : fallback;
        }
        let tier = computeEntitledPlan(data);
        const fromTeam = await tierFromActiveTeamMembership(supabase, userId);
        if (fromTeam) {
            tier = maxUserPlan(tier, fromTeam);
        }
        return tier;
    } catch (err) {
        logger.warn('[Supabase] getEffectiveTier exception:', err);
        return ownPlan || 'free';
    }
}

/**
 * v4.0: Whether user has grandfathered DB Studio (Pro before move to Workforce)
 */
export async function getHasDbStudioLegacy(userId: string): Promise<boolean> {
    try {
        const supabase = getSupabaseClient();
        const { data, error } = await supabase
            .from('users')
            .select('has_db_studio_legacy')
            .eq('id', userId)
            .maybeSingle();

        if (error || !data) return false;
        return data.has_db_studio_legacy === true;
    } catch (err) {
        logger.warn('[Supabase] getHasDbStudioLegacy exception:', err);
        return false;
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
export function onAuthStateChange(callback: (session: Session | null) => void): () => void {
    const supabase = getSupabaseClient();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
        callback(session);
    });

    return () => subscription.unsubscribe();
}

// ============================================
// REALTIME SUBSCRIPTION FOR PLAN CHANGES
// ============================================

export interface SubscriptionData {
    plan: 'free' | 'pro' | 'workforce';
    subscriptionStatus: 'active' | 'cancelled' | null;
    subscriptionEndsAt: string | null;
    effectiveTier?: 'free' | 'pro' | 'workforce';
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
                    plan: (newRow?.plan || 'free') as 'free' | 'pro' | 'workforce',
                    subscriptionStatus: (newRow?.subscription_status || null) as 'active' | 'cancelled' | null,
                    subscriptionEndsAt: newRow?.subscription_ends_at || null,
                    effectiveTier: (newRow?.effective_tier as 'free' | 'pro' | 'workforce') || undefined,
                };

                const oldData: SubscriptionData = {
                    plan: (oldRow?.plan || 'free') as 'free' | 'pro' | 'workforce',
                    subscriptionStatus: (oldRow?.subscription_status || null) as 'active' | 'cancelled' | null,
                    subscriptionEndsAt: oldRow?.subscription_ends_at || null,
                    effectiveTier: (oldRow?.effective_tier as 'free' | 'pro' | 'workforce') || undefined,
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
