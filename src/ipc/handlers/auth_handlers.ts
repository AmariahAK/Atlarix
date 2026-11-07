/**
 * Auth IPC Handlers
 * ==================
 * IPC handlers for OAuth sign-in, sign-out, and session management
 */

import { ipcMain } from "electron";
import { SubscriptionManager } from "../../lib/SubscriptionManager";
import { cancelPendingOAuthTimeout } from "../../lib/auth/supabase-client";
import log from "electron-log";
import { db } from "@/db";
import { apps } from "@/db/schema";

const logger = log.scope("auth-handlers");

/**
 * Collapse concurrent identical reads into ONE upstream call.
 *
 * `useAuth` is a plain hook with no shared state, so every component that calls it
 * runs its own `checkSession()` on mount — and there are ~20 of them. Each one fired
 * `auth:get-current-user` and `auth:get-plan-info` independently, so a single app start
 * hit Supabase several times over for answers that are identical by construction. The
 * measurement that forced this was a *write* RPC: the project's API logs showed four
 * `claim_signup_credit` calls inside the same second. That channel is gone with the
 * signup trial (2026-09-08), but the reads it travelled with are still duplicated the
 * same way, so the coalescing stays.
 *
 * Coalescing here rather than in the hook fixes it for all consumers at once without
 * touching any of them. Only calls that OVERLAP are shared — nothing is cached past
 * settlement, so a later read is still fresh (a balance right after a top-up, say).
 */
import { isStartupAuthResolved } from "@/lib/auth/startup-auth-state";

const inFlight = new Map<string, Promise<unknown>>();

function coalesce<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = run().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}

export function registerAuthHandlers() {
  logger.log("[AuthHandlers] Registering auth IPC handlers");

  // SubscriptionManager.initialize() runs from main after app.ready (see main.ts onReady)

  // Sign in with OAuth provider
  ipcMain.handle(
    "auth:sign-in",
    async (
      _,
      { provider }: { provider: "google" | "github" | "discord" | "email" },
    ) => {
      logger.log(`[AuthHandlers] Sign in requested with ${provider}`);

      try {
        const result = await SubscriptionManager.signIn(provider);

        if (result.error) {
          logger.error(`[AuthHandlers] Sign in error:`, result.error);
          return { success: false, error: result.error.message };
        }

        // OAuth flow started - browser will open
        // Callback will be handled by deep link in main.ts
        return {
          success: true,
          message: "OAuth flow started, check your browser",
        };
      } catch (error) {
        logger.error(`[AuthHandlers] Sign in exception:`, error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // The user gave up on a sign-in in flight: only the "not completing?" prompt
  // goes. The flow stays valid, so finishing in the browser still signs in.
  ipcMain.handle("auth:cancel-sign-in", async () => {
    cancelPendingOAuthTimeout();
    return { success: true };
  });

  /**
   * Sign out — clears CREDENTIALS, not the user's work.
   *
   * This used to run `db.delete(apps).run()` unconditionally, with the comment
   * "fresh start". An `apps` row cascades to chat sessions, MCP servers, daily
   * logs, workflow templates, pivot containers/beacons AND automations, so one
   * click on Sign Out destroyed every trace of every project — the folders on
   * disk survived, everything Atlarix knew about them did not.
   *
   * No comparable tool does this. Claude Code's documented behaviour is that
   * sign-out clears tokens; its per-project state under `~/.claude/projects/`
   * survives. For Claude Code, Codex and Cursor a project is a directory, so
   * signing out *cannot* delete it. Atlarix differs only because a workspace is
   * a DB row — which is a reason to be careful with the row, not a licence to
   * drop it.
   *
   * The shared-machine worry it was presumably guarding against is already
   * handled by the OS: all of this lives under the OS user's own userData
   * directory. Someone who genuinely wants the data gone asks for it —
   * `removeLocalData`, unchecked by default in the sign-out dialog.
   */
  ipcMain.handle(
    "auth:sign-out",
    async (_event, params?: { removeLocalData?: boolean }) => {
      logger.log(
        `[AuthHandlers] Sign out requested${params?.removeLocalData ? " (with local data removal)" : ""}`,
      );
      try {
        if (params?.removeLocalData) {
          // Explicitly asked for. Never a side effect of signing out.
          try {
            const allWorkspaces = db.select().from(apps).all();
            logger.log(
              `[AuthHandlers] Removing ${allWorkspaces.length} workspace(s) at the user's request`,
            );
            if (allWorkspaces.length > 0) {
              const { chatSessions } = await import("@/db/schema");
              const { inArray } = await import("drizzle-orm");
              const workspaceIds = allWorkspaces.map((a) => a.id);
              try {
                db.delete(chatSessions)
                  .where(inArray(chatSessions.workspaceId, workspaceIds))
                  .run();
              } catch (e) {
                logger.error("Error deleting sessions:", e);
              }
              db.delete(apps).run();
            }
          } catch (dbError) {
            logger.error(
              "[AuthHandlers] Failed to remove local data (proceeding with sign out anyway):",
              dbError,
            );
          }
        }

        await SubscriptionManager.signOut();
        return { success: true };
      } catch (error) {
        logger.error(`[AuthHandlers] Sign out error:`, error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Get current user
  //
  // The ban is reported HERE, in main, and never checked in `useAuth`: that hook
  // is unshared across ~22 consumers that each run their own `checkSession()`,
  // so a check in the hook fires 22 times per sign-in (the known cause of the
  // repeated "Enforcing workspace limit" logs). Main holds one cached session
  // and the realtime channel updates it, so this read is free.
  ipcMain.handle("auth:get-current-user", async () => {
    try {
      const user = SubscriptionManager.getCurrentUser();
      return {
        success: true,
        user,
        /** Banned from Atlarix Core + the account. Reason never leaves the server. */
        banned: !!user?.banned,
        isLoggedIn: SubscriptionManager.isLoggedIn(),
        isPro: SubscriptionManager.isPro(),
        // False while the deferred startup restore is still running. A
        // null `user` means "signed out" ONLY once this is true —
        // otherwise it just means "not known yet", and rendering a
        // sign-in button on it is what made the app look like it logged
        // you out and back in on every launch.
        authResolved: isStartupAuthResolved(),
      };
    } catch (error) {
      logger.error(`[AuthHandlers] Get current user error:`, error);
      return {
        success: false,
        user: null,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  /*
   * THREE WORKSPACE-LIMIT CHANNELS LIVED HERE, AND ALL THREE ARE GONE.
   *
   * `auth:enforce-workspace-limit` (until v14.27.0) ran on sign-in and, for a Free
   * user, DELETED every workspace but the OLDEST — cascading through chat sessions,
   * MCP servers, daily logs, workflow templates and automations. It needed request
   * coalescing and a remembered result purely because ~22 `useAuth` consumers each
   * invoked it in one tick and a destructive operation was racing itself.
   *
   * `auth:can-create-workspace` and `auth:check-workspace-limit` replaced it with a
   * refusal at CREATE time, which was the right shape for a cap.
   *
   * On 2026-09-08 the cap itself went: the desktop app is free, every feature is on
   * every plan, and what you pay for is Atlarix Core inference. `get-plan-info` still
   * reports `currentWorkspaceCount` because the number is worth showing; there is
   * simply no limit to compare it against.
   */

  // Get workspace limit info
  // Coalesced: the subscription lookup inside is TTL-cached, but a cold cache with
  // ~20 consumers calling at once means every one of them misses and hits Supabase
  // before the first result lands to populate it.
  ipcMain.handle("auth:get-plan-info", async () =>
    coalesce("get-plan-info", async () => {
      try {
        const user = SubscriptionManager.getCurrentUser();
        const workspaceCount = await SubscriptionManager.getWorkspaceCount();
        const workspaceDetails =
          await SubscriptionManager.getCurrentWorkspaceDetails();

        // Subscription details — TTL-cached + invalidated on realtime plan
        // change, so repeated get-plan-info calls don't each hit Supabase.
        let subscriptionStatus: string | null = null;
        let subscriptionEndsAt: string | null = null;

        if (user?.email) {
          const { getSubscriptionDetails } = await import(
            "../../lib/auth/supabase-client"
          );
          const details = await getSubscriptionDetails(user.email);
          subscriptionStatus = details.status;
          subscriptionEndsAt = details.endsAt;
        }

        return {
          success: true,
          plan: user ? SubscriptionManager.getEffectiveTier() : "free",
          isLoggedIn: SubscriptionManager.isLoggedIn(),
          currentWorkspaceCount: workspaceCount,
          currentWorkspace: workspaceDetails,
          subscriptionStatus, // 'active' | 'cancelled' | null
          subscriptionEndsAt, // ISO date string or null
        };
      } catch (error) {
        logger.error(`[AuthHandlers] Get plan info error:`, error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }),
  );

  // Open upgrade checkout (requires OAuth sign-in)
  ipcMain.handle("auth:upgrade", async () => {
    logger.log("[AuthHandlers] Upgrade to Pro requested");

    try {
      const { openUpgradeCheckout } = await import("../../lib/lemonsqueezy");
      const result = await openUpgradeCheckout();

      if (!result.success) {
        return { success: false, error: result.error };
      }

      return { success: true, message: "Checkout opened in browser" };
    } catch (error) {
      logger.error(`[AuthHandlers] Upgrade error:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // PAYG: open a credit top-up checkout ($10 minimum). Amount in cents.
  ipcMain.handle("auth:add-credit", async (_e, amountCents: number) => {
    logger.log("[AuthHandlers] Add credit requested");
    try {
      const { openCreditCheckout } = await import("../../lib/lemonsqueezy");
      const result = await openCreditCheckout(Number(amountCents));
      if (!result.success) return { success: false, error: result.error };
      return { success: true, message: "Credit checkout opened in browser" };
    } catch (error) {
      logger.error(`[AuthHandlers] Add credit error:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // PAYG: read the user's Atlarix Core credit balance (integer cents).
  ipcMain.handle("auth:get-credit-balance", async () =>
    // Several cards read the balance at once (usage card, low-balance nudge, error
    // box). Overlapping reads share one RPC; a later read still goes to Supabase,
    // so a top-up shows up immediately.
    coalesce("get-credit-balance", async () => {
      try {
        const { getSupabaseClient, getSession } = await import(
          "../../lib/auth/supabase-client"
        );
        // Signed out: answer locally. Calling the RPC anonymously is refused by
        // design (anon has no EXECUTE — security audit) and only adds a Postgres
        // "permission denied" and a wasted request per read. `ok:false` with no
        // error is the renderer's "needs sign-in" (useCreditBalance).
        if (!(await getSession())) return { ok: false, balanceCents: 0 };
        const supabase = getSupabaseClient();
        const { data, error } = await supabase.rpc("get_credit_balance");
        if (error) return { ok: false, error: error.message, balanceCents: 0 };
        // THE SPLIT, WHICH USED TO BE THROWN AWAY HERE. The RPC has
        // returned `granted_cents` and `purchased_cents` since the
        // subscription allowance shipped, and this cast named neither —
        // so the one number the app could not show was which half of a
        // balance expires. `balance_cents` remains the SPENDABLE total
        // (allowance + purchased) and is still what every gate reads.
        //
        // Null, not 0, when the halves are absent: an older server that
        // returns only the total must render as "no split known" rather
        // than as "your allowance is zero", which is a different and
        // alarming claim.
        const row = data as {
          ok?: boolean;
          balance_cents?: number;
          granted_cents?: number;
          granted_total_cents?: number;
          purchased_cents?: number;
        } | null;
        const half = (v: unknown) => (typeof v === "number" ? v : null);
        return {
          ok: row?.ok !== false,
          balanceCents: Number(row?.balance_cents ?? 0),
          grantedCents: half(row?.granted_cents),
          // What the PERIOD granted, so the card can show consumption
          // rather than composition. `granted_cents` is what is LEFT of
          // it; consumed is the difference.
          grantedTotalCents: half(row?.granted_total_cents),
          purchasedCents: half(row?.purchased_cents),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Unknown error",
          balanceCents: 0,
          grantedCents: null,
          grantedTotalCents: null,
          purchasedCents: null,
        };
      }
    }),
  );

  // Refresh plan from Supabase (call after payment)
  ipcMain.handle("auth:refresh-plan", async () => {
    logger.log("[AuthHandlers] Refreshing plan from Supabase");

    try {
      const plan = await SubscriptionManager.refreshPlan();
      logger.log(`[AuthHandlers] Plan refreshed: ${plan}`);
      return { success: true, plan };
    } catch (error) {
      logger.error(`[AuthHandlers] Refresh plan error:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Open LemonSqueezy customer portal for subscription management
  ipcMain.handle("auth:manage-subscription", async () => {
    logger.log("[AuthHandlers] Opening subscription management portal");

    try {
      const currentUser = SubscriptionManager.getCurrentUser();
      if (!currentUser?.email) {
        return { success: false, error: "Not signed in" };
      }

      // Get the customer portal URL from the database
      const { getSupabaseClient } = await import(
        "../../lib/auth/supabase-client"
      );
      const supabase = getSupabaseClient();

      const { data, error } = await supabase
        .from("users")
        .select("customer_portal_url")
        .eq("email", currentUser.email)
        .single();

      const { shell } = await import("electron");
      // The plan may change in the portal: the next focus reads it.
      SubscriptionManager.notePlanPageOpened();

      if (error || !data?.customer_portal_url) {
        // Fallback: Open LemonSqueezy billing page with email hint
        logger.warn(
          "[AuthHandlers] No customer portal URL found, using fallback",
        );
        await shell.openExternal("https://app.lemonsqueezy.com/my-orders");
        return { success: true, fallback: true };
      }

      // Open user's specific customer portal (pre-authenticated link)
      logger.log(
        "[AuthHandlers] Opening customer portal:",
        data.customer_portal_url,
      );
      await shell.openExternal(data.customer_portal_url);

      return { success: true };
    } catch (error) {
      logger.error("[AuthHandlers] Manage subscription error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Cancel subscription via LemonSqueezy API
  ipcMain.handle("auth:cancel-subscription", async () => {
    logger.log("[AuthHandlers] Cancel subscription requested");

    try {
      const currentUser = SubscriptionManager.getCurrentUser();
      if (!currentUser?.email) {
        return { success: false, error: "Not signed in" };
      }

      // Cancel server-side via the cancel-subscription edge function. The
      // LEMONSQUEEZY_API_KEY no longer lives in the client (A2); the function
      // looks the subscription up by the verified user id and cancels it. The
      // billing webhook then reconciles subscription_status / ends_at on the
      // users row (which the client is not allowed to write directly anyway).
      const { getSupabaseClient } = await import(
        "../../lib/auth/supabase-client"
      );
      const supabase = getSupabaseClient();

      const { data: cancelResult, error: cancelError } =
        await supabase.functions.invoke("cancel-subscription", { body: {} });

      if (cancelError || !(cancelResult as { success?: boolean })?.success) {
        logger.error(
          "[AuthHandlers] cancel-subscription failed:",
          cancelError?.message,
        );
        const code = (cancelResult as { error?: string })?.error;
        return {
          success: false,
          error:
            code === "no_active_subscription"
              ? "No active subscription found"
              : "Failed to cancel subscription",
        };
      }

      const endsAt =
        (cancelResult as { endsAt?: string | null }).endsAt ?? null;
      logger.log("[AuthHandlers] Subscription cancelled. Ends at:", endsAt);

      await SubscriptionManager.refreshPlan();
      const effectiveTier = SubscriptionManager.getEffectiveTier();
      const sessionPlan = SubscriptionManager.getLocalUserPlan();

      const { BrowserWindow } = await import("electron");
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        win.webContents.send("plan-changed", {
          plan: sessionPlan,
          effectiveTier,
          subscriptionStatus: "cancelled",
          subscriptionEndsAt: endsAt,
        });
      }

      // Delayed verification check (safety net) - re-confirm after 3s
      setTimeout(async () => {
        try {
          await SubscriptionManager.refreshPlan();
          const { data: verifyData } = await supabase
            .from("users")
            .select("subscription_status, subscription_ends_at")
            .eq("email", currentUser.email)
            .single();

          if (verifyData) {
            logger.log("[AuthHandlers] Verification check:", verifyData);
            const { BrowserWindow: BW } = require("electron");
            BW.getAllWindows().forEach((win: any) => {
              win.webContents.send("plan-changed", {
                plan: SubscriptionManager.getLocalUserPlan(),
                effectiveTier: SubscriptionManager.getEffectiveTier(),
                subscriptionStatus: verifyData.subscription_status,
                subscriptionEndsAt: verifyData.subscription_ends_at,
              });
            });
          }
        } catch (err) {
          logger.warn("[AuthHandlers] Verification check failed:", err);
        }
      }, 3000);

      // Format the end date for display
      let endDateDisplay = "the end of your billing period";
      if (endsAt) {
        const endDate = new Date(endsAt);
        endDateDisplay = endDate.toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
        });
      }

      const tierLabel = "Pro";
      return {
        success: true,
        endsAt,
        message: `Subscription cancelled. You'll have ${tierLabel} access until ${endDateDisplay}.`,
      };
    } catch (error) {
      logger.error("[AuthHandlers] Cancel subscription error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  logger.log("[AuthHandlers] Auth IPC handlers registered");
}
