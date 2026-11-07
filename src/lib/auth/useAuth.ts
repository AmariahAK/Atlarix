/**
 * OAuth Authentication Hook
 * ===========================
 * Handles Google and GitHub OAuth flows via Supabase
 * Uses IPC to communicate with main process
 *
 * ONE SHARED STORE (2026-10-17). This used to be a plain hook: each of its ~23
 * consumers held its own copy of the account and ran its own session check, IPC
 * listeners and timers, so any side effect in `checkSession` fired ~23 times per
 * launch (the July Supabase request storm), a sign-in appended ~23 "Signed in"
 * toasts, and two components could briefly disagree about who was signed in.
 * Now the state lives once, in this module; the side effects start when the
 * first component uses it and stop when the last one goes. The hook's return
 * value is unchanged, so no caller changed.
 */

import { useSyncExternalStore } from "react";
import {
  subscribeAuthResolved,
  subscribeOAuthSuccess,
  subscribePlanChanged,
  subscribeSignInFailed,
  type AuthResolvedPayload,
} from "./auth-ipc-bridge";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  provider?: "google" | "github" | "discord";
}

export interface UserStatus {
  plan: "free" | "pro";
  isLoggedIn: boolean;
  currentWorkspaceCount: number;
  /** LemonSqueezy subscription status (e.g. active, on_trial, cancelled, expired) */
  subscriptionStatus?: string | null;
  subscriptionEndsAt?: string | null; // ISO date string
}

type SignInProvider = "google" | "github" | "discord" | "email";

interface AuthState {
  user: AuthUser | null;
  status: UserStatus | null;
  loading: boolean;
  /**
   * Has MAIN finished its deferred startup session restore?
   *
   * `loading` only covers this store's own round-trip, which resolves quickly
   * with `user: null` while main is still restoring — so consumers that keyed
   * on `!user` rendered a sign-in button on launch and flipped to the account
   * seconds later. This is the difference between "signed out" and "not known
   * yet". Starts false and is only ever set true.
   */
  authResolved: boolean;
  /** Banned, as resolved by MAIN (auth_handlers). Never computed here; this only mirrors what main knows. */
  banned: boolean;
  /** True after Sign in until `oauth-callback-success`, `auth:sign-in-failed`, Cancel or an IPC error */
  oauthPending: boolean;
  oauthProvider: SignInProvider | null;
  oauthStatusLabel: string;
}

const initialState = (): AuthState => ({
  user: null,
  status: null,
  loading: true,
  authResolved: false,
  banned: false,
  oauthPending: false,
  oauthProvider: null,
  oauthStatusLabel: "",
});

let state: AuthState = initialState();
const listeners = new Set<() => void>();

function setState(patch: Partial<AuthState> | ((s: AuthState) => Partial<AuthState>)): void {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

// ─── Side effects, once per renderer (not once per consumer) ──────────────────

let stopEffects: (() => void) | null = null;
let labelTimer: number | null = null;

/** The "Connecting to Google… / Verifying… / Setting up…" line while a sign-in is in flight. */
function setOAuthPending(pending: boolean, provider: SignInProvider | null): void {
  if (labelTimer != null) window.clearInterval(labelTimer);
  labelTimer = null;
  setState({ oauthPending: pending, oauthProvider: provider, oauthStatusLabel: "" });
  if (!pending || !provider) return;
  // Email is finished by the user in their browser, at their own pace; the
  // progress script below would claim work that is not happening.
  if (provider === "email") {
    setState({ oauthStatusLabel: "Finish signing in from your browser..." });
    return;
  }
  const started = Date.now();
  const tick = () => {
    const elapsed = Date.now() - started;
    const label = { google: "Google", github: "GitHub", discord: "Discord" }[provider];
    setState({
      oauthStatusLabel:
        elapsed < 2000 ? `Connecting to ${label}...` : elapsed < 5000 ? "Verifying your account..." : "Setting up Atlarix...",
    });
  };
  tick();
  labelTimer = window.setInterval(tick, 250);
}

function toast(className: string, html: string, ms: number): void {
  if (typeof document === "undefined" || !document.body) return;
  const n = document.createElement("div");
  n.className = className;
  n.innerHTML = html;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), ms);
}

const WELCOME_PRO_HTML = `
  <div>
    <div class="font-medium">Welcome to Atlarix Pro!</div>
    <div class="text-sm opacity-90">All Pro features are now unlocked.</div>
  </div>`;

function startEffects(): () => void {
  void checkSession();

  /**
   * Last-resort unstick for the launch placeholder.
   *
   * `authResolved` gates a neutral "Restoring your session…" screen with no
   * sign-in affordance. Everything below is arranged so main always answers —
   * but nothing main sends can rescue a renderer whose IPC threw, or that has
   * no bridge at all, and those paths used to leave the screen up forever.
   *
   * 10s rather than something snappy: too short brings back the signed-out
   * flash this flag exists to prevent. Firing is safe — a session that resolves
   * afterwards still arrives on `auth:resolved` and corrects the UI.
   */
  const unstick = window.setTimeout(() => {
    if (!state.authResolved) setState({ authResolved: true });
  }, 10_000);

  // Note: preload strips the event, so data is the first parameter
  const handleOAuthSuccess = (data: { user: AuthUser }) => {
    setOAuthPending(false, null);
    if (!data?.user) return;
    setState({
      user: {
        id: data.user.id,
        email: data.user.email,
        name: data.user.email?.split("@")[0] || "User",
        avatar: data.user.avatar,
      },
    });
    void fetchPlanInfo();
    // v14.27.0: signing in no longer deletes workspaces to make a Free plan
    // fit; the cap is enforced when a workspace is CREATED (workspace-quota.ts).
    // Once now, not once per consumer.
    setTimeout(
      () =>
        toast(
          "fixed bottom-4 right-4 bg-emerald-600 text-white px-4 py-3 rounded-lg shadow-lg z-[9999] flex items-center gap-3 animate-in slide-in-from-bottom-5",
          `<span class="text-xl">✅</span>
           <div>
             <div class="font-medium">Signed in successfully!</div>
             <div class="text-sm opacity-90">You're ready to continue.</div>
           </div>`,
          5000,
        ),
      100,
    );
  };

  // Realtime plan changes (Supabase Realtime → main process → frontend)
  const handlePlanChanged = (data: {
    plan: "free" | "pro";
    /** Effective tier (own or team); prefer over `plan` when present */
    effectiveTier?: "free" | "pro";
    previousPlan?: "free" | "pro";
    subscriptionStatus?: string | null;
    subscriptionEndsAt?: string | null;
  }) => {
    const nextPlan = (data.effectiveTier ?? data.plan) as UserStatus["plan"];

    // No session established yet → this event is ESTABLISHING one, not
    // updating one. Startup restores the Supabase session AFTER the window
    // exists, so the renderer mounts signed-out and `broadcastSessionState()`
    // fires this once the session lands. Dropping it left the user staring at a
    // sign-in screen with a valid session in main ("it forgets my login every
    // restart"). Re-read from main: this payload carries no user identity.
    if (!state.status?.isLoggedIn) {
      void checkSession();
      return;
    }

    setState((s) => ({
      status: s.status
        ? {
            ...s.status,
            plan: nextPlan,
            subscriptionStatus: data.subscriptionStatus ?? s.status.subscriptionStatus,
            subscriptionEndsAt: data.subscriptionEndsAt ?? s.status.subscriptionEndsAt,
          }
        : s.status,
    }));

    if (nextPlan === "pro" && data.previousPlan === "free" && data.subscriptionStatus === "active") {
      toast(
        "fixed bottom-4 right-4 bg-gradient-to-r from-purple-600 to-pink-600 text-white px-4 py-3 rounded-lg shadow-lg z-[9999] flex items-center gap-3 animate-in slide-in-from-bottom-5",
        WELCOME_PRO_HTML,
        6000,
      );
    }
  };

  /**
   * The startup restore settled — and, since v14.38.4, how a sign-out in
   * another window arrives (`user: null`). Applies the payload directly instead
   * of re-asking main. Safe on null only because `auth:resolved` is broadcast on
   * sign-IN too (SubscriptionManager.updateSession): the bridge replays its last
   * payload to late subscribers, and a stale null would otherwise sign out a
   * live session.
   */
  const handleAuthResolved = (data: AuthResolvedPayload) => {
    // Read the ban BEFORE the null-user return: this same broadcast is what a
    // live ban flip arrives on.
    if (!data?.user) {
      setState({ authResolved: true, banned: false, user: null, status: null });
      return;
    }
    const plan = (data.user.effectiveTier ?? data.user.plan ?? data.plan ?? "free") as UserStatus["plan"];
    setState((s) => ({
      authResolved: true,
      banned: !!data.user!.banned,
      user: {
        id: data.user!.id,
        email: data.user!.email ?? "",
        name: data.user!.name || (data.user!.email ?? "").split("@")[0] || "User",
        avatar: data.user!.avatar,
      },
      status: {
        plan,
        isLoggedIn: true,
        currentWorkspaceCount: s.status?.currentWorkspaceCount ?? 0,
        subscriptionStatus: s.status?.subscriptionStatus ?? null,
        subscriptionEndsAt: s.status?.subscriptionEndsAt,
      },
    }));
  };

  const unsubOAuth = subscribeOAuthSuccess(handleOAuthSuccess);
  // Main has already shown why (a native box); this only frees the buttons.
  const unsubSignInFailed = subscribeSignInFailed(() => setOAuthPending(false, null));
  const unsubPlan = subscribePlanChanged(handlePlanChanged);
  const unsubAuthResolved = subscribeAuthResolved(handleAuthResolved);

  return () => {
    window.clearTimeout(unstick);
    if (labelTimer != null) window.clearInterval(labelTimer);
    labelTimer = null;
    unsubOAuth();
    unsubSignInFailed();
    unsubPlan();
    unsubAuthResolved();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && !stopEffects) stopEffects = startEffects();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopEffects) {
      stopEffects();
      stopEffects = null;
    }
  };
}

const getSnapshot = () => state;

/** Test-only: forget the shared state (each test renders the hook fresh). */
export function __resetAuthStoreForTests(): void {
  stopEffects?.();
  stopEffects = null;
  listeners.clear();
  state = initialState();
}

// ─── Main-process round-trips ────────────────────────────────────────────────

type PlanResult = {
  success?: boolean;
  plan?: string;
  currentWorkspaceCount?: number;
  subscriptionStatus?: string | null;
  subscriptionEndsAt?: string | null;
  isLoggedIn?: boolean;
};

async function checkSession(): Promise<void> {
  setState({ loading: true });
  try {
    const ipcRenderer = window.electron?.ipcRenderer;
    if (!ipcRenderer?.invoke) {
      // No bridge means no answer is ever coming. Leaving `authResolved`
      // false here parks the launch placeholder permanently; "signed out,
      // with a way to sign in" is at least recoverable.
      setState({ authResolved: true });
      return;
    }

    type GetUserResult = {
      user?: {
        id: string;
        email?: string;
        name?: string;
        avatar?: string;
        plan?: string;
        effectiveTier?: "free" | "pro";
        banned?: boolean;
      };
      isPro?: boolean;
      authResolved?: boolean;
      /** Resolved in MAIN — see auth_handlers. Never derived here. */
      banned?: boolean;
    };
    const result = (await ipcRenderer.invoke("auth:get-current-user")) as GetUserResult | undefined;

    // A user in hand is itself proof the restore settled; otherwise trust
    // main's flag. Older handlers omit it — treat that as resolved so a version
    // skew can never leave the account slot blank forever.
    if (result?.user || result?.authResolved !== false) setState({ authResolved: true });
    setState({ banned: !!(result?.banned || result?.user?.banned) });

    if (result?.user) {
      setState({
        user: {
          id: result.user.id,
          email: result.user.email ?? "",
          name: result.user.name || (result.user.email ?? "").split("@")[0] || "User",
          avatar: result.user.avatar,
        },
        status: {
          plan: (result.user.effectiveTier ?? result.user.plan ?? "free") as "free" | "pro",
          isLoggedIn: true,
          currentWorkspaceCount: 0,
        },
      });
      // Full plan info (subscriptionEndsAt, etc.) for billing UI
      const planResult = (await ipcRenderer.invoke("auth:get-plan-info")) as PlanResult | undefined;
      if (planResult?.success) {
        setState((s) => ({
          status: s.status
            ? {
                ...s.status,
                plan: (planResult.plan ?? s.status.plan) as UserStatus["plan"],
                currentWorkspaceCount: planResult.currentWorkspaceCount ?? s.status.currentWorkspaceCount,
                subscriptionStatus: planResult.subscriptionStatus ?? s.status.subscriptionStatus ?? null,
                subscriptionEndsAt: planResult.subscriptionEndsAt ?? s.status.subscriptionEndsAt,
              }
            : s.status,
        }));
      }
    }
  } catch (error) {
    console.error("Failed to check session:", error);
    // A failed check is still an ANSWER — the same reasoning main applies when
    // it marks the restore resolved in a `finally`. Swallowing this left the
    // launch placeholder up with no error and no sign-in button.
    setState({ authResolved: true });
  } finally {
    setState({ loading: false });
  }
}

async function fetchPlanInfo(): Promise<void> {
  try {
    const ipcRenderer = window.electron?.ipcRenderer;
    if (!ipcRenderer?.invoke) return;
    const result = (await ipcRenderer.invoke("auth:get-plan-info")) as PlanResult | undefined;
    if (result?.success) {
      setState({
        status: {
          plan: (result.plan ?? "free") as UserStatus["plan"],
          isLoggedIn: result.isLoggedIn ?? true,
          currentWorkspaceCount: result.currentWorkspaceCount ?? 0,
          subscriptionStatus: result.subscriptionStatus ?? null,
          subscriptionEndsAt: result.subscriptionEndsAt ?? null,
        },
      });
    }
  } catch (error) {
    console.error("Failed to fetch plan info:", error);
  }
}

/**
 * Start a sign-in. One implementation for every provider; the flow continues
 * in the user's browser and the callback is handled in main.
 */
async function startOAuth(provider: SignInProvider): Promise<void> {
  try {
    const ipcRenderer = window.electron?.ipcRenderer;
    if (!ipcRenderer?.invoke) {
      console.error("IPC not available");
      return;
    }
    setOAuthPending(true, provider);
    const result = (await ipcRenderer.invoke("auth:sign-in", { provider })) as { error?: string; success?: boolean } | undefined;
    if (result?.error) {
      console.error(`${provider} sign in failed`, result.error);
      setOAuthPending(false, null);
    }
  } catch (error) {
    console.error(`${provider} sign in error:`, error);
    setOAuthPending(false, null);
  }
}

/**
 * Give up on the sign-in in flight: the user closed the browser tab, or picked
 * the wrong provider. Frees the buttons and stops main's "not completing?"
 * prompt. The flow itself stays valid, so finishing it in the browser anyway
 * still signs in.
 */
async function cancelSignIn(): Promise<void> {
  setOAuthPending(false, null);
  try {
    await window.electron?.ipcRenderer?.invoke?.("auth:cancel-sign-in");
  } catch (error) {
    console.error("Cancel sign in error:", error);
  }
}

const signInWithGoogle = () => startOAuth("google");
const signInWithGitHub = () => startOAuth("github");
const signInWithDiscord = () => startOAuth("discord");
const signInWithEmail = () => startOAuth("email");

/**
 * @param removeLocalData Also delete this machine's workspaces and chat
 * history. Defaults to false — signing out clears credentials, and nothing
 * else. The caller (the sign-out dialog) offers it as an unchecked box.
 */
async function signOut(removeLocalData = false): Promise<void> {
  try {
    const ipcRenderer = window.electron?.ipcRenderer;
    if (!ipcRenderer?.invoke) return;
    await ipcRenderer.invoke("auth:sign-out", { removeLocalData });
    // Clear the ban too, or the Sign out button on the banned screen does
    // nothing: welcome-launcher tests `if (banned)` BEFORE
    // `if (!isAuthenticated)`, so a stuck `true` re-renders the same screen
    // after a successful sign-out (reported live 2026-08-20). Clearing it
    // locally lets a banned user do nothing: they are signed out, and the
    // proxy's 403 is the enforcement either way.
    setState({ user: null, status: null, banned: false });
  } catch (error) {
    console.error("Sign out error:", error);
  }
}

/** Refresh plan from Supabase - call after payment completion */
async function refreshPlan(): Promise<string | null> {
  try {
    const ipcRenderer = window.electron?.ipcRenderer;
    if (!ipcRenderer?.invoke) return null;
    const result = (await ipcRenderer.invoke("auth:refresh-plan")) as { success?: boolean; plan?: string } | undefined;
    const status = state.status;
    if (result?.success && status) {
      const newPlan = (result.plan ?? status.plan) as UserStatus["plan"];
      setState({ status: { ...status, plan: newPlan } });
      console.log("[useAuth] Plan refreshed:", result.plan);
      if (newPlan === "pro" && status.plan !== "pro") {
        toast(
          "fixed bottom-4 right-4 bg-emerald-600 text-white px-4 py-3 rounded-lg shadow-lg z-[9999] flex items-center gap-3 animate-in slide-in-from-bottom-5",
          WELCOME_PRO_HTML,
          5000,
        );
      }
      return result.plan ?? null;
    }
    return null;
  } catch (error) {
    console.error("Refresh plan error:", error);
    return null;
  }
}

export function useAuth() {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    user: s.user,
    status: s.status,
    loading: s.loading,
    isAuthenticated: !!s.user,
    /**
     * True only once main's startup restore has settled. Render a neutral
     * placeholder rather than a sign-in affordance while this is false —
     * `!isAuthenticated` alone does not mean signed out during launch.
     */
    authResolved: s.authResolved,
    /**
     * This account is banned. The gate that reads this sits in front of the
     * LAUNCHER (`pages/welcome-launcher.tsx`), so nothing in the client works
     * while it is true — BYOK and local models included (docs/BAN_RUNBOOK.md).
     * The hard stop is still the proxy's 403: the client gate is bypassable by
     * an older build or no network.
     */
    banned: s.banned,
    oauthPending: s.oauthPending,
    oauthProvider: s.oauthProvider,
    oauthStatusLabel: s.oauthStatusLabel,
    signInWithGoogle,
    signInWithGitHub,
    signInWithDiscord,
    signInWithEmail,
    cancelSignIn,
    signOut,
    refreshStatus: fetchPlanInfo,
    refreshPlan,
  };
}
