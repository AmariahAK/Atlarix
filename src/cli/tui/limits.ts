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
  AUTO_CONSENT_MARKER,
  CORE_EXHAUSTED_MARKER,
  CORE_REACHABILITY_MARKER,
  FREE_LIMIT_MARKER,
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
  const text = raw.startsWith(AI_STREAMING_ERROR_MESSAGE_PREFIX) ? raw.slice(AI_STREAMING_ERROR_MESSAGE_PREFIX.length) : raw;
  const [first, rest] = split(text);
  const said = /\(It said: "(.*)"\)/.exec(text)?.[1];
  if (text.includes(FREE_LIMIT_MARKER)) {
    return { tone: "warn", title: first, actions: "/billing get Pro or add credit · /model switch to your own key" };
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
  if (text.includes(AUTO_CONSENT_MARKER)) {
    return { tone: "warn", title: "Atlarix Auto needs your OK first", detail: first, actions: "send again to review it · /model pick another" };
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
  if (text.includes(CORE_REACHABILITY_MARKER) || /temporarily unavailable|busy right now/.test(text)) {
    return { tone: "warn", title: first, detail: rest || undefined, actions: "↑ enter send it again · /model pick another" };
  }
  return { tone: "error", title: text };
}
