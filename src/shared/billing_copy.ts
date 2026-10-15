/**
 * Every sentence the app says about money, in one module.
 *
 * WHY IT EXISTS. The same idea was written out in five places — `useUpgrade`,
 * the Core failure classifier, the low-balance toast, the usage card and
 * `--doctor` — and they disagreed. That is not a tidiness problem: two of those
 * copies were describing a product that stopped existing on 2026-08-26, when Pro
 * started including Atlarix Core for everyday work and the tier stopped being
 * the thing standing between a user and a model.
 *
 * THE DISTINCTION THAT MATTERS NOW is no longer *free vs pro*. It is
 * **allowance left / credit left / neither**, and that is a question about a
 * balance, not about a plan. So nothing in here names a tier, and the two
 * moments worth a message are the ones where the balance changes character:
 * when the month's included usage runs out and the user moves onto money they
 * paid, and when that runs out too.
 *
 * WHERE THE SPLIT IS EXPLAINED is the usage card, because that is where the
 * numbers are. A streaming error is the wrong place to teach someone their
 * billing model; it says what happened and how to continue.
 *
 * `src/lib/plan-caps.ts` is the precedent for this shape: the values live in one
 * module and every consumer interpolates. Its header reads as a spec for this
 * one.
 *
 * KEEP IN SYNC with `atlarix-launchpad/src/data/products.ts`. Those are the same
 * claims made to the same person on the web, and they have already drifted once.
 *
 * NEVER PUBLISH THE ALLOWANCE IN DOLLARS. Denominating it prices our own cost
 * structure and invites a "$19 for $10" comparison nobody else in this market
 * invites. Say what it buys.
 */

import { ATLARIX_CORE_CATEGORY_LABEL } from "./compass_product_copy";

/** `$1.23`, or `-$1.23`. Negative balances are real — see the refund note below. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  /**
   * GROUPED, because `toFixed(2)` alone rendered a comped account's balance as
   * `$1000000.67` — a number a human has to count digits on to read, and the owner
   * reported it as looking wrong. Grouping is the difference between "is that one
   * million or ten" and a figure you can read at a glance.
   *
   * `en-US` is pinned rather than using the ambient locale: this string is money
   * paired with a hard-coded `$`, and a locale that swaps the group and decimal
   * separators would render `$1.000.000,67` next to a dollar sign. The app is
   * translated, but the currency symbol here is not, so the number must not drift
   * away from it.
   *
   * Two fraction digits always — a balance of `$1,000,000.7` is not a balance.
   */
  const amount = (Math.abs(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${amount}`;
}

// ─── What the products are ───────────────────────────────────────────────────

/**
 * The one-line answer to "what does Pro get me", matching the website's
 * `PRO_SUMMARY` word for word.
 *
 * IT DID NOT MATCH. This still listed the app's feature surface — "unlimited
 * workspaces, the marketplaces, one-click connectors" — which every account now gets
 * for free, so it described Pro by naming things Free also has. It also said
 * "marketplaces" plural after the skills marketplace was deleted in v14.45, leaving
 * only MCP.
 *
 * Copy that states a commercial fact has one home, and this file's header says to
 * change both when one changes. Both now read identically.
 */
export const PRO_SUMMARY =
  "One subscription across all three surfaces — the desktop app, the Chrome extension and Atlarix Reviewer — with Atlarix Core included for everyday work, over one balance.";

/**
 * The sentence that replaces "Atlarix Core is pay-as-you-go on every plan".
 *
 * Every clause is load-bearing. Free genuinely can use every Core model — that
 * has always been true. What changed is that Pro arrives with inference already
 * paid for, so "both plans pay the same way" is now simply wrong.
 */
export const CORE_PAYMENT_SUMMARY =
  `${ATLARIX_CORE_CATEGORY_LABEL} runs on a prepaid credit balance, metered per use. ` +
  "Pro includes Core for everyday work and draws on your credit only beyond that. " +
  "With no credit, Atlarix Auto is still free. Your own API keys and local models are always free.";

// ─── The two moments worth a message ─────────────────────────────────────────

/**
 * The month's included usage has just run out, but purchased credit remains.
 *
 * This is the moment the balance changes character — from something that resets
 * to money the user paid — and it is the only reason the app tracks the two
 * halves separately at all. Deliberately not framed as a problem: nothing is
 * broken and nothing has stopped.
 */
export function allowanceUsedUpNudge(purchasedCents: number): {
  title: string;
  description: string;
} {
  return {
    title: `Your monthly ${ATLARIX_CORE_CATEGORY_LABEL} usage is used up`,
    description: `You're now using credit you topped up — ${formatCents(purchasedCents)} left.`,
  };
}

/** Running low on spendable balance, whatever it is made of. */
export function lowBalanceNudge(balanceCents: number): {
  title: string;
  description: string;
} {
  return {
    title: `${ATLARIX_CORE_CATEGORY_LABEL} credit is running low`,
    description: `${formatCents(balanceCents)} left — add credit to avoid interruptions.`,
  };
}

/**
 * Nothing left to spend: the proxy answered 402.
 *
 * NAMES NO TIER, on purpose. A 402 means the SPENDABLE total is zero, which is
 * both halves gone — so there is no useful distinction left to draw, and drawing
 * one here would tell a Free user about an allowance they never had. The route
 * out is the same for everyone.
 */
export const CORE_EXHAUSTED_MESSAGE =
  `Your ${ATLARIX_CORE_CATEGORY_LABEL} balance is used up. Top up in Settings to continue — ` +
  "or use your own API key or a local model, which are always free.";

/**
 * The same refusal, plus what it would take to succeed.
 *
 * The proxy has always sent `required_cents` on its 402 and the app has always thrown it
 * away, so a refusal could only ever say "you have run out" — true, and not actionable.
 * This is the whole reason refusing beats the output clamp it replaced (removed
 * 2026-09-09): a clamp shortened the reply silently, whereas this says the number.
 *
 * "AT LEAST", never "this turn costs" — and the distinction is not pedantic.
 * `required_cents` is the proxy's worst-case RESERVE: the whole prompt priced as
 * uncached, output priced to its ceiling, times the markup, and floored at the minimum
 * start balance when pricing is unknown. A real turn usually settles well under it. Say
 * "costs" and every user who tops up the stated figure and sees a smaller charge has
 * caught us overstating.
 *
 * APPENDS — it does not rewrite. `CORE_EXHAUSTED_MARKER` must survive verbatim, because
 * `ChatErrorBox` substring-matches it to decide whether the Top-up button exists, so
 * rewording the phrase silently deletes the button.
 */
export function coreExhaustedUserMessage(
  requiredCents?: number | null,
): string {
  const needs =
    typeof requiredCents === "number" &&
    Number.isFinite(requiredCents) &&
    requiredCents > 0
      ? ` This turn needs at least ${formatCents(requiredCents)} available.`
      : "";
  return `${CORE_EXHAUSTED_MESSAGE}${needs}`;
}

/**
 * A negative balance, which is a real state rather than a bug: a refund claws
 * back what was credited even when it has already been spent, so the wallet can
 * land below zero. Says so plainly, because "$-4.20" with no explanation reads
 * as a display fault.
 */
export const NEGATIVE_BALANCE_EXPLAINER =
  `A refund was applied, so your balance is negative. Top up to restore a positive balance ` +
  `before using ${ATLARIX_CORE_CATEGORY_LABEL}.`;

// ─── Labels for the usage bar ────────────────────────────────────────────────

/**
 * Two sub-numbers, NOT per product — identical to the web account page's card,
 * and for the reason its own docblock gives: `spend_from_wallet` deliberately
 * spills allowances across products, so "Reviewer allowance: $10" would not be a
 * statement about what reviews can consume. What IS true, and what the reader
 * needs, is which half expires.
 */
export const USAGE_LABELS = {
  included: "Included this month",
  includedHint: "Resets when your plan renews",
  purchased: "Your credit",
  purchasedHint: "Never expires",
} as const;

/**
 * A bar with no scale invites "is that a lot?". Measured on live data, app turns
 * cost 2–29 cents each, so the midpoint gives a defensible turn count. Stated as
 * turns rather than dollars — see the note at the top about not publishing the
 * allowance figure.
 */
const CENTS_PER_TURN_ESTIMATE = 5;

/**
 * Above this the estimate stops being an answer. A number in the tens of
 * thousands does not tell anyone "is that a lot?" — it just looks like a bug,
 * and comped or internal accounts genuinely carry balances this size.
 */
const TURNS_BEYOND_COUNTING = 2_000;

/**
 * How much of the month's included usage has gone, as a PERCENTAGE.
 *
 * A percentage and not "$3 of $10", which is what this file's own rule at the
 * top forbids — printing the allowance in dollars publishes our cost structure
 * and invites the "$19 for $10" comparison. The first version of the usage bar
 * did exactly that; a share of the whole says the same thing to the reader and
 * nothing at all to a competitor.
 *
 * `<1%` rather than `0%` once anything has been spent: rounding real usage down
 * to zero tells someone their metered account is not being metered.
 */
export function describeAllowanceUsed(
  usedCents: number,
  totalCents: number,
): string {
  if (totalCents <= 0) return "";
  const pct = (Math.max(0, usedCents) / totalCents) * 100;
  if (pct <= 0) return "0% used";
  if (pct < 1) return "<1% used";
  return `${Math.min(100, Math.round(pct))}% used`;
}

export function describeIncludedUsage(grantedCents: number): string {
  if (grantedCents <= 0) return "Used up for this month";
  const turns = Math.round(grantedCents / CENTS_PER_TURN_ESTIMATE / 10) * 10;
  if (turns > TURNS_BEYOND_COUNTING) return "More than you are likely to use";
  return turns >= 10
    ? `About ${turns} more turns of everyday work`
    : "Nearly used up for this month";
}

// ─── Core failure messages ───────────────────────────────────────────────────
//
// Moved here from `ipc/shared/compass_constants.ts`, which is a provider-config
// module that reads env vars and resolves models — copy living inside it meant
// every renderer that wanted a sentence imported the Core routing table too.

export const COMPASS_REACHABILITY_ERROR =
  "We're currently having trouble reaching Atlarix Core. Please retry or switch to another provider in Settings.";

/**
 * Shown when the proxy refuses a Core request with 403 `account_banned`.
 *
 * Neutral, with a route back, and it does NOT carry the reason — the reason lives
 * in `public.user_bans`, which no client can read. Says what still works, because
 * it is true: BYOK and local models are outside the ban's scope, and pretending
 * otherwise would be a claim the app cannot enforce offline.
 */
export function accountBannedUserMessage(): string {
  return (
    "This account can't access Atlarix Core. If you think this is a mistake, " +
    "contact support@atlarix.dev. Your own API keys and local models still work — " +
    "add one in Settings to keep going."
  );
}

// ─── The one upgrade line ────────────────────────────────────────────────────

/**
 * The single "how to get more" line, shown wherever a free user hits a wall:
 * the locked Core rows in the model picker, Auto's free limit, the low-balance
 * hint — and copied VERBATIM into the Chrome extension and the Reviewer's
 * out-of-credit comment (a test holds the extension's copy to this one).
 *
 * Two routes, both real: Pro (a monthly allowance that covers every surface)
 * and credit (pay only for what you use). There is no trial — the $1 signup
 * credit was removed on 2026-09-08 — so nothing here may promise one.
 */
export const UPGRADE_LINE =
  "Get more with Atlarix Pro — $19/month, includes Core usage across the app, the Chrome extension and Reviewer. Or add credit and pay only for what you use.";
export const UPGRADE_PRO_LABEL = "Upgrade to Pro";
/** Picker badges for Core rows, by account (see useAccountKind). */
export const CORE_BADGE = {
  free: "Free",
  included: "Included",
  credits: "Credits",
  locked: "Pro / Credits",
} as const;
export const ADD_CREDIT_LABEL = "Add credit";

/**
 * The paid surfaces' version of the upgrade line, for an account with no
 * balance: credit first, because most people meet it before they would start a
 * subscription, and it is what actually unblocks them today. Copied verbatim by
 * the Chrome extension (`packages/extension/src/core/upgrade-line.ts`), whose
 * side-panel agent is paid-only, so it never mentions a free route.
 */
export const CREDIT_FIRST_LINE =
  "Add credit from $10 and pay only for what you use, or get Atlarix Pro ($19/month), which includes Core usage across the app, the Chrome extension and Reviewer.";

/**
 * A reset moment as the user's own clock shows it — "3:00 AM" — rather than a
 * countdown or a UTC time. Exported for tests, which pin the zone.
 */
export function localResetTime(
  retryAfterSeconds: number,
  now: number = Date.now(),
  timeZone?: string,
): string {
  return new Date(now + retryAfterSeconds * 1000).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
}

/**
 * Atlarix Auto: today's free usage is all used (proxy 429 `free_usage_limit`).
 *
 * Says it plainly and says WHEN it comes back on the user's clock (the free
 * allowances reset at 00:00 UTC, a different hour everywhere), and nothing more:
 * no buttons, no upsell (owner, 2026-10-12: "just say daily usage is over, come
 * back tomorrow, and let it be"). Not an error the user caused, and not our
 * outage, so it is never reported to Sentry. Holds FREE_LIMIT_MARKER.
 */
export function freeUsageLimitUserMessage(
  retryAfterSeconds?: number | null,
  now: number = Date.now(),
  timeZone?: string,
): string {
  const when =
    typeof retryAfterSeconds === "number" && retryAfterSeconds > 0
      ? `it resets at ${localResetTime(retryAfterSeconds, now, timeZone)}`
      : "it resets at midnight UTC";
  return `Today's usage is over. Come back tomorrow (${when}).`;
}

export const USE_OWN_KEY_LABEL = "Use your own key";

/**
 * Atlarix Auto with no credit and no consent yet (proxy 402 `consent_required`).
 * Free Auto shares prompts with the providers that serve it, so it needs a
 * one-time OK; paying
 * needs none. Starts with AUTO_CONSENT_MARKER so ChatErrorBox can open the
 * notice.
 */
export function autoConsentRequiredUserMessage(): string {
  return `Atlarix Auto is free once you OK sharing its prompts with the AI providers that serve it, to improve their models. Review and accept to keep going. ${UPGRADE_LINE}`;
}

/** Atlarix Auto's free models are all busy right now (proxy 503 `free_busy`). */
export function freeBusyUserMessage(): string {
  return "Atlarix Auto's free models are busy right now. Try again in a moment, or pick a Core model above.";
}

/**
 * Shown when Atlarix Core fails on OUR side (the proxy returns 503 core_unavailable
 * because a managed provider key is out of credit / rate-limited / down). Neutral
 * by design — the user is never told "we ran out of money"; the owner is alerted
 * separately by the proxy.
 */
export function coreUnavailableUserMessage(): string {
  return "This Atlarix Core model is temporarily unavailable. Atlarix has been informed and is working on it — we apologise for the inconvenience. In the meantime, pick another Core model above, or add your own API key in Settings.";
}

/**
 * The proxy rejected our bearer token (401/403). Core authenticates as the user with
 * their Supabase JWT, so this is an expired or invalidated session — not an outage.
 *
 * Split out of the reachability catch-all because the two need OPPOSITE actions:
 * "retry or switch provider" is advice that cannot work here, and a user following
 * it just retries into the same wall.
 */
export function compassAuthExpiredUserMessage(): string {
  return "Your Atlarix session has expired, so Core couldn't authorize this request. Sign in again from Settings and resend — your BYOK models are unaffected.";
}

/**
 * A request-level rejection the proxy passed through untouched (400/422): context
 * length exceeded, an unsupported parameter, a malformed tool schema.
 *
 * These used to render as "trouble reaching Atlarix Core", which hid the one piece
 * of information that makes them fixable. The provider's own text is included —
 * truncated, since some vendors echo a large chunk of the request back.
 */
export function compassBadRequestUserMessage(detail?: string): string {
  const trimmed = (detail ?? "").trim();
  // Prefer the vendor's `error.message` when the body is the usual JSON envelope;
  // the raw envelope is noise to a user.
  let reason = trimmed;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: { message?: unknown } };
      if (typeof parsed?.error?.message === "string")
        reason = parsed.error.message;
    } catch {
      /* not JSON after all — fall back to the raw text */
    }
  }
  const suffix = reason ? ` The model reported: "${reason.slice(0, 300)}"` : "";
  return `Atlarix Core rejected this request.${suffix} This is usually a problem with the request itself rather than an outage — try again, and if it repeats, switch Core model or use your own API key in Settings.`;
}

// ─── Markers the renderer matches on ─────────────────────────────────────────
//
// THE TRAP THESE FIX. `ChatErrorBox` decides which buttons to show by searching
// the streamed error text for a substring, and it used to declare those
// substrings itself. So rewording a message here silently removed the "Top up
// credit" button from the error that most needs it — no test failed, nothing
// logged, the button was simply gone.
//
// Derived from the messages rather than typed out, so the coupling is mechanical
// and cannot rot. A test asserts each marker is genuinely present in the message
// it claims to match, which is the part a derivation cannot guarantee on its own
// once someone edits either side.

export const CORE_EXHAUSTED_MARKER = "balance is used up";
export const FREE_LIMIT_MARKER = "Today's usage is over";
export const AUTO_CONSENT_MARKER = "Atlarix Auto is free once you OK";

/** Free Auto's consent, word for word, wherever a surface asks it (CLI dialog, ACP/VS Code card). */
export const AUTO_CONSENT_TERMS = [
  "It's free because your prompts are shared with the AI providers that serve it (OpenAI, OpenRouter and Requesty), who may use them to improve their models.",
  "Don't use it for code you can't share. Pro, credit and your own keys stay private.",
] as const;
export const CORE_REACHABILITY_MARKER = "trouble reaching Atlarix Core";
