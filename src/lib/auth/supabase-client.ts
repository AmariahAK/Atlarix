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
import { shell, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const logger = log.scope('supabase');

// ============================================
// CONFIGURATION
// ============================================

// Deep link protocol for OAuth callback
export const DEEP_LINK_PROTOCOL = 'atlarix';
export const AUTH_CALLBACK_PATH = '/auth/callback';
export const AUTH_CALLBACK_URL = `${DEEP_LINK_PROTOCOL}://${AUTH_CALLBACK_PATH}`;

// ============================================
// FILE-BASED SESSION STORAGE
// ============================================

/**
 * Custom storage that persists to disk for Electron
 * Supabase's default localStorage doesn't persist in Electron
 */
function createFileStorage(): SupportedStorage {
    const storagePath = path.join(app.getPath('userData'), 'supabase-auth.json');
    let cache: Record<string, string> = {};

    // Load existing data on startup
    try {
        if (fs.existsSync(storagePath)) {
            const data = fs.readFileSync(storagePath, 'utf8');
            cache = JSON.parse(data);
            logger.log('[Supabase] Loaded session from disk');
        }
    } catch (error) {
        logger.warn('[Supabase] Failed to load session from disk:', error);
        cache = {};
    }

    const save = () => {
        try {
            fs.writeFileSync(storagePath, JSON.stringify(cache), 'utf8');
        } catch (error) {
            logger.error('[Supabase] Failed to save session to disk:', error);
        }
    };

    return {
        getItem: (key: string) => {
            return cache[key] || null;
        },
        setItem: (key: string, value: string) => {
            cache[key] = value;
            save();
        },
        removeItem: (key: string) => {
            delete cache[key];
            save();
        },
    };
}

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

        // Create file-based storage for Electron
        fileStorage = createFileStorage();

        supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
            auth: {
                // Use file-based storage for Electron session persistence
                storage: fileStorage,
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: false, // We handle deep links manually
            },
        });

        logger.log('[Supabase] Client initialized with file-based storage');
    }

    return supabaseClient;
}

// ============================================
// OAUTH METHODS
// ============================================

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
            await shell.openExternal(data.url);
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
        logger.log('[Supabase] Signed out');
    } catch (err) {
        logger.error('[Supabase] Sign out error:', err);
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

/**
 * Get user's plan from database (with timeout to prevent hanging)
 */
export async function getUserPlan(userId: string): Promise<UserPlanDb> {
    const timeoutPromise = new Promise<UserPlanDb>((resolve) => {
        setTimeout(() => {
            logger.warn('[Supabase] getUserPlan timed out, defaulting to free');
            resolve('free');
        }, 5000);
    });

    const fetchPromise = (async (): Promise<UserPlanDb> => {
        try {
            const supabase = getSupabaseClient();
            const { data, error } = await supabase
                .from('users')
                .select('plan')
                .eq('id', userId)
                .maybeSingle();

            if (error) {
                logger.warn('[Supabase] getUserPlan error:', error.message);
                return 'free';
            }
            if (!data) return 'free';
            return (data.plan as UserPlanDb) || 'free';
        } catch (err) {
            logger.warn('[Supabase] getUserPlan exception:', err);
            return 'free';
        }
    })();

    return Promise.race([fetchPromise, timeoutPromise]);
}

/**
 * v4.0: Get effective tier (max of own plan or team plan)
 */
export async function getEffectiveTier(userId: string, ownPlan?: UserPlanDb): Promise<UserPlanDb> {
    try {
        const supabase = getSupabaseClient();
        const { data, error } = await supabase
            .from('users')
            .select('effective_tier, plan')
            .eq('id', userId)
            .maybeSingle();

        if (error || !data) return ownPlan || 'free';
        const effective = (data.effective_tier as UserPlanDb) || data.plan || ownPlan || 'free';
        const plan = (data.plan as UserPlanDb) || ownPlan || 'free';
        return effective || plan;
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

    logger.log(`[Supabase] Setting up realtime subscription for plan changes: ${userEmail}`);

    planSubscription = supabase
        .channel('user-plan-changes')
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

                logger.log(`[Supabase] Realtime subscription update:`, {
                    plan: `${oldData.plan} → ${newData.plan}`,
                    status: `${oldData.subscriptionStatus} → ${newData.subscriptionStatus}`,
                    endsAt: newData.subscriptionEndsAt,
                });

                // Fire callback on ANY relevant change (plan, status, date, or effective tier)
                if (
                    newData.plan !== oldData.plan ||
                    newData.subscriptionStatus !== oldData.subscriptionStatus ||
                    newData.subscriptionEndsAt !== oldData.subscriptionEndsAt ||
                    newData.effectiveTier !== oldData.effectiveTier
                ) {
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
