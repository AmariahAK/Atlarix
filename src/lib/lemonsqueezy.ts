/**
 * LemonSqueezy checkout (client side).
 * =====================================
 * The checkout session is created SERVER-SIDE by the `create-checkout` Supabase
 * edge function (A2 / SB-07): the LEMONSQUEEZY_API_KEY lives only there, and the
 * checkout's `custom_data.supabase_user_id` is set from the caller's verified JWT
 * so the billing webhook can trust it. The client only asks for a tier and opens
 * the returned URL.
 */

import log from "electron-log";
import { SubscriptionManager } from "./SubscriptionManager";
import { getSupabaseClient } from "./auth/supabase-client";

const logger = log.scope("lemonsqueezy");

async function createCheckoutViaEdge(
  tier: "pro" | "workforce",
): Promise<string | null> {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.functions.invoke("create-checkout", {
      body: { tier },
    });
    if (error) {
      logger.error(`create-checkout edge function failed: ${error.message}`);
      return null;
    }
    const url = (data as { url?: string } | null)?.url;
    return typeof url === "string" && url ? url : null;
  } catch (err) {
    logger.error("Failed to create checkout session:", err);
    return null;
  }
}

/** Pro (solo) checkout. */
export async function openUpgradeCheckout(): Promise<{
  success: boolean;
  error?: string;
}> {
  const currentUser = SubscriptionManager.getCurrentUser();
  if (!currentUser) {
    logger.warn("Attempted to upgrade without being signed in");
    return { success: false, error: "Please sign in first to upgrade." };
  }

  const checkoutUrl = await createCheckoutViaEdge("pro");
  if (!checkoutUrl) {
    return {
      success: false,
      error: "Unable to create checkout. Please try again or contact support.",
    };
  }

  logger.info("Opening Pro checkout");
  const { shell } = await import("electron");
  await shell.openExternal(checkoutUrl);
  return { success: true };
}

/** Atlarix Workforce (teams) checkout. */
export async function openWorkforceCheckout(): Promise<{
  success: boolean;
  error?: string;
}> {
  const currentUser = SubscriptionManager.getCurrentUser();
  if (!currentUser) {
    return {
      success: false,
      error: "Please sign in first to upgrade to Atlarix Workforce.",
    };
  }

  const checkoutUrl = await createCheckoutViaEdge("workforce");
  if (!checkoutUrl) {
    return { success: false, error: "Unable to create checkout. Please try again." };
  }

  logger.info("Opening Workforce checkout");
  const { shell } = await import("electron");
  await shell.openExternal(checkoutUrl);
  return { success: true };
}
