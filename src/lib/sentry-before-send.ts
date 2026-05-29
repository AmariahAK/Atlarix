import type { ErrorEvent, EventHint } from "@sentry/core";
import { isPlanLimitError } from "@/lib/plan-limit-error";
import { sentryMessageMatchesIgnoredPattern } from "@/lib/sentry-ignore-patterns";
import { normalizeSentryErrorText } from "@/lib/sentry-decode-message";

/**
 * Drop expected non-errors so Sentry alerts stay actionable.
 * - Auth required, plan/workspace limits, missing TextMate grammars, bundled TS fallback
 */
export function sentryBeforeSendDropExpected(
  event: ErrorEvent,
  hint?: EventHint,
): ErrorEvent | null {
  const parts: string[] = [];
  if (event.message) parts.push(normalizeSentryErrorText(event.message));
  const values = event.exception?.values;
  if (values) {
    for (const ex of values) {
      if (ex.value) parts.push(normalizeSentryErrorText(ex.value));
      if (ex.type) parts.push(ex.type);
    }
  }
  const original = hint?.originalException;
  if (isPlanLimitError(original)) return null;
  if (original instanceof Error) {
    parts.push(original.message, original.name);
  } else if (typeof original === "string") {
    parts.push(original);
  }
  const combined = parts.join("\n");

  if (sentryMessageMatchesIgnoredPattern(combined)) {
    return null;
  }

  return event;
}
