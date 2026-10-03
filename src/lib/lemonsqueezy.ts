/**
 * LemonSqueezy checkout (client side).
 * =====================================
 * The checkout session is created SERVER-SIDE by the `create-checkout` Supabase
 * edge function (A2 / SB-07): the LEMONSQUEEZY_API_KEY lives only there, and the
 * checkout's `custom_data.supabase_user_id` is set from the caller's verified JWT
 * so the billing webhook can trust it. The client only asks for a mode and opens
 * the returned URL.
 */

import log from "electron-log";
import { SubscriptionManager } from "./SubscriptionManager";
import { getSupabaseClient } from "./auth/supabase-client";

const logger = log.scope("lemonsqueezy");

async function createCheckoutViaEdge(
  body: Record<string, unknown>,
): Promise<string | null> {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.functions.invoke("create-checkout", {
      body,
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

/**
 * A checkout link without opening it: the CLI opens it in the user's browser
 * itself (and shows it, for SSH sessions), where `shell.openExternal` is a no-op.
 * Signed-in is checked by the edge function, from the session's JWT.
 */
export async function checkoutUrl(
  mode: "subscription" | "credit",
  amountCents?: number,
): Promise<string | null> {
  if (mode === "credit" && (!Number.isFinite(amountCents) || (amountCents ?? 0) < 1000)) return null;
  return createCheckoutViaEdge(
    mode === "credit" ? { mode, amount_cents: Math.floor(amountCents!) } : { mode },
  );
}

/** Atlarix Pro subscription checkout. */
export async function openUpgradeCheckout(): Promise<{
  success: boolean;
  error?: string;
}> {
  const currentUser = SubscriptionManager.getCurrentUser();
  if (!currentUser) {
    logger.warn("Attempted to upgrade without being signed in");
    return { success: false, error: "Please sign in first to upgrade." };
  }

  const checkoutUrl = await createCheckoutViaEdge({ mode: "subscription" });
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

/** PAYG top-up: buy Atlarix Core credit. `amountCents` must be >= $10 (1000). */
export async function openCreditCheckout(amountCents: number): Promise<{
  success: boolean;
  error?: string;
}> {
  const currentUser = SubscriptionManager.getCurrentUser();
  if (!currentUser) {
    return { success: false, error: "Please sign in first to add credit." };
  }
  if (!Number.isFinite(amountCents) || amountCents < 1000) {
    return { success: false, error: "Minimum top-up is $10." };
  }

  const checkoutUrl = await createCheckoutViaEdge({
    mode: "credit",
    amount_cents: Math.floor(amountCents),
  });
  if (!checkoutUrl) {
    return {
      success: false,
      error: "Unable to create checkout. Please try again.",
    };
  }

  logger.info(`Opening credit checkout ($${(amountCents / 100).toFixed(2)})`);
  const { shell } = await import("electron");
  await shell.openExternal(checkoutUrl);
  return { success: true };
}
