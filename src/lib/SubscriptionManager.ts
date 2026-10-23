/**
 * SubscriptionManager - User Plan & Workspace Gating
 * ===================================================
 * Manages user authentication state and subscription limits.
 * Integrates with Supabase Auth for OAuth.
 *
 * Created: v1.0.0 (2026-01-14)
 */

import { db } from "../db";
import { apps } from "../db/schema";
import log from "electron-log";
import {
  getSession,
  getUserPlan,
  isUserBanned,
  getEffectiveTier,
  invalidatePlanCaches,
  signInWithOAuth,
  signOut,
  onAuthStateChange,
  handleAuthCallback,
  type SignInMethod,
  startEmailSignIn,
} from "./auth/supabase-client";
import type { Session } from "@supabase/supabase-js";
// Shared, guarded, and already covered by broadcast-all-windows.test.ts. Both
// broadcasts below used to hand-roll the same loop WITHOUT the destroyed-window
// guard — `win.webContents.send()` on a window whose webContents is already gone
// throws "Object has been destroyed", which is a fatal main-process crash, not a
// warning. Renderer-safe because this module is swapped for a stub there
// (vite/renderer-main-only-shims-plugin.ts).
import { broadcastToAllWindows } from "../ipc/utils/broadcast_all_windows";

const logger = log.scope("subscription");

/** How long a focus waits before reading the plan again (see refreshPlanFromServer). */
export const PLAN_FOCUS_REFRESH_MS = 10 * 60 * 1000;

/**
 * The account's MCP servers are read again on sign-in and sign-out (account-connectors.ts).
 * Lazy: that module pulls in the proxy client, which this one should not load at startup.
 */
function clearAccountConnectors(): void {
  void import("./mcp/account-connectors")
    .then((m) => m.clearAccountConnectorsCache())
    .catch(() => {
      /* non-fatal */
    });
}

// ============================================
// TYPES
// ============================================

export type UserPlan = "free" | "pro";

export interface UserSession {
  id: string;
  email: string;
  name?: string;
  avatar?: string;
  plan: UserPlan;
  /** Effective tier — always equals `plan` since the Team tier was removed. */
  effectiveTier?: UserPlan;
  /**
   * True when this account is banned. Scope: Atlarix Core + the account. The
   * user's own API keys and local models are NOT blocked, and the UI says so —
   * the app runs offline by design, so claiming otherwise would be a promise we
   * cannot keep. The hard stop is the proxy's 403.
   */
  banned?: boolean;
}

// ============================================
// CONFIGURATION
// ============================================

/** What `auth:resolved` carries. `user: null` means genuinely signed out. */
export type AuthResolvedPayload = {
  user: {
    id: string;
    email: string;
    name?: string;
    avatar?: string;
    plan: UserPlan;
    effectiveTier: UserPlan;
    /** Banned from Atlarix Core and the account. Never carries the reason. */
    banned?: boolean;
  } | null;
  plan: UserPlan;
};

/**
 * Shape the restore-settled announcement.
 *
 * Pure and exported so the interesting half — that a NULL session still produces
 * a payload — is testable without an Electron window. A null session returning
 * nothing at all is exactly what stranded the launch screen.
 */
export function buildAuthResolvedPayload(
  session: UserSession | null | undefined,
): AuthResolvedPayload {
  if (!session) return { user: null, plan: "free" };
  return {
    user: {
      id: session.id,
      email: session.email,
      name: session.name,
      avatar: session.avatar,
      plan: session.plan,
      effectiveTier: session.effectiveTier ?? session.plan,
      banned: session.banned ?? false,
    },
    plan: session.plan,
  };
}

// ============================================
// SUBSCRIPTION MANAGER
// ============================================

export class SubscriptionManager {
  /** Current cached session */
  private static session: UserSession | null = null;

  /** Cached workspace count */
  private static cachedWorkspaceCount: number | null = null;

  /** Auth state listener cleanup function */
  private static authCleanup: (() => void) | null = null;

  // ========================================
  // INITIALIZATION
  // ========================================

  private static initPromise: Promise<void> | null = null;

  /**
   * Initialize the subscription manager - call on app start (after restoreAuthSessionOnStartup).
   * Idempotent: concurrent callers share one initialization.
   */
  static async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      logger.log("[SubscriptionManager] Initializing...");

      const supabaseSession = await getSession();
      if (supabaseSession?.user) {
        await this.updateSession(supabaseSession);
      }

      if (this.authCleanup) {
        this.authCleanup();
        this.authCleanup = null;
      }
      this.authCleanup = onAuthStateChange(async (session, event) => {
        if (session) {
          // A routine hourly TOKEN_REFRESHED for the SAME already-loaded
          // user changes nothing about the plan — skip the users-table
          // re-reads it would otherwise trigger (a real plan change is
          // caught by the focus refresh). Only the token rotated, which
          // supabase-js manages internally.
          if (
            event === "TOKEN_REFRESHED" &&
            this.session?.id === session.user.id
          ) {
            return;
          }
          clearAccountConnectors();
          await this.updateSession(session);
        } else {
          this.session = null;
          invalidatePlanCaches();
          clearAccountConnectors();
          this.lastPlanFingerprint = "";
          this.lastPlanFingerprintAt = 0;
          // Drop the offline entitlement too — a signed-out machine must
          // not keep honouring the previous account's plan.
          void import("../main/settings")
            .then((m) => m.writeSettings({ lastKnownEntitlement: undefined }))
            .catch(() => {
              /* non-fatal */
            });
          // Stop attributing events to the signed-out user; fall back
          // to this install's anonymous id.
          void import("../main/lib/analytics")
            .then((m) => m.clearIdentifiedUser())
            .catch(() => {
              /* non-fatal */
            });
          void import("./analytics/account-context").then((m) => m.noteSignedOut()).catch(() => {});
          logger.log("[SubscriptionManager] User signed out");
        }
      });

      logger.log("[SubscriptionManager] Initialized");
    })();
    return this.initPromise;
  }

  /**
   * Update local session from Supabase session
   */
  private static async updateSession(supabaseSession: Session): Promise<void> {
    const user = supabaseSession.user;

    // Extract avatar from user_metadata (Google provides it as avatar_url or picture)
    const userMeta = user.user_metadata || {};
    const avatar = userMeta.avatar_url || userMeta.picture || undefined;
    const name =
      userMeta.full_name ||
      userMeta.name ||
      user.email?.split("@")[0] ||
      "User";

    // WHO the user is must not depend on resolving WHAT they're entitled to.
    // These two lookups sat above the `this.session` assignment, so a throw
    // from either (offline, a transient Supabase error) left the session null
    // — and `broadcastSessionState()` early-returns on a null session, so the
    // renderer never learned it was signed in. `getUserPlan` already degrades
    // to 'free'/last-known-entitlement internally rather than throwing; this
    // guard covers the rest so identity always survives.
    let plan: UserPlan = "free";
    let effectiveTier: UserPlan = "free";
    let banned = false;
    try {
      plan = await getUserPlan(user.id);
      effectiveTier = await getEffectiveTier(user.id, plan);
      // Same try block on purpose: identity must survive an entitlement
      // failure, and `isUserBanned` already fails open on its own errors.
      banned = await isUserBanned(user.id);
    } catch (err) {
      logger.warn(
        "[SubscriptionManager] Plan lookup failed — keeping the session, defaulting to free:",
        err instanceof Error ? err.message : err,
      );
    }

    this.session = {
      id: user.id,
      email: user.email || "",
      name,
      avatar,
      plan,
      effectiveTier,
      banned,
    };

    this.cachedWorkspaceCount = null; // Clear cache
    logger.log(
      `[SubscriptionManager] Session updated: ${user.email} (${plan})`,
      { avatar: !!avatar, name },
    );

    // Remember what the SERVER just confirmed, so a later launch without a
    // network doesn't silently downgrade a paying user to free. Written only
    // on this authoritative path; read only when a request fails.
    await this.persistEntitlement(
      user.id,
      plan,
      effectiveTier,
      user.email ?? undefined,
    );

    // Analytics identity. This MUST run before the tier event so the event
    // is attributed to the user rather than to this install's anonymous id.
    //
    // `user.id` (not the email) stays the identity KEY — emails change, and
    // keying on one would fork the person on every address change. Email and
    // name ride along as person PROPERTIES so accounts are recognisable in
    // the PostHog UI, and so internal accounts can be filtered there by
    // email rather than hardcoding addresses into a shipped binary.
    try {
      const { identifyUser, trackTier } = await import("../main/lib/analytics");
      identifyUser(user.id, {
        email: user.email,
        name,
        tier: effectiveTier,
        plan,
      });
      trackTier(effectiveTier);
    } catch {
      /* non-fatal */
    }
    // Crash reports' account id, and where this account signed in from.
    void import("./analytics/account-context").then((m) => m.noteSignedIn(user.id)).catch(() => {});

    // Subscribe to realtime plan changes for instant Pro activation
    if (user.email) {
      // Was: open a realtime channel. Now a single read on sign-in, with focus
      // refreshes after it — see refreshPlanFromServer for the measurement.
      // Not fresh: the plan was read a moment ago in this same update, and a
      // second read of the same row would only measure the network again.
      // Focus refreshes (main.ts) still always ask the server.
      await this.refreshPlanFromServer(0, false);
    }

    // Announce the resolved session to every window. Two reasons, and the
    // second is the non-obvious one:
    //
    //  1. Signing IN reached one window only. `oauth-callback-success` is sent
    //     to `mainWindow` alone (main.ts), so a second window stayed signed out
    //     — the exact mirror of the sign-out bug fixed above.
    //  2. `auth-ipc-bridge` REPLAYS the last `auth:resolved` to every
    //     late-mounting `useAuth`. Without this call that cache still holds the
    //     startup payload, so after a sign-in a lazily-rendered route would be
    //     replayed a stale `{ user: null }` — and now that the renderer clears
    //     on a null user, that would sign the component out. Keeping this
    //     channel current is what makes the clear safe.
    //
    // Last, deliberately: `refreshPlanFromServer` above may change the plan, and
    // the payload should carry the settled one. The startup path broadcasts
    // twice as a result (here and main.ts's `finally`) — same payload, and two
    // IPC messages rather than the twenty-two a re-check ping would cost.
    this.broadcastAuthResolved();
  }

  /**
   * Push the current session's plan to every window over the EXISTING
   * `plan-changed` channel.
   *
   * Needed because auth init now runs AFTER `createWindow()` (so the network
   * can never delay the window). The renderer therefore mounts signed-out and
   * has nothing to re-trigger on; this is what corrects it once the session
   * actually resolves. No-op when signed out — the renderer's initial
   * signed-out state is already right.
   */
  static broadcastSessionState(): void {
    const s = this.session;
    if (!s) return;
    this.broadcastPlanChanged({
      plan: s.plan,
      effectiveTier: s.effectiveTier ?? s.plan,
      previousPlan: undefined,
      subscriptionStatus: undefined,
      subscriptionEndsAt: undefined,
    });
  }

  /**
   * Announce that the startup session restore has SETTLED, whatever the answer.
   *
   * Deliberately separate from `broadcastSessionState()` above, which
   * early-returns when there is no session. That early return is correct for a
   * plan broadcast and was the bug for the renderer: a failed or empty restore
   * produced no message at all, so a renderer that had asked too early sat on
   * "Restoring your session…" forever with no sign-in button and no error.
   *
   * The payload carries the resolved state so the renderer can apply it
   * directly. `useAuth` is an unshared hook with ~22 consumers, each running
   * its own `checkSession()`; an event that made them all re-invoke would cost
   * 22 IPC round-trips per launch.
   */
  static broadcastAuthResolved(): void {
    // NOTE: no `if (!session) return` here, deliberately — that guard on
    // `broadcastSessionState` above is the whole bug being fixed.
    broadcastToAllWindows(
      "auth:resolved",
      buildAuthResolvedPayload(this.session),
    );
  }

  /** Single place that emits `plan-changed`, so the payload can't drift. */
  private static broadcastPlanChanged(payload: {
    plan: UserPlan;
    effectiveTier: UserPlan;
    previousPlan?: UserPlan;
    subscriptionStatus?: string | null;
    subscriptionEndsAt?: string | null;
  }): void {
    broadcastToAllWindows("plan-changed", payload);
  }

  /**
   * Store the server-confirmed entitlement for offline use. The expiry date
   * comes from the same `users` row the plan does; without one the record is
   * deliberately un-honourable (see resolveOfflineEntitlement).
   */
  private static async persistEntitlement(
    userId: string,
    plan: UserPlan,
    effectiveTier: UserPlan,
    email?: string,
  ): Promise<void> {
    try {
      const { readSettings, writeSettings } = await import("../main/settings");
      let subscriptionEndsAt: string | null = null;
      if (email) {
        const { getSubscriptionDetails } = await import(
          "./auth/supabase-client"
        );
        subscriptionEndsAt = (await getSubscriptionDetails(email)).endsAt;
      }
      void readSettings; // (read not needed — this key is written wholesale)
      writeSettings({
        lastKnownEntitlement: {
          userId,
          plan,
          effectiveTier,
          subscriptionEndsAt,
          cachedAt: Date.now(),
        },
      });
    } catch (e) {
      // Bookkeeping must never break sign-in.
      logger.warn(
        "[SubscriptionManager] persistEntitlement failed (non-fatal)",
        e,
      );
    }
  }

  /** Dedupe state for `applyPlanChange` — see the fingerprint comment there. */
  private static lastPlanFingerprint = "";
  private static lastPlanFingerprintAt = 0;

  /*
   * REMOVED: `setupRealtimeSubscription`.
   *
   * It opened an always-open Supabase realtime channel on `users` per signed-in app,
   * and that channel was the reason `realtime.list_changes` accounted for 93.5% of
   * this project's total database execution time — 7.3 MILLION WAL polls, measured
   * 2026-08-27 with `supabase inspect db calls` — to deliver an event most accounts
   * never fire.
   *
   * Replaced by `refreshPlanFromServer` on window focus, which is a better fit for
   * the flow: a plan change happens in a BROWSER, so the user necessarily leaves and
   * comes back. It also fixes a case the channel missed — the focus handler only
   * resumed realtime after a 60s idle-out, so upgrading and alt-tabbing straight back
   * refreshed nothing.
   *
   * A ban is unaffected in the way that matters: `entitlement.ts` hard-stops a banned
   * caller on EVERY request server-side, so the channel only ever made the UI react
   * sooner — it was never what stopped a banned account spending.
   */

  /** @internal Shared by the focus refresh below. */
  private static async applyPlanChange(
    newData: any,
    oldData: any,
  ): Promise<void> {
    {
      // `banned` MUST be in the fingerprint: without it a ban landing
      // within 2s of any other plan write is deduped away and never
      // reaches the session, which is the one change here that must
      // never be dropped.
      const fp = `${newData.plan}|${newData.subscriptionStatus ?? ""}|${newData.subscriptionEndsAt ?? ""}|${newData.effectiveTier ?? ""}|${newData.banned ? "banned" : ""}`;
      const now = Date.now();
      if (
        fp === this.lastPlanFingerprint &&
        now - this.lastPlanFingerprintAt < 2000
      ) {
        return;
      }
      this.lastPlanFingerprint = fp;
      this.lastPlanFingerprintAt = now;
      // Plan changed upstream — drop the cached tier so any later
      // getEffectiveTier reads the new value rather than the stale one.
      invalidatePlanCaches();

      logger.log(
        `[SubscriptionManager] 🎉 Subscription changed via realtime:`,
        {
          plan: `${oldData.plan} → ${newData.plan}`,
          status: `${oldData.subscriptionStatus} → ${newData.subscriptionStatus}`,
        },
      );

      if (this.session) {
        this.session = {
          ...this.session,
          plan: newData.plan,
          effectiveTier: newData.effectiveTier ?? newData.plan,
          banned: newData.banned ?? this.session.banned ?? false,
        };

        try {
          const { trackTier } = await import("../main/lib/analytics");
          trackTier(this.session.effectiveTier ?? this.session.plan);
        } catch {
          /* non-fatal */
        }

        this.broadcastPlanChanged({
          plan: newData.plan,
          effectiveTier: newData.effectiveTier ?? newData.plan,
          previousPlan: oldData.plan,
          subscriptionStatus: newData.subscriptionStatus,
          subscriptionEndsAt: newData.subscriptionEndsAt,
        });
        // The plan broadcast carries no ban field, so push the session
        // state too — this is what makes a live client react to a ban
        // instead of waiting for the next sign-in.
        if (newData.banned !== oldData.banned) {
          // `broadcastPlanChanged` above carries no ban field, and
          // `auth:resolved`'s payload is the one the renderer applies
          // DIRECTLY instead of re-invoking checkSession — which
          // matters here precisely because useAuth is unshared across
          // ~22 consumers.
          this.broadcastAuthResolved();
        }
      }
    }
  }

  /**
   * Re-read the plan and apply any change — the replacement for the realtime channel.
   *
   * WHY THIS EXISTS. The always-open plan-change subscription cost 93.5% of the
   * project's total database execution time (7.3M `realtime.list_changes` WAL polls,
   * measured 2026-08-27) to deliver an event most accounts never fire.
   *
   * A plan change happens in a BROWSER — atlarix.dev or Lemon Squeezy — so the user
   * necessarily leaves the app and comes back. Reading on focus catches the flow that
   * actually matters, and it catches it in the case the old code MISSED: the focus
   * handler only resumed realtime if it had first idled out after a 60s blur, so
   * upgrading and alt-tabbing straight back refreshed nothing at all.
   *
   * At most once per 10 minutes on focus (owner, 2026-10-20): focus fires on every
   * window switch, and at 15 s a new user's 70-minute session read `users` 26 times
   * for nothing. The flow the read is for still gets it at once: opening a checkout
   * or the billing portal (`notePlanPageOpened`) lets the next focus read regardless.
   */
  private static lastPlanRefreshAt = 0;
  private static planPageOpened = false;
  private static planRefreshInFlight: Promise<void> | null = null;
  static async refreshPlanFromServer(minIntervalMs = PLAN_FOCUS_REFRESH_MS, fresh = true): Promise<void> {
    const email = this.session?.email;
    if (!email) return;
    if (this.planRefreshInFlight) return this.planRefreshInFlight;
    const now = Date.now();
    if (now - this.lastPlanRefreshAt < minIntervalMs && !this.planPageOpened) return;
    this.lastPlanRefreshAt = now;
    this.planPageOpened = false;

    this.planRefreshInFlight = (async () => {
      try {
        const { fetchPlanSnapshot } = await import("./auth/supabase-client");
        const next = await fetchPlanSnapshot(email, fresh);
        if (!next) return;
        const prev = {
          plan: this.session?.plan ?? "free",
          subscriptionStatus: null,
          subscriptionEndsAt: null,
          effectiveTier: this.session?.effectiveTier,
          banned: this.session?.banned ?? false,
        };
        // Compare before doing any work: focus fires constantly and an
        // unchanged plan must not broadcast, or every window switch would
        // churn ~22 unshared useAuth consumers.
        const changed =
          next.plan !== prev.plan ||
          next.effectiveTier !== prev.effectiveTier ||
          Boolean(next.banned) !== Boolean(prev.banned);
        // The cache is dropped either way. "Unchanged" here means unchanged
        // versus the SESSION, and the tier cache can still be stale for
        // reasons the session does not track. The account row itself was
        // just read, so it is kept for the readers that follow.
        invalidatePlanCaches({ keepRow: true });
        if (changed) await this.applyPlanChange(next, prev as any);
      } catch (e) {
        // Never throws: this runs on window focus and must not surface there.
        logger.warn("[SubscriptionManager] plan refresh failed (non-fatal)", e);
      } finally {
        this.planRefreshInFlight = null;
      }
    })();
    return this.planRefreshInFlight;
  }

  /**
   * A checkout or the billing portal was just opened (lemonsqueezy.ts,
   * auth_handlers.ts): the plan may change there, so the next focus reads it
   * whatever the interval.
   */
  static notePlanPageOpened(): void {
    this.planPageOpened = true;
  }

  // ========================================
  // AUTHENTICATION
  // ========================================

  /**
   * Get current user session
   */
  static getCurrentUser(): UserSession | null {
    return this.session;
  }

  /**
   * Check if user is logged in
   */
  static isLoggedIn(): boolean {
    return this.session !== null;
  }

  /**
   * Get current user's plan
   * Defaults to 'free' if not logged in
   */
  static getLocalUserPlan(): UserPlan {
    return this.session?.plan || "free";
  }

  /**
   * Check if user has Pro plan (or higher)
   */
  static isPro(): boolean {
    return this.getLocalUserPlan() === "pro";
  }

  /**
   * Effective tier — equals `plan` (kept for API compatibility; Team removed).
   */
  static getEffectiveTier(): UserPlan {
    return this.session?.effectiveTier ?? this.session?.plan ?? "free";
  }

  /**
   * Refresh user plan from Supabase
   * Call this after payment to detect plan upgrades
   */
  static async refreshPlan(): Promise<UserPlan> {
    if (!this.session) {
      logger.log("[SubscriptionManager] Cannot refresh plan - not logged in");
      return "free";
    }

    // Explicit refresh (e.g. after payment) must bypass the tier cache.
    invalidatePlanCaches();
    const newPlan = await getUserPlan(this.session.id);
    const effectiveTier = await getEffectiveTier(this.session.id, newPlan);

    const changed =
      newPlan !== this.session.plan ||
      effectiveTier !== this.session.effectiveTier;

    if (changed) {
      logger.log(
        `[SubscriptionManager] Plan/effective tier refreshed: ${this.session.plan} → ${newPlan}, effective: ${effectiveTier}`,
      );
      this.session = {
        ...this.session,
        plan: newPlan,
        effectiveTier,
      };
    }

    return effectiveTier;
  }

  /**
   * Start a sign-in: OAuth with a provider, or email + password on atlarix.dev.
   */
  static async signIn(
    provider: SignInMethod,
  ): Promise<{ error: Error | null }> {
    if (provider === "email") return startEmailSignIn();
    return signInWithOAuth(provider);
  }

  /**
   * Sign out current user
   */
  static async signOut(): Promise<void> {
    await signOut();
    this.session = null;
    invalidatePlanCaches();
    clearAccountConnectors();
    this.lastPlanFingerprint = "";
    this.lastPlanFingerprintAt = 0;
    // Tell every window, not just the one that clicked Sign out.
    //
    // `useAuth` is an UNSHARED hook, so a second window holds its own copy of
    // the account and had no way to learn the session was gone — it kept
    // rendering a signed-in user until the app restarted. This must run AFTER
    // `this.session = null` so the payload is `{ user: null }`, which is the
    // whole message.
    this.broadcastAuthResolved();
  }

  /**
   * Handle OAuth callback from deep link
   */
  static async handleOAuthCallback(url: string): Promise<{
    success: boolean;
    user: UserSession | null;
    error: Error | null;
  }> {
    const result = await handleAuthCallback(url);

    if (result.error) {
      return { success: false, user: null, error: result.error };
    }

    if (result.session) {
      await this.updateSession(result.session);
    }

    return { success: true, user: this.session, error: null };
  }

  /**
   * Get current workspace count from database
   */
  static async getWorkspaceCount(): Promise<number> {
    // Use cache if available
    if (this.cachedWorkspaceCount !== null) {
      return this.cachedWorkspaceCount;
    }

    try {
      const allWorkspaces = await db.select().from(apps);
      this.cachedWorkspaceCount = allWorkspaces.length;
      return this.cachedWorkspaceCount;
    } catch (error) {
      logger.error(
        "[SubscriptionManager] Failed to get workspace count:",
        error,
      );
      return 0;
    }
  }

  /**
   * Clear workspace count cache (call after create/delete workspace)
   */
  static clearWorkspaceCache(): void {
    this.cachedWorkspaceCount = null;
  }

  /**
   * Get details about current workspace for upgrade modal
   */
  static async getCurrentWorkspaceDetails(): Promise<{
    id: number;
    name: string;
  } | null> {
    try {
      const workspace = await db.query.apps.findFirst();

      if (!workspace) return null;

      return {
        id: workspace.id,
        name: workspace.name,
      };
    } catch (error) {
      logger.error(
        "[SubscriptionManager] Failed to get workspace details:",
        error,
      );
      return null;
    }
  }

  // ========================================
  // INCOGNITO CHAT (NO GATING)
  // ========================================

  /**
   * Incognito chats are always allowed and free.
   * They have limited tools: web_search, read_url.
   */
  static canStartIncognitoChat(): boolean {
    return true; // Always allowed, no limits
  }

  /**
   * Get tools available for incognito chat (no workspace).
   * These are free and unlimited for all users.
   */
  static getIncognitoTools(): string[] {
    return ["web_search", "read_url"];
  }
}
