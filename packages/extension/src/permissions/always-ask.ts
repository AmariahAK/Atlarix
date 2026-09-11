/**
 * The always-ask set: actions that stop for the user even on a site they have
 * already granted.
 *
 * WHY THIS SHAPE. Both Claude in Chrome and OpenAI's extension gate on first
 * contact with a new domain, and both keep a smaller set that a site grant does
 * NOT unlock. Atlarix follows that, with one deliberate difference: those
 * products *prohibit* several of these outright, and we ask instead — "delete
 * these Airtable rows" is a legitimate thing to want done, and a harness that
 * refuses it is one people route around.
 *
 * IT IS DETERMINISTIC ON PURPOSE. Claude's Auto mode classifies each action with
 * a model and says so in its own docs — it "consumes more usage". For a
 * Core-metered product that is a per-action inference bill on the user's wallet,
 * paid on every click forever. Everything below is attribute and string
 * inspection, costs nothing, and is testable.
 *
 * PRECISION MATTERS AS MUCH AS RECALL. A gate that fires on every button
 * containing the word "delete" trains the user to click through it, which is
 * strictly worse than not having it. So:
 *
 *   - **Structural signals are authoritative.** `input[type=password]`,
 *     `autocomplete="cc-number"` and a real download are unambiguous, and they
 *     carry the categories that matter most.
 *   - **Text signals demand a PHRASE, never a word.** "delete" does not fire;
 *     "delete account" and "permanently delete" do. The bare word appears on
 *     every list row on the web.
 *
 * What is NOT here, because it is not a classifier's job: acting on instructions
 * found in page content. That is a hard never, enforced where page text enters
 * the prompt — a page that can talk the model into calling `click` has already
 * won by the time this function sees the call.
 */

/** Every action the agent can take on a page. */
export type AgentAction =
  | "click"
  | "fill"
  | "key"
  | "hover"
  | "scroll"
  | "navigate"
  | "download";

/** What the agent is about to act on, read from the resolved element. */
export interface ActionTarget {
  /** Lowercased tag name, e.g. "input". */
  tag?: string;
  /** `type` attribute for inputs. */
  type?: string;
  /** `autocomplete` attribute — the single most reliable signal here. */
  autocomplete?: string;
  name?: string;
  id?: string;
  ariaLabel?: string;
  placeholder?: string;
  /** Visible text or accessible name. */
  text?: string;
  /**
   * `autocomplete` values of the OTHER fields in this element's form. A submit
   * button carries no payment hint of its own; the form around it does.
   */
  formAutocomplete?: readonly string[];
}

export interface ActionContext {
  action: AgentAction;
  /** The page's URL. Used for the agent's own settings pages. */
  url?: string;
  target?: ActionTarget;
  /**
   * For `fill`: the value about to be entered. Inspected for SHAPE only (a
   * card-shaped number), never echoed into the verdict — see `reason` below.
   */
  value?: string | number | boolean;
}

export type AlwaysAskCategory =
  | "credentials"
  | "payment"
  | "destructive"
  | "download"
  | "agent_settings";

export interface AlwaysAskVerdict {
  ask: boolean;
  category?: AlwaysAskCategory;
  /**
   * Shown to the user. MUST NOT contain the value being typed — this string is
   * rendered, and may be logged, on the path where that value is a password.
   */
  reason?: string;
}

const ALLOW: AlwaysAskVerdict = { ask: false };

/**
 * `autocomplete` tokens that mean a credential.
 * https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill
 */
const CREDENTIAL_AUTOCOMPLETE = new Set([
  "current-password",
  "new-password",
  "one-time-code",
]);

/** `autocomplete` tokens that mean payment instrument data. */
const PAYMENT_AUTOCOMPLETE = new Set([
  "cc-number",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-csc",
  "cc-type",
  "cc-name",
  "cc-given-name",
  "cc-family-name",
  "cc-additional-name",
]);

/**
 * Field-name fragments for credentials that carry no `autocomplete` — which is
 * most of the web. Matched against name/id/aria-label/placeholder, never text.
 */
const CREDENTIAL_NAME_HINTS = [
  "password",
  "passwd",
  "passcode",
  "otp",
  "one-time",
  "onetime",
  "2fa",
  "mfa",
  "totp",
  "verification code",
  "security code",
  "ssn",
  "social security",
];

const PAYMENT_NAME_HINTS = [
  "card number",
  "cardnumber",
  "creditcard",
  "credit card",
  "debit card",
  "cvc",
  "cvv",
  "card security",
  "iban",
  "account number",
  "routing number",
  "sort code",
];

/**
 * Payment PHRASES on a control. Each is a phrase, not a word: "pay" alone
 * matches "payment history" and "paypal login", which are reads.
 */
const PAYMENT_PHRASES = [
  "place order",
  "complete purchase",
  "confirm purchase",
  "confirm payment",
  "confirm and pay",
  "pay now",
  "pay $",
  "buy now",
  "checkout",
  "check out",
  "proceed to payment",
  "submit payment",
  "start subscription",
  "subscribe and pay",
  "donate",
  "send money",
  "transfer funds",
  "place trade",
  "confirm order",
];

/**
 * Destructive PHRASES. "delete" and "remove" are deliberately absent: they are
 * on every row of every list, and firing there is how a gate gets ignored.
 */
const DESTRUCTIVE_PHRASES = [
  "delete account",
  "close account",
  "deactivate account",
  "delete permanently",
  "permanently delete",
  "delete forever",
  "delete everything",
  "delete all",
  "remove everything",
  "erase all",
  "wipe",
  "delete repository",
  "delete workspace",
  "delete organization",
  "delete project",
  "delete database",
  "drop database",
  "cancel subscription",
  "terminate",
  "revoke all",
];

/** Lowercase and collapse whitespace. No `\w` — it is ASCII-only and would
 *  quietly mangle every non-Latin script (see the sanitiser trap). */
function norm(v: unknown): string {
  return typeof v === "string"
    ? v.toLowerCase().replace(/\s+/g, " ").trim()
    : "";
}

/** The element's own identifying attributes, as one searchable string. */
function fieldIdentity(t: ActionTarget): string {
  return [t.name, t.id, t.ariaLabel, t.placeholder].map(norm).join(" ");
}

function autocompleteTokens(value: string | undefined): string[] {
  // The attribute is a space-separated token list ("section-a shipping cc-number").
  return norm(value).split(" ").filter(Boolean);
}

function hasAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/** Luhn check — the last line of defence for an unlabelled payment field. */
function looksLikeCardNumber(value: string): boolean {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^[0-9]{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * A page that can change what the agent is allowed to do. Includes the
 * extension's own pages and the browser's settings surfaces — an agent that can
 * silently widen its own grants has no grants.
 */
function isAgentSettingsUrl(url: string | undefined): boolean {
  const u = norm(url);
  if (!u) return false;
  return (
    u.startsWith("chrome-extension://") ||
    u.startsWith("chrome://") ||
    u.startsWith("edge://") ||
    u.startsWith("brave://") ||
    u.startsWith("about:")
  );
}

/**
 * Decide whether this action stops for the user regardless of any site grant.
 *
 * Pure: same inputs, same verdict, no I/O, no model call.
 */
export function classifyAction(ctx: ActionContext): AlwaysAskVerdict {
  // A download leaves the browser and lands on the user's disk. Structural.
  if (ctx.action === "download") {
    return {
      ask: true,
      category: "download",
      reason: "This will save a file to your computer.",
    };
  }

  // Reads never ask. Scrolling and hovering change nothing, and gating
  // navigation would fire on every page the agent opens.
  if (ctx.action === "hover" || ctx.action === "scroll") return ALLOW;

  if (isAgentSettingsUrl(ctx.url)) {
    return {
      ask: true,
      category: "agent_settings",
      reason:
        "This page can change Atlarix's own permissions or your browser settings.",
    };
  }

  if (ctx.action === "navigate") return ALLOW;

  const t = ctx.target;
  if (!t) return ALLOW;

  const tokens = autocompleteTokens(t.autocomplete);
  const identity = fieldIdentity(t);
  const label = norm(t.text);

  // ── Credentials ────────────────────────────────────────────────────────────
  // Entering one is what matters; clicking a password field is not a secret.
  if (ctx.action === "fill" || ctx.action === "key") {
    if (
      t.type === "password" ||
      tokens.some((tok) => CREDENTIAL_AUTOCOMPLETE.has(tok)) ||
      hasAny(identity, CREDENTIAL_NAME_HINTS)
    ) {
      return {
        ask: true,
        category: "credentials",
        // Deliberately says nothing about the value.
        reason: "This enters a password or security code into the page.",
      };
    }
  }

  // ── Payment ────────────────────────────────────────────────────────────────
  const paymentField =
    tokens.some((tok) => PAYMENT_AUTOCOMPLETE.has(tok)) ||
    hasAny(identity, PAYMENT_NAME_HINTS);
  if ((ctx.action === "fill" || ctx.action === "key") && paymentField) {
    return {
      ask: true,
      category: "payment",
      reason: "This enters payment card details into the page.",
    };
  }
  // Unlabelled payment field: the value itself is a valid card number.
  if (
    ctx.action === "fill" &&
    typeof ctx.value === "string" &&
    looksLikeCardNumber(ctx.value)
  ) {
    return {
      ask: true,
      category: "payment",
      reason: "The value being entered looks like a payment card number.",
    };
  }
  if (ctx.action === "click") {
    const formTokens = (t.formAutocomplete ?? []).map((v) => norm(v));
    const inPaymentForm = formTokens.some((tok) =>
      PAYMENT_AUTOCOMPLETE.has(tok),
    );
    if (inPaymentForm || hasAny(label, PAYMENT_PHRASES)) {
      return {
        ask: true,
        category: "payment",
        reason: "This looks like it completes a purchase or moves money.",
      };
    }
    if (hasAny(label, DESTRUCTIVE_PHRASES)) {
      return {
        ask: true,
        category: "destructive",
        reason: "This looks like it deletes something permanently.",
      };
    }
  }

  return ALLOW;
}

/** Categories a site grant can never unlock, for the settings UI to list. */
export const ALWAYS_ASK_CATEGORIES: readonly AlwaysAskCategory[] = [
  "credentials",
  "payment",
  "destructive",
  "download",
  "agent_settings",
];
