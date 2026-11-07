/**
 * A turn that failed, said the way the app's error box says it, plus what to do
 * about it here. Usage limits and money get a title and their way out (Claude
 * Code's "Usage limit reached · resets 12:20pm"); anything else stays as it was.
 *
 * Matched on the markers billing_copy.ts and texts.ts export, never on copy
 * typed out again here, so rewording a message cannot silently drop its hint.
 * Pure (src/__tests__/cli-limits.test.ts).
 */
import {
  CORE_EXHAUSTED_MARKER,
  CORE_NEVER_FUNDED_MARKER,
  CORE_RATE_LIMIT_MARKER,
  CORE_REACHABILITY_MARKER,
  FREE_BUSY_MARKER,
  FREE_LIMIT_MARKER,
  PRO_ALLOWANCE_MARKER,
  ZENITH_OFFER_LINE,
} from "@/shared/billing_copy";
import { AI_STREAMING_ERROR_MESSAGE_PREFIX, BYOK_CREDIT_MARKER, BYOK_KEY_MARKER, BYOK_RATE_MARKER } from "@/shared/texts";

export interface ErrorNotice {
  tone: "warn" | "error";
  title: string;
  detail?: string;
  /** The way out, as "/billing get Pro or add credit · /model switch model". */
  actions?: string;
}

/** The first sentence, and the rest. */
function split(text: string): [string, string] {
  // A sentence ends at ". " (not the "." inside "$1.25").
  const at = text.search(/[.!?](\s|$)/);
  if (at < 0) return [text, ""];
  return [text.slice(0, at), text.slice(at + 1).trim()];
}

export function errorNotice(raw: string): ErrorNotice {
  // Auto's whole ladder failed and Zenith is offered (once per chat): the
  // notice for the failure itself, plus the way to Zenith.
  if (raw.includes(ZENITH_OFFER_LINE)) {
    const base = errorNotice(raw.replace(` ${ZENITH_OFFER_LINE}`, "").replace(ZENITH_OFFER_LINE, ""));
    return {
      ...base,
      detail: [base.detail, "Atlarix Zenith uses frontier models at a higher cost, and may get further."].filter(Boolean).join(" "),
      actions: [base.actions, "/model Atlarix Zenith"].filter(Boolean).join(" · "),
    };
  }
  const text = raw.startsWith(AI_STREAMING_ERROR_MESSAGE_PREFIX) ? raw.slice(AI_STREAMING_ERROR_MESSAGE_PREFIX.length) : raw;
  const [first, rest] = split(text);
  const said = /\(It said: "(.*)"\)/.exec(text)?.[1];
  // Free Auto used up for today: when it resets, and the ways to keep going now.
  if (text.includes(FREE_LIMIT_MARKER)) {
    return {
      tone: "warn",
      title: FREE_LIMIT_MARKER,
      detail: /Resets (?:in|at) [^.]+\./.exec(text)?.[0],
      actions: "/billing Pro or credit · /model your own key",
    };
  }
  if (text.includes(FREE_BUSY_MARKER)) {
    return {
      tone: "warn",
      title: FREE_BUSY_MARKER,
      actions: "↑ enter send it again · /billing Pro or credit · /model your own key",
    };
  }
  // A $0 account that never added credit: Core is paid, Auto is the free way.
  if (text.includes(CORE_NEVER_FUNDED_MARKER)) {
    const needs = /This model needs at least .+? of credit\./.exec(text)?.[0];
    return {
      tone: "warn",
      title: "Atlarix Core runs on credit",
      detail: ["Add credit or get Pro to use it, or switch to Atlarix Auto (free).", needs].filter(Boolean).join(" "),
      actions: "/billing add credit or get Pro · /model Atlarix Auto (free) or your own key",
    };
  }
  // Pro with the month's allowance spent: never tell a Pro user to get Pro.
  if (text.includes(PRO_ALLOWANCE_MARKER)) {
    return { tone: "warn", title: first, detail: /It resets on [^.]+\./.exec(text)?.[0], actions: "/billing add credit · /model your own key" };
  }
  if (text.includes(CORE_RATE_LIMIT_MARKER)) {
    return { tone: "warn", title: first, detail: rest || undefined, actions: "↑ enter send it again · /model pick another" };
  }
  if (text.includes(CORE_EXHAUSTED_MARKER)) {
    const needs = /This turn needs at least .+? available\./.exec(text)?.[0];
    return {
      tone: "warn",
      title: first,
      detail: needs,
      actions: "/billing add credit or get Pro · /model your own key, or Atlarix Auto (free)",
    };
  }
  if (text.includes(BYOK_CREDIT_MARKER)) {
    return {
      tone: "warn",
      title: first.replace(/, so it refused this request$/, ""),
      detail: said ? `It said: ${said}` : undefined,
      actions: "add credit on the provider's site · /model switch (Atlarix Auto is free)",
    };
  }
  if (text.includes(BYOK_RATE_MARKER)) {
    return { tone: "warn", title: first, detail: said ? `It said: ${said}` : undefined, actions: "↑ enter send it again · /model switch" };
  }
  if (text.includes(BYOK_KEY_MARKER)) {
    return { tone: "error", title: first, detail: said ? `It said: ${said}` : undefined, actions: "/connect replace the key · /model switch" };
  }
  if (text.includes(CORE_REACHABILITY_MARKER) || /temporarily unavailable/.test(text)) {
    return { tone: "warn", title: first, detail: rest || undefined, actions: "↑ enter send it again · /model pick another" };
  }
  return { tone: "error", title: text };
}
