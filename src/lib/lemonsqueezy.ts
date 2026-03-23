/**
 * LemonSqueezy Integration
 * ========================
 * Checkout sessions for Atlarix paid tiers via the LemonSqueezy Checkout API.
 *
 * Env (see README / CI secrets and docs/subscription-billing.md):
 * - LEMONSQUEEZY_API_KEY
 * - LEMONSQUEEZY_STORE_ID
 * - LEMONSQUEEZY_PRO_VARIANT_ID — Atlarix Pro (solo); falls back to LEMONSQUEEZY_VARIANT_ID
 * - LEMONSQUEEZY_WORKFORCE_VARIANT_ID — Atlarix Workforce (teams); required for Workforce checkout
 */

import log from "electron-log";
import { SubscriptionManager } from "./SubscriptionManager";

const logger = log.scope("lemonsqueezy");

const DEFAULT_STORE_ID = "236920";
/** Dev fallback only when no Pro env variant is set (avoid silent wrong checkout in production). */
const DEV_FALLBACK_PRO_VARIANT_ID = "1226325";

function trimEnv(key: string): string | undefined {
  const v = process.env[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Pro solo checkout — explicit Pro product, then legacy LEMONSQUEEZY_VARIANT_ID, then dev fallback.
 * Do not use Workforce variant here.
 */
export function resolveProVariantId(): string | null {
  return (
    trimEnv("LEMONSQUEEZY_PRO_VARIANT_ID") ||
    trimEnv("LEMONSQUEEZY_VARIANT_ID") ||
    (process.env.NODE_ENV === "development" ? DEV_FALLBACK_PRO_VARIANT_ID : null)
  );
}

/** Workforce-only variant (teams). Required for Workforce checkout; no fallback to Pro. */
export function resolveWorkforceVariantId(): string | null {
  return trimEnv("LEMONSQUEEZY_WORKFORCE_VARIANT_ID") || null;
}

/** @deprecated Prefer resolveProVariantId / resolveWorkforceVariantId for explicit tier. */
export function resolveCheckoutVariantId(): string | null {
  return resolveWorkforceVariantId() || resolveProVariantId();
}

/**
 * Create a LemonSqueezy checkout for a specific variant.
 */
async function createCheckoutSessionForVariant(
  userEmail: string,
  userId: string | undefined,
  variantId: string,
  custom: Record<string, string>,
): Promise<string | null> {
  const storeId = trimEnv("LEMONSQUEEZY_STORE_ID") || DEFAULT_STORE_ID;
  const apiKey = trimEnv("LEMONSQUEEZY_API_KEY");

  if (!apiKey) {
    logger.error(
      "Missing LEMONSQUEEZY_API_KEY; set it in .env or GitHub Actions secrets",
    );
    return null;
  }

  try {
    const checkoutData = {
      data: {
        type: "checkouts",
        attributes: {
          checkout_data: {
            email: userEmail,
            custom: {
              user_id: userId || "",
              source: "atlarix-app",
              ...custom,
            },
          },
        },
        relationships: {
          store: {
            data: {
              type: "stores",
              id: storeId,
            },
          },
          variant: {
            data: {
              type: "variants",
              id: variantId,
            },
          },
        },
      },
    };

    logger.info("Creating LemonSqueezy checkout session…", { variantId });

    const response = await fetch("https://api.lemonsqueezy.com/v1/checkouts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
      },
      body: JSON.stringify(checkoutData),
    });

    if (response.status === 201) {
      const data = await response.json();
      const checkoutUrl = data?.data?.attributes?.url;
      if (checkoutUrl) {
        logger.info("Checkout session created successfully");
        return checkoutUrl;
      }
    }

    logger.error(
      `LemonSqueezy API error: ${response.status} - ${await response.text()}`,
    );
    return null;
  } catch (error) {
    logger.error("Failed to create checkout session:", error);
    return null;
  }
}

/**
 * Pro checkout — uses LEMONSQUEEZY_PRO_VARIANT_ID or LEMONSQUEEZY_VARIANT_ID (legacy).
 */
export async function openUpgradeCheckout(): Promise<{
  success: boolean;
  error?: string;
}> {
  const currentUser = SubscriptionManager.getCurrentUser();

  if (!currentUser) {
    logger.warn("Attempted to upgrade without being signed in");
    return {
      success: false,
      error: "Please sign in first to upgrade.",
    };
  }

  if (!currentUser.email) {
    return {
      success: false,
      error: "Unable to get your email. Please sign in again.",
    };
  }

  const variantId = resolveProVariantId();
  if (!variantId) {
    logger.error(
      "No Pro LemonSqueezy variant configured (set LEMONSQUEEZY_PRO_VARIANT_ID or LEMONSQUEEZY_VARIANT_ID)",
    );
    return {
      success: false,
      error:
        "Pro checkout is not configured. Set LEMONSQUEEZY_PRO_VARIANT_ID or LEMONSQUEEZY_VARIANT_ID (and API key).",
    };
  }

  const checkoutUrl = await createCheckoutSessionForVariant(
    currentUser.email,
    currentUser.id,
    variantId,
    { tier: "pro" },
  );

  if (!checkoutUrl) {
    return {
      success: false,
      error: "Unable to create checkout. Please try again or contact support.",
    };
  }

  logger.info(`Opening checkout for user: ${currentUser.email}`);
  const { shell } = await import("electron");
  await shell.openExternal(checkoutUrl);
  return { success: true };
}

/**
 * Check if user can access upgrade flow (Pro or Workforce)
 */
export function canUpgrade(): { canUpgrade: boolean; reason?: string } {
  const currentUser = SubscriptionManager.getCurrentUser();

  if (!currentUser) {
    return {
      canUpgrade: false,
      reason: "Sign in to upgrade your Atlarix plan",
    };
  }

  const tier = SubscriptionManager.getEffectiveTier();
  if (tier === "workforce") {
    return { canUpgrade: false, reason: "You already have Atlarix Workforce!" };
  }
  if (tier === "pro") {
    return { canUpgrade: true };
  }

  return { canUpgrade: true };
}

/**
 * Atlarix Workforce checkout — uses LEMONSQUEEZY_WORKFORCE_VARIANT_ID, with same fallbacks as openUpgradeCheckout.
 */
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
  if (!currentUser.email) {
    return {
      success: false,
      error: "Unable to get your email. Please sign in again.",
    };
  }

  const variantId = resolveWorkforceVariantId();
  if (!variantId) {
    logger.error("Missing LEMONSQUEEZY_WORKFORCE_VARIANT_ID and API key");
    return {
      success: false,
      error:
        "Workforce checkout is not configured. Set LEMONSQUEEZY_WORKFORCE_VARIANT_ID in your environment.",
    };
  }

  const checkoutUrl = await createCheckoutSessionForVariant(
    currentUser.email,
    currentUser.id,
    variantId,
    { tier: "workforce" },
  );

  if (!checkoutUrl) {
    return {
      success: false,
      error: "Unable to create checkout. Please try again.",
    };
  }

  const { shell } = await import("electron");
  await shell.openExternal(checkoutUrl);
  return { success: true };
}
