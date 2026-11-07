export const AI_STREAMING_ERROR_MESSAGE_PREFIX =
  "Sorry, there was an error from the AI: ";

/** Shown when the model finishes without text (AI SDK no-output / empty stream). */
export const AI_STREAM_EMPTY_RESPONSE_FALLBACK =
  "Something went wrong — please try again.";

/** User message rejected by local profanity filter (bad-words list — not full moderation). */
export const SAFETY_FILTER_BLOCKED_MESSAGE =
  "Message blocked by safety filter.";

/** Shown when the selected model fails (no automatic failover to another model). */
// ─── Your own key ran into its provider's limits ─────────────────────────────
//
// A BYOK model's error used to read "This model failed (<the provider's JSON>)"
// whatever had happened, so "your account is out of credit" and "slow down"
// looked the same as a broken request. These three are told apart by the
// words and codes every provider uses for them (OpenAI's insufficient_quota,
// Anthropic's "credit balance is too low", DeepSeek's "Insufficient Balance",
// 402 / 429 / 401), never by which provider it is. The markers are what the
// terminal app matches to offer the way out.

export const BYOK_CREDIT_MARKER = "is out of credit or over its quota";
export const BYOK_RATE_MARKER = "is rate-limiting your key";
export const BYOK_KEY_MARKER = "rejected your API key";

const CREDIT_RE =
  /insufficient[_ ]?(quota|balance|credits?|funds)|credit balance is too low|exceeded your current quota|out of credits?|payment required|billing (hard )?limit|\b402\b|quota[_ ]exceeded|no credits/i;
const RATE_RE =
  /rate[_ -]?limit|too many requests|\b429\b|overloaded|resource[_ ]exhausted/i;
const KEY_RE =
  /invalid[_ ]?(api[_ ]?)?key|incorrect api key|api key not valid|unauthori[sz]ed|authentication[_ ]?(error|failed)|\b401\b|permission[_ ]denied/i;

/** What the provider said, without its JSON envelope. */
function providerSaid(reason: string): string {
  const m = /"message"\s*:\s*"([^"]{1,300})"/.exec(reason);
  const text = (m?.[1] ?? reason)
    .replace(/\s+/g, " ")
    // A masked key ("sk-proj-****…****UcIA") is a wall of asterisks that overflows
    // the card; its two ends say which key it was (QA #32).
    .replace(
      /(\S{0,12}?)\*{4,}(\S{0,8})/g,
      (_m, head: string, tail: string) => `${head}…${tail}`,
    )
    .trim();
  if (text.length <= 200) return text;
  // Cut at a sentence, else a word, never mid-word ("…UcIA. You ca").
  const cut = text.slice(0, 200);
  const sentence = cut.lastIndexOf(". ");
  if (sentence > 80) return cut.slice(0, sentence + 1);
  const word = cut.lastIndexOf(" ");
  return `${cut.slice(0, word > 80 ? word : 200)}…`;
}

/**
 * Which of the three a BYOK failure is, from its words and codes, or null.
 * Credit before rate: a quota error often arrives as a 429. The one source for
 * the message below and for turn telemetry's `quota` / `auth` / `rate_limit`.
 */
export function byokLimitKind(reason: string): "credit" | "key" | "rate" | null {
  if (CREDIT_RE.test(reason)) return "credit";
  if (KEY_RE.test(reason)) return "key";
  if (RATE_RE.test(reason)) return "rate";
  return null;
}

/**
 * A BYOK failure worded by what happened, or null when it is none of these.
 * `status`, when the words don't say: a 429 is a rate limit whatever its body.
 */
export function byokLimitUserMessage(
  reason: string,
  providerId?: string,
  status?: number,
): string | null {
  const who = providerId
    ? `Your ${providerId} account`
    : "Your provider account";
  const said = providerSaid(reason);
  switch (byokLimitKind(reason) ?? (status === 429 ? "rate" : null)) {
    case "credit":
      return `${who} ${BYOK_CREDIT_MARKER}, so it refused this request. Add credit on the provider's billing page, or switch model: Atlarix Auto is free. (It said: "${said}")`;
    case "key":
      return `${providerId ?? "The provider"} ${BYOK_KEY_MARKER}. Check the key (it may have been revoked or mistyped), or switch model. (It said: "${said}")`;
    case "rate":
      return `${providerId ?? "The provider"} ${BYOK_RATE_MARKER} right now. Wait a moment and resend, or switch model. (It said: "${said}")`;
    default:
      return null;
  }
}

/**
 * A turn Atlarix itself declined, with a message that already says what to do
 * ("/summarize comes from acme-demo-silk, which is off. Turn it on in /silks.").
 * Shown as it is: wrapped as "This model failed … Try again, or switch model"
 * it gave the wrong advice (QA 1 A8), since no model was asked.
 */
export class UserFacingRefusal extends Error {
  override name = "UserFacingRefusal";
  /** Which rule refused: the turn ends as a "rule" gate with this as its errorKind. */
  constructor(
    message: string,
    readonly rule: RefusalRule,
  ) {
    super(message);
  }
}

/** A silk off, scoped away from this folder, or broken (incl. its mod); an edict's stop. */
export type RefusalRule =
  | "silk_off"
  | "silk_scope"
  | "silk_broken"
  | "edict_stop";

/** A Core pick a newer Atlarix wrote into the shared settings (compass_constants). */
export const CORE_TIER_NEWER_BUILD =
  "That Atlarix Core model comes from a newer version of Atlarix. Update this one, or pick another model.";

/**
 * A model's request failed for some other reason. Said in a sentence, without
 * the provider's JSON or line breaks, and with the likely fix where the words
 * say what happened: the model id or the address (QA: "(Not Found\n\nDetails:
 * 404 page not found)", raw `{"error":{…}}`, and "chat settings", a desktop-only
 * place, in the CLI and editor).
 */
export function modelFailureUserMessage(reason: string): string {
  // Already says what to do, and trying again can't help.
  if (reason.includes(CORE_TIER_NEWER_BUILD)) return CORE_TIER_NEWER_BUILD;
  const said =
    providerSaid(reason.replace(/\bDetails:\s*/g, "")) || "the request failed";
  if (
    /model ['"`]?[^'"`\s]+['"`]? not found|model_not_found|no such model|unknown model/i.test(
      reason,
    )
  ) {
    return `The provider doesn't have that model. Check the model's id, or switch model. (It said: "${said}")`;
  }
  if (/\b404\b|not found/i.test(reason)) {
    return `The provider's address answered "not found". Check its base URL (most end in /v1), or switch model. (It said: "${said}")`;
  }
  if (
    /cannot connect|unable to connect|econnrefused|fetch failed|connection refused|enotfound/i.test(
      reason,
    )
  ) {
    return `Couldn't reach the provider. Is its server running, and is the address right? Or switch model. (It said: "${said}")`;
  }
  return `This model failed: "${said}". Try again, or switch model.`;
}
